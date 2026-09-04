/**
 * Regression tests for the hardening fixes:
 *   - acquireLock never reaps an existing lock from a waiter.
 *   - listAllTasks skips malformed (non-UUID) task filenames.
 *   - handleStatusEvent re-drives delegate/recurse/signoff/reduce on a
 *     within-tolerance member error so the run resolves instead of stalling
 *     to the wall-clock timeout.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, utimesSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { AsyncMutex, withLock } from "../src/state/locks.js"
import { createTask, listAllTasks, updateTask } from "../src/state/tasks.js"
import { handleStatusEvent } from "../src/orchestration/lifecycle/status.js"
import { saveTeamState, loadTeamState } from "../src/state/store.js"
import { indexMember } from "../src/state/resolve.js"
import { resumeDispatch } from "../src/orchestration/lifecycle/resume.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"
import type { ActiveTask, MemberState } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import type { PluginContext } from "../src/core/context.js"

afterAll(cleanupTmpRoots)

// ---------------------------------------------------------------------------
// P2-1: waiters never reap existing locks (locks.ts)
// ---------------------------------------------------------------------------

describe("acquireLock: stale locks with dead PID are reaped", () => {
    test("stale lock held by a dead pid is reaped and acquired", async () => {
        const dir = tmpRoot("lock-dead")
        const lockPath = join(dir, "state.json.lock")
        writeFileSync(lockPath, "999999")
        const stale = new Date(Date.now() - 60_000)
        utimesSync(lockPath, stale, stale)

        let ran = false
        await withLock(lockPath, async () => {
            ran = true
        })
        expect(ran).toBe(true)
    })

    test("stale lock held by an ALIVE pid is NOT reaped (mutual exclusion preserved)", async () => {
        const dir = tmpRoot("lock-alive")
        const lockPath = join(dir, "state.json.lock")
        writeFileSync(lockPath, String(process.pid))
        const stale = new Date(Date.now() - 60_000)
        utimesSync(lockPath, stale, stale)

        let ran = false
        const pending = withLock(lockPath, async () => {
            ran = true
        })
        // Within a short window the alive holder's lock must still be in place
        // (i.e. acquireLock is polling, not stealing).
        await new Promise(r => setTimeout(r, 300))
        expect(ran).toBe(false)

        // Release the holder ourselves: once the lock vanishes, the pending
        // acquireLock proceeds and withLock resolves.
        unlinkSync(lockPath)
        await pending
        expect(ran).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// P2-3: listAllTasks skips malformed task filenames (tasks.ts)
// ---------------------------------------------------------------------------

describe("listAllTasks: tolerates malformed filenames", () => {
    test("a non-UUID .json file is skipped, not thrown", async () => {
        const teamDir = tmpRoot("tasks-malformed")
        // Seed one valid task so the directory + structure exist.
        await createTask(teamDir, { subject: "real", description: "d" })
        // Drop malformed filenames (a crash leftover or external artifact).
        // Without the TASK_ID_PATTERN skip, assertSafeSegment in taskPath
        // would throw and abort the entire listing.
        const tasksFolder = join(teamDir, "tasks")
        mkdirSync(tasksFolder, { recursive: true })
        writeFileSync(join(tasksFolder, "not-a-uuid.json"), "{}")
        writeFileSync(join(tasksFolder, "..json"), "{}")

        const tasks = await listAllTasks(teamDir)
        // Only the one valid task is returned; no throw.
        expect(tasks.length).toBe(1)
        expect(tasks[0].subject).toBe("real")
    })
})

// ---------------------------------------------------------------------------
// P0-1: handleStatusEvent re-drives delegate on a within-tolerance error
// ---------------------------------------------------------------------------

function makeDelegateTask(): ActiveTask {
    return {
        type: "delegate",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300_000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        signoffPolicy: "none",
        maxRetries: 0,
        maxErroredMembers: 1,
    } as ActiveTask
}

function makeTeamOnDisk(opts: {
    members: Array<Partial<MemberState> & Pick<MemberState, "name">>
    activeTask: ActiveTask
}): { team: Team; storageRoot: string; leadSessionId: string } {
    const storageRoot = tmpRoot("redrive")
    const leadSessionId = "ses_lead"
    const members: MemberState[] = opts.members.map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: true,
        turnCount: 0,
        sessionId: m.sessionId,
        retryingSince: m.retryingSince,
    }))
    const teamDir = join(storageRoot, leadSessionId, "teams", "test-team")
    const team = {
        version: 1,
        teamRunId: "test-run",
        teamName: "test-team",
        status: "busy",
        leadSessionId,
        members,
        bounds: {
            maxMembers: 8,
            maxParallelMembers: 4,
            maxMessagesPerRun: 100,
            maxWallClockMinutes: 30,
            maxMemberTurns: 50,
            maxTasks: 200,
            messagePayloadMaxBytes: 32768,
            messageUnreadMaxBytes: 1048576,
        },
        createdAt: 0,
        activeTask: opts.activeTask,
        mutex: new AsyncMutex(),
        directory: teamDir,
    } as unknown as Team
    return { team, storageRoot, leadSessionId }
}

describe("handleStatusEvent: re-drives delegate within-tolerance error (no stall)", () => {
    test("last-to-terminal errored member triggers delegate_complete, not a stall", async () => {
        const calls: Array<{ sessionId: string; text: string }> = []
        const { team, storageRoot, leadSessionId } = makeTeamOnDisk({
            members: [
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                // bob is mid-retry-escalation, past RETRY_ESCALATION_MS (60s).
                { name: "bob", sessionId: "ses_bob", status: "running", retryingSince: Date.now() - 61_000 },
            ],
            activeTask: makeDelegateTask(),
        })
        // Persist the team and index both members so resolveTeamMember finds bob.
        await saveTeamState(team)
        indexMember("ses_alice", "test-team", "alice", leadSessionId, storageRoot)
        indexMember("ses_bob", "test-team", "bob", leadSessionId, storageRoot)
        // All tasks completed -> the delegate tail should deliver delegate_complete.
        const t = await createTask(team.directory, { subject: "done", description: "d" })
        await updateTask(team.directory, t.id, { status: "completed" })

        const ctx: PluginContext = {
            storageRoot,
            directory: "/app",
            client: {
                session: {
                    status: async () => ({
                        data: { ses_bob: { type: "retry", message: "provider error" } },
                    }),
                    messages: async () => ({ data: [] }),
                    promptAsync: async (args: any) => {
                        calls.push({ sessionId: args.path.id, text: args.body.parts[0].text })
                        return { data: {} }
                    },
                },
            },
        } as unknown as PluginContext

        await handleStatusEvent(ctx, { properties: { sessionID: "ses_bob" }, type: "session.status" })

        // Assert on a freshly loaded team: handleStatusEvent's internal
        // loadTeamState returns a registered/disk object (not our `team`
        // reference), and it persists the mutation via saveTeamState.
        const reloaded = await loadTeamState(storageRoot, "test-team", leadSessionId)
        // bob is errored; alice survives (within tolerance 1). checkTermination
        // is a no-op, so the re-drive must fire handleDelegateIdle and deliver.
        expect(reloaded.members.find(m => m.name === "bob")!.status).toBe("errored")
        expect(reloaded.status).toBe("idle") // would stay "busy" (stalled) without the P0-1 fix
        expect(reloaded.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === leadSessionId)
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("delegate_complete")
    })
})

// ---------------------------------------------------------------------------
// resumeDispatch rejects unknown task.type (no silent fall-through)
// ---------------------------------------------------------------------------

describe("resumeDispatch: unknown task.type throws (no silent fall-through)", () => {
    test("a bogus task.type is rejected with an error, not silently ignored", async () => {
        // With no matching case, the default exhaustiveness guard must throw
        // instead of letting resumeDispatch return and the run stall.
        const ctx = { directory: "/app" } as unknown as PluginContext
        const team = { members: [], teamName: "test-team" } as unknown as Team
        const task = { type: "bogus" } as unknown as ActiveTask

        expect(resumeDispatch(ctx, team, task)).rejects.toThrow(
            /Unhandled task type: bogus/,
        )
    })
})

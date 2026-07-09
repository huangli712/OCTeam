import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { processIdle } from "../src/orchestration/idle.js"
import { handleParallelIdle } from "../src/orchestration/parallel.js"
import { runMemberOutputPath } from "../src/state/paths.js"
import type { ActiveTask, MemberState } from "../src/core/types.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { Team } from "../src/state/store.js"
import type { PluginContext } from "../src/core/context.js"
import { type DispatchCall } from "./helpers.js"

// --- fixtures (parallel execution path) ---


/**
 * Stub PluginContext. `messages` returns a single user+assistant turn whose
 * assistant text is `outputs[sessionId]` so processIdle Step 4 captures it.
 * `promptAsync` records each dispatch for assertion.
 */
function makeCtx(outputs: Record<string, string>, calls: DispatchCall[] = []): PluginContext {
    return {
        directory: "/app",
        client: {
            session: {
                messages: async ({ path }: { path: { id: string } }) => {
                    const text = outputs[path.id] ?? ""
                    return {
                        data: [
                            { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
                            ...(text
                                ? [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }]
                                : []),
                        ],
                    }
                },
                promptAsync: async (args: any) => {
                    calls.push({ sessionId: args.path.id, text: args.body.parts[0].text })
                    return { data: {} }
                },
            },
        },
    } as unknown as PluginContext
}

function makeParallelTask(opts: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        reducePolicy: "summarize",
        signoffPolicy: "none",
        ...opts,
    } as ActiveTask
}

function makeTeam(opts: {
    activeTask?: ActiveTask
    members?: Array<Partial<MemberState> & Pick<MemberState, "name">>
}): Team {
    const members: MemberState[] = (opts.members ?? []).map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: m.initialized ?? true,
        turnCount: m.turnCount ?? 0,
        sessionId: m.sessionId,
        agent: m.agent,
        isMaster: m.isMaster,
        error: m.error,
    }))
    return {
        version: 1,
        teamRunId: "test-run",
        teamName: "test-team",
        status: "busy",
        leadSessionId: "ses_lead",
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
        directory: mkdtempSync(join(tmpdir(), "octeam-par-")),
    } as unknown as Team
}

// --- barrier progression ---

describe("handleParallelIdle: barrier progression", () => {
    test("all participants idle -> barrier fires, delivers summary, clears task", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({}, calls)
        const task = makeParallelTask({ mode: "isolated", responses: { alice: "A", bob: "B" } })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                { name: "bob", sessionId: "ses_bob", status: "idle" },
            ],
        })

        await handleParallelIdle(ctx, team)

        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        // Summary delivered to the leader session.
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("parallel_isolated_complete")
    })

    test("one participant still running -> barrier waits (no delivery, task stays live)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({}, calls)
        const task = makeParallelTask({ mode: "isolated", responses: { alice: "A" } })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                // bob is still running -> the barrier predicate is not satisfied.
                { name: "bob", sessionId: "ses_bob", status: "running" },
            ],
        })

        await handleParallelIdle(ctx, team)

        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
        expect(calls.some(c => c.sessionId === "ses_lead")).toBe(false)
    })
})

// --- output capture (processIdle Step 4) ---

describe("parallel output capture (processIdle)", () => {
    test("a member's idle captures its output into responses[] AND runs/<runId>/<member>.md", async () => {
        const calls: DispatchCall[] = []
        const task = makeParallelTask({ mode: "isolated" })
        const runId = task.runId!
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "running" },
                // bob keeps the barrier open so the run does not clear before we assert.
                { name: "bob", sessionId: "ses_bob", status: "running" },
            ],
        })
        const ctx = makeCtx({ ses_alice: "alice produced this artifact" }, calls)

        await processIdle(ctx, team, team.members[0], "ses_alice")

        // In-memory truncated capture.
        expect(task.responses.alice).toContain("alice produced this artifact")
        // Full output persisted losslessly to the per-run member output file.
        const outPath = runMemberOutputPath(team.directory, runId, "alice")
        const content = await fs.readFile(outPath, "utf8")
        expect(content).toContain("alice produced this artifact")
        // The run is still live (bob never idled, so the barrier did not fire).
        expect(team.activeTask).toBeDefined()
    })
})

// --- failure isolation + reduce re-entry (parallel.ts:26-30, 37-38) ---
// These branches live inside handleParallelIdle's onBarrier callback.
// Reaching them via processIdle is impractical: checkTermination (Step 7)
// fail-fasts over-tolerance errored members before the barrier can fire on
// a later idle. Calling handleParallelIdle directly bypasses that gate so
// the onBarrier body itself is exercised.

describe("handleParallelIdle: onBarrier failure isolation", () => {
    test("all participants errored, tolerance 0 → fails with member_error (parallel.ts:26-30)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({}, calls)
        const task = makeParallelTask({ mode: "isolated", maxErroredMembers: 0 })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "errored", error: "crashed" },
                { name: "bob", sessionId: "ses_bob", status: "errored", error: "timeout" },
            ],
        })

        await handleParallelIdle(ctx, team)

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("member_error:alice:crashed")
    })

    test("errored over tolerance with survivors → fails (parallel.ts:26-30)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({}, calls)
        const task = makeParallelTask({ mode: "isolated", maxErroredMembers: 1 })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "errored", error: "a" },
                { name: "bob", sessionId: "ses_bob", status: "errored", error: "b" },
                { name: "carol", sessionId: "ses_carol", status: "idle" },
            ],
        })

        await handleParallelIdle(ctx, team)

        // 2 errored > tolerance 1 → fail even though carol survived.
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall!.text).toContain("member_error:")
    })

    test("within tolerance with survivors → partial delivery (not failure)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({}, calls)
        const task = makeParallelTask({
            mode: "isolated",
            maxErroredMembers: 1,
            responses: { alice: "A", bob: "errored output" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                { name: "bob", sessionId: "ses_bob", status: "errored", error: "boom" },
            ],
        })

        await handleParallelIdle(ctx, team)

        // 1 errored <= tolerance 1, survivors=1 → deliver partial success.
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall!.text).toContain("parallel_isolated_partial:1_errored")
    })
})

describe("handleParallelIdle: reduceStage re-entry fallback (parallel.ts:37-38)", () => {
    test("reduceStage still set at barrier → cleared, falls back to non-reduced delivery", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({}, calls)
        // reduceStage=true simulates: the reducer was dispatched but reached a
        // terminal state (errored) without idling through handleReduceIdle, so
        // reduceStage was never cleared. The barrier fallback clears it and
        // delivers the mappers' raw outputs instead of hanging.
        const task = makeParallelTask({
            mode: "isolated",
            reduceStage: true,
            reducerMember: "alice",
            reducePolicy: "summarize",
            responses: { alice: "ALICE_RAW", bob: "BOB_RAW" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                { name: "bob", sessionId: "ses_bob", status: "idle" },
            ],
        })

        await handleParallelIdle(ctx, team)

        // reduceStage was cleared (parallel.ts:38) and delivery proceeded
        // with a non-reduced reason.
        expect(task.reduceStage).toBe(false)
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        // Non-reduced delivery: the reason does NOT carry "reduced".
        expect(leaderCall!.text).toContain("parallel_isolated_complete")
        expect(leaderCall!.text).not.toContain("reduced")
    })
})

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { processIdle } from "../src/orchestration/handlers.js"
import { handleParallelIdle } from "../src/orchestration/parallel-consensus.js"
import { runMemberOutputPath } from "../src/state/paths.js"
import type { ActiveTask, MemberState } from "../src/core/types.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { Team } from "../src/state/store.js"
import type { PluginContext } from "../src/core/context.js"

// --- fixtures (parallel execution path) ---

/** A recorded promptAsync call: which session got which text. */
type DispatchCall = { sessionId: string; text: string }

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

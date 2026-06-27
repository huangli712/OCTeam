import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { processIdle } from "../src/orchestration/handlers.js"
import type { ActiveTask, MemberState, Stage } from "../src/core/types.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { Team } from "../src/state/store.js"
import type { PluginContext } from "../src/core/context.js"

// --- fixtures (loop execution path) ---

/** A recorded promptAsync call: which session got which text. */
type DispatchCall = { sessionId: string; text: string }

/**
 * Stub PluginContext. `messages` returns a single user+assistant turn whose
 * assistant text is `outputs[sessionId]` so processIdle Step 4 captures it
 * (the decider's <decision> block is read out of responses[]). `promptAsync`
 * records each dispatch for assertion.
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

function makeLoopTask(opts: Partial<ActiveTask> & { stages: Stage[] }): ActiveTask {
    return {
        type: "loop",
        startedAt: Date.now(),
        wallClockTimeoutMs: 900000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        currentRound: 1,
        maxRounds: 3,
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
        directory: mkdtempSync(join(tmpdir(), "octeam-loop-")),
    } as unknown as Team
}

const DONE = '<decision>{"decision":"done","rationale":"all checks pass","nextActions":[]}</decision>'
const CONTINUE = (next = "fix the failing test") =>
    `<decision>{"decision":"continue","rationale":"issues remain","nextActions":["${next}"]}</decision>`

// --- intra-round stage advance ---

describe("handleLoopIdle (via processIdle): stage progression", () => {
    test("a non-final stage completes -> advances to the next stage in the round", async () => {
        const calls: DispatchCall[] = []
        const task = makeLoopTask({
            stages: [
                { member: "alice", task: "write code", completed: false },
                { member: "bob", task: "decide", action: "read_only", completed: false },
            ],
            deciderMember: "bob",
            currentStageIndex: 0,
            currentRound: 1,
            maxRounds: 3,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ ses_alice: "code written" }, calls)

        await processIdle(ctx, team, team.members[0], "ses_alice")

        expect(task.stages[0].completed).toBe(true)
        expect(task.currentStageIndex).toBe(1)
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(true)
        expect(team.activeTask).toBeDefined()
    })
})

// --- decider decisions ---

describe("handleLoopIdle (via processIdle): decider termination", () => {
    test('decider emits "done" -> loop completes and idles', async () => {
        const calls: DispatchCall[] = []
        const task = makeLoopTask({
            stages: [
                { member: "alice", task: "write code", completed: true },
                { member: "bob", task: "decide", action: "read_only", completed: false },
            ],
            deciderMember: "bob",
            currentStageIndex: 1,
            currentRound: 1,
            maxRounds: 3,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ ses_bob: DONE }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("loop_complete:decider_done")
    })

    test('decider emits "continue" with rounds remaining -> starts the next round', async () => {
        const calls: DispatchCall[] = []
        const task = makeLoopTask({
            stages: [
                { member: "alice", task: "write code", completed: true },
                { member: "bob", task: "decide", action: "read_only", completed: false },
            ],
            deciderMember: "bob",
            currentStageIndex: 1,
            currentRound: 1,
            maxRounds: 3,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ ses_bob: CONTINUE("patch the regression") }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        // Next round: round incremented, stages reset, stage-0 member re-dispatched
        // with the decider's feedback injected.
        expect(task.currentRound).toBe(2)
        expect(task.currentStageIndex).toBe(0)
        expect(task.stages[0].completed).toBe(false)
        const aliceCall = calls.find(c => c.sessionId === "ses_alice")
        expect(aliceCall).toBeDefined()
        expect(aliceCall!.text).toContain("patch the regression")
        expect(team.activeTask).toBeDefined()
    })

    test('decider emits "continue" but max rounds reached -> fails the run', async () => {
        const calls: DispatchCall[] = []
        const task = makeLoopTask({
            stages: [
                { member: "alice", task: "write code", completed: true },
                { member: "bob", task: "decide", action: "read_only", completed: false },
            ],
            deciderMember: "bob",
            currentStageIndex: 1,
            currentRound: 3,
            maxRounds: 3,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ ses_bob: CONTINUE() }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("loop_complete:max_rounds")
    })

    test("final round but all read-only stages report no_issues -> succeeds (no_issues wins over max_rounds)", async () => {
        const calls: DispatchCall[] = []
        const task = makeLoopTask({
            stages: [
                { member: "alice", task: "write code", completed: true },
                { member: "bob", task: "decide", action: "read_only", completed: false },
            ],
            deciderMember: "bob",
            currentStageIndex: 1,
            currentRound: 3,
            maxRounds: 3,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        // The decider is a read-only stage, so for the no_issues path to trigger
        // every read-only stage (here only the decider) must report <no_issues/>.
        // The decider still emits a "continue" decision; without the ordering fix
        // this clean final round would be misreported as a max_rounds failure.
        const ctx = makeCtx({ ses_bob: `${CONTINUE()}\n<no_issues/>` }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("loop_complete:no_issues")
    })
})

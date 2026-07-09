import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { processIdle } from "../src/orchestration/idle.js"
import type { ActiveTask, MemberState, Stage } from "../src/core/types.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { Team } from "../src/state/store.js"
import type { PluginContext } from "../src/core/context.js"
import { type DispatchCall } from "./helpers.js"

// --- fixtures (loop execution path) ---


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
            app: {
                // logEvent fires on decision parse failure (loop.ts:37) and must
                // not throw — other tests never hit that path so this is inert.
                log: async () => ({}),
            },
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

// --- decision parse failure escalation (loop.ts:37-44) ---
// Covers the parseFailed branch: 1-2 consecutive failures continue the loop,
// the 3rd consecutive failure aborts with "loop_complete:decision_parse_failure".

describe("handleLoopIdle (via processIdle): decision parse failure escalation", () => {
    test("decider emits unparseable output (1st failure) → decisionParseFailures++ and loop continues", async () => {
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
            decisionParseFailures: 0,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        // Bob's output has NO <decision> tag → parseDecision returns parseFailed.
        const ctx = makeCtx({ ses_bob: "I am unable to decide at this time." }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        // Parse failure counted but run NOT aborted (1 < 3).
        expect(task.decisionParseFailures).toBe(1)
        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
        // Loop advanced to round 2 and re-dispatched stage 0 (alice).
        expect(task.currentRound).toBe(2)
        expect(task.currentStageIndex).toBe(0)
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(true)
    })

    test("3rd consecutive parse failure → run failed with 'loop_complete:decision_parse_failure'", async () => {
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
            decisionParseFailures: 2, // already at 2 — one more triggers the cap
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ ses_bob: "no decision tag here either" }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        // 3rd failure → fail-fast.
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("loop_complete:decision_parse_failure")
    })

    test("a successful parse resets the consecutive-failure counter to 0", async () => {
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
            decisionParseFailures: 2, // near the cap
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        // This time bob emits a valid "continue" decision → counter resets.
        const ctx = makeCtx({ ses_bob: CONTINUE() }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.decisionParseFailures).toBe(0)
        expect(team.status).toBe("busy")
        expect(task.currentRound).toBe(2)
    })
})

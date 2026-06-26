import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    getExpectedMember,
    handleArbitrateIdle,
    parseArbitrationDecision,
} from "../src/orchestration/handlers.js"
import { readRunEvents } from "../src/orchestration/runs.js"
import type { ActiveTask, MemberState } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { PluginContext } from "../src/core/context.js"

// --- fixtures ---

/** A recorded promptAsync call: which session got which text. */
type DispatchCall = { sessionId: string; text: string }

/**
 * Stub PluginContext: only ctx.client.session.promptAsync is exercised (by
 * dispatchToMember and deliverSummaryToLeader). Each call is recorded into
 * `calls` so tests can assert debate rounds, arbiter dispatch, and leader
 * delivery.
 */
function makeCtx(calls: DispatchCall[] = []): PluginContext {
    return {
        client: {
            session: {
                promptAsync: async (args: any) => {
                    calls.push({
                        sessionId: args.path.id,
                        text: args.body.parts[0].text,
                    })
                    return { data: {} }
                },
            },
        },
    } as unknown as PluginContext
}

/** Minimal valid arbitrate ActiveTask with sensible defaults. */
function makeArbitrateTask(opts: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "arbitrate",
        startedAt: 0,
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
        arbiterMember: "arbiter",
        disputants: ["alice", "bob"],
        arbitrationStage: false,
        maxRounds: 1,
        currentRound: 1,
        signoffPolicy: "none",
        task: "Should we ship on Friday?",
        ...opts,
    } as ActiveTask
}

/** Minimal busy Team wrapper with a real tmp directory for file IO. */
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
        directory: mkdtempSync(join(tmpdir(), "octeam-arb-")),
    } as unknown as Team
}

// --- parseArbitrationDecision (pure function) ---

describe("parseArbitrationDecision", () => {
    test("parses a ruling via the decision field", () => {
        const text = '<ruling>{"decision": "ship Friday", "rationale": "risk is low"}</ruling>'
        const result = parseArbitrationDecision(text)
        expect(result).toEqual({ ruling: "ship Friday", rationale: "risk is low" })
    })

    test("parses a ruling via the ruling alias", () => {
        const text = '<ruling>{"ruling": "delay to Monday", "rationale": "safety"}</ruling>'
        expect(parseArbitrationDecision(text).ruling).toBe("delay to Monday")
    })

    test("parses bilingual <裁决> tag", () => {
        const text = '<裁决>{"decision": "周五发布", "rationale": "中文理由"}</裁决>'
        const result = parseArbitrationDecision(text)
        expect(result).toEqual({ ruling: "周五发布", rationale: "中文理由" })
    })

    test("returns parseFailed when no tag is present", () => {
        const result = parseArbitrationDecision("just regular output, no ruling tag")
        expect(result.parseFailed).toBe(true)
        expect(result.ruling).toBe("")
    })

    test("returns parseFailed for malformed JSON inside tag", () => {
        expect(parseArbitrationDecision("<ruling>not valid json</ruling>").parseFailed).toBe(true)
    })

    test("returns parseFailed when decision value is empty string", () => {
        expect(parseArbitrationDecision('<ruling>{"decision": ""}</ruling>').parseFailed).toBe(true)
    })

    test("returns parseFailed when neither decision nor ruling is present", () => {
        expect(parseArbitrationDecision('<ruling>{"rationale": "no decision"}</ruling>').parseFailed).toBe(true)
    })

    test("returns parseFailed when decision is a non-string value", () => {
        expect(parseArbitrationDecision('<ruling>{"decision": 42}</ruling>').parseFailed).toBe(true)
    })

    test("rationale defaults to empty string when absent", () => {
        const text = '<ruling>{"decision": "x"}</ruling>'
        expect(parseArbitrationDecision(text).rationale).toBe("")
    })

    test("rationale defaults to empty string when non-string", () => {
        const text = '<ruling>{"decision": "x", "rationale": 123}</ruling>'
        expect(parseArbitrationDecision(text).rationale).toBe("")
    })

    test("parses tag embedded in longer arbiter output", () => {
        const text = `Weighing both positions...\nThe risk profile favors caution.\n\n<ruling>{"decision": "delay", "rationale": "regression risk"}</ruling>\nDone.`
        const result = parseArbitrationDecision(text)
        expect(result).toEqual({ ruling: "delay", rationale: "regression risk" })
    })

    test("handles empty string input", () => {
        expect(parseArbitrationDecision("").parseFailed).toBe(true)
    })

    test("handles undefined-like input gracefully", () => {
        expect(parseArbitrationDecision(undefined as unknown as string).parseFailed).toBe(true)
    })
})

// --- getExpectedMember (arbitrate identity gate) ---

describe("getExpectedMember: arbitrate type", () => {
    test("debate phase (arbitrationStage falsy) returns null (any debater may advance)", () => {
        const task = makeArbitrateTask({ arbiterMember: "arbiter", arbitrationStage: false })
        expect(getExpectedMember(task)).toBe(null)
    })

    test("ruling phase (arbitrationStage true) returns the arbiter member name", () => {
        const task = makeArbitrateTask({ arbiterMember: "arbiter", arbitrationStage: true })
        expect(getExpectedMember(task)).toBe("arbiter")
    })

    test("ruling phase defaults arbiterMember to null when unset", () => {
        const task = makeArbitrateTask({ arbiterMember: undefined, arbitrationStage: true })
        expect(getExpectedMember(task)).toBe(null)
    })

    test("signoff stage overrides arbitrate phase (any reviewer advances)", () => {
        const task = makeArbitrateTask({ arbiterMember: "arbiter", arbitrationStage: false, signoffStage: true })
        expect(getExpectedMember(task)).toBe(null)
    })
})

// --- handleArbitrateIdle Phase A (debate round progression) ---

describe("handleArbitrateIdle Phase A: debate round progression", () => {
    test("single round (maxRounds=1): all debaters idle -> transitions to ruling phase", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            disputants: ["alice", "bob"],
            maxRounds: 1,
            currentRound: 1,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "arbiter", sessionId: "ses_arbiter" },
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                { name: "bob", sessionId: "ses_bob", status: "idle" },
            ],
        })

        await handleArbitrateIdle(ctx, team)

        // Transitioned to Phase B.
        expect(task.arbitrationStage).toBe(true)

        // Only the arbiter was dispatched (debaters had already run round 1).
        const arbiterCall = calls.find(c => c.sessionId === "ses_arbiter")
        expect(arbiterCall).toBeDefined()
        expect(arbiterCall!.text).toContain("Arbitration ruling")

        // The arbiter flipped to running; debaters were not re-dispatched.
        const arbiter = team.members.find(m => m.name === "arbiter")!
        expect(arbiter.status).toBe("running")
        expect(arbiter.turnCount).toBe(1)
    })

    test("multi-round: round 1 barrier advances to round 2 (re-dispatches debaters)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            disputants: ["alice", "bob"],
            maxRounds: 2,
            currentRound: 1,
            responses: { alice: "ship it", bob: "wait" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "arbiter", sessionId: "ses_arbiter" },
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                { name: "bob", sessionId: "ses_bob", status: "idle" },
            ],
        })

        await handleArbitrateIdle(ctx, team)

        // Still in debate phase, round advanced to 2.
        expect(task.arbitrationStage).toBe(false)
        expect(task.currentRound).toBe(2)

        // Both debaters re-dispatched with the round-2 rebuttal prompt;
        // the arbiter was NOT dispatched.
        const round2Calls = calls.filter(
            c => c.sessionId === "ses_alice" || c.sessionId === "ses_bob",
        )
        expect(round2Calls).toHaveLength(2)
        expect(round2Calls.every(c => c.text.includes("Round 2"))).toBe(true)
        expect(calls.some(c => c.sessionId === "ses_arbiter")).toBe(false)
    })

    test("multi-round: round 2 barrier transitions to ruling phase", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            disputants: ["alice", "bob"],
            maxRounds: 2,
            currentRound: 2,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "arbiter", sessionId: "ses_arbiter" },
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                { name: "bob", sessionId: "ses_bob", status: "idle" },
            ],
        })

        await handleArbitrateIdle(ctx, team)

        expect(task.arbitrationStage).toBe(true)
        expect(calls.some(c => c.sessionId === "ses_arbiter")).toBe(true)
    })

    test("not all debaters idle: barrier waits (no dispatch, no transition)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            disputants: ["alice", "bob"],
            maxRounds: 1,
            currentRound: 1,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "arbiter", sessionId: "ses_arbiter" },
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                // bob still running -> barrier must not fire.
                { name: "bob", sessionId: "ses_bob", status: "running" },
            ],
        })

        await handleArbitrateIdle(ctx, team)

        expect(task.arbitrationStage).toBe(false)
        expect(task.currentRound).toBe(1)
        expect(calls).toHaveLength(0)
    })

    test("no active task is a safe no-op", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const team = makeTeam({ members: [{ name: "arbiter", sessionId: "s" }] })
        await expect(handleArbitrateIdle(ctx, team)).resolves.toBeUndefined()
        expect(calls).toHaveLength(0)
    })
})

// --- handleArbitrateIdle Phase B (ruling termination) ---

describe("handleArbitrateIdle Phase B: ruling termination", () => {
    test("valid ruling: delivers summary and clears the task", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            arbitrationStage: true,
            responses: {
                arbiter: '<ruling>{"decision": "delay to Monday", "rationale": "regression risk"}</ruling>',
                alice: "ship",
                bob: "wait",
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "arbiter", sessionId: "ses_arbiter" },
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await handleArbitrateIdle(ctx, team)

        // Ruling captured.
        expect(task.arbitrationRuling).toBe("delay to Monday")
        expect(task.arbitrationRationale).toBe("regression risk")

        // Summary delivered to leader, task cleared, team idle.
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        expect(calls.some(c => c.sessionId === "ses_lead")).toBe(true)
    })

    test("unparseable ruling: fails the run with decision_parse_failure", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            arbitrationStage: true,
            // Arbiter emitted no <ruling> tag.
            responses: { arbiter: "I cannot decide." },
        })
        const runId = task.runId!
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "arbiter", sessionId: "ses_arbiter" }],
        })

        await handleArbitrateIdle(ctx, team)

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()

        // The terminated event carries the failure marker.
        await new Promise(r => setTimeout(r, 50))
        const events = await readRunEvents(team.directory, runId)
        const terminated = events.find(e => e.kind === "terminated")
        expect(terminated).toBeDefined()
        expect(terminated!.reason).toContain("decision_parse_failure")
    })
})

// --- boundary: arbiter unavailable ---

describe("handleArbitrateIdle boundary: arbiter unavailable", () => {
    test("rounds exhausted but arbiter has no session -> fails with arbiter_unavailable", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            disputants: ["alice", "bob"],
            maxRounds: 1,
            currentRound: 1,
        })
        const runId = task.runId!
        const team = makeTeam({
            activeTask: task,
            members: [
                // arbiter present in roster but with NO session.
                { name: "arbiter" },
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                { name: "bob", sessionId: "ses_bob", status: "idle" },
            ],
        })

        await handleArbitrateIdle(ctx, team)

        // Failed; arbitrationStage was set before the availability check.
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()

        // The terminated reason names the arbiter_unavailable marker.
        await new Promise(r => setTimeout(r, 50))
        const events = await readRunEvents(team.directory, runId)
        const terminated = events.find(e => e.kind === "terminated")
        expect(terminated).toBeDefined()
        expect(terminated!.reason).toContain("arbiter_unavailable")
    })
})

// --- arbitrated event observability ---

describe("arbitrated event recording", () => {
    test("Phase B records an arbitrated event naming the arbiter and ruling", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const ruling = "delay to Monday"
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            arbitrationStage: true,
            responses: {
                arbiter: `<ruling>{"decision": "${ruling}", "rationale": "risk"}</ruling>`,
            },
        })
        const runId = task.runId!
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "arbiter", sessionId: "ses_arbiter" }],
        })

        await handleArbitrateIdle(ctx, team)

        // recordEvent is fire-and-forget; give the async appends a tick to flush.
        await new Promise(r => setTimeout(r, 50))
        const events = await readRunEvents(team.directory, runId)

        const arbitrated = events.find(e => e.kind === "arbitrated")
        expect(arbitrated).toBeDefined()
        expect(arbitrated!.member).toBe("arbiter")
        // detail carries the (truncated) ruling; short enough to survive verbatim.
        expect(arbitrated!.detail).toContain(ruling)
    })
})

// --- round event observability ---

describe("round event recording", () => {
    test("advancing to round 2 records a round event", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            disputants: ["alice", "bob"],
            maxRounds: 3,
            currentRound: 1,
            responses: { alice: "go", bob: "stop" },
        })
        const runId = task.runId!
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "arbiter", sessionId: "ses_arbiter" },
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                { name: "bob", sessionId: "ses_bob", status: "idle" },
            ],
        })

        await handleArbitrateIdle(ctx, team)

        await new Promise(r => setTimeout(r, 50))
        const events = await readRunEvents(team.directory, runId)
        const roundEvent = events.find(e => e.kind === "round")
        expect(roundEvent).toBeDefined()
        expect(roundEvent!.round).toBe(2)
    })
})

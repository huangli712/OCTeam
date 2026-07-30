import { afterAll, afterEach, describe, expect, test } from 'bun:test';


import { getExpectedMember } from "../src/orchestration/lifecycle/idle.js"
import { handleArbitrateIdle } from "../src/orchestration/modes/arbitrate.js"
import { parseArbitrationDecision } from "../src/orchestration/protocol/decisions.js"
import { readRunEvents, readRunRecord } from "../src/orchestration/records/runs.js"
import { buildSummary } from "../src/orchestration/records/summary.js"
import { teamArbitrateTool } from "../src/tools/modes/arbitrate.js"
import { teamResumeTool } from "../src/tools/control/resume.js"
import type { ArbitrateTask, MemberState } from "../src/core/types.js"
import { initTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { type DispatchCall, cleanupTmpRoots, makeCtx, makeMember, makeResumeCtx, makeState, makeTeam, makeToolContext, setupFailedTeam, tmpRoot, waitForEvent } from './helpers.js';

afterAll(cleanupTmpRoots)

// --- fixtures ---

/** Minimal valid arbitrate ActiveTask with sensible defaults. */
function makeArbitrateTask(opts: Partial<ArbitrateTask> = {}): ArbitrateTask {
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
    } as ArbitrateTask
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
        const ctx = makeCtx({ calls })
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
        const ctx = makeCtx({ calls })
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
        const ctx = makeCtx({ calls })
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
        const ctx = makeCtx({ calls })
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
        const ctx = makeCtx({ calls })
        const team = makeTeam({ members: [{ name: "arbiter", sessionId: "s" }] })
        await expect(handleArbitrateIdle(ctx, team)).resolves.toBeUndefined()
        expect(calls).toHaveLength(0)
    })
})

// --- handleArbitrateIdle Phase B (ruling termination) ---

describe("handleArbitrateIdle Phase B: ruling termination", () => {
    test("valid ruling: delivers summary and clears the task", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
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

    test("parse failure: first attempt re-dispatches arbiter (bounded retry)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            arbitrationStage: true,
            // Arbiter emitted no <ruling> tag.
            responses: { arbiter: "I cannot decide." },
        })
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "arbiter", sessionId: "ses_arbiter" }],
        })

        await handleArbitrateIdle(ctx, team)

        // First parse failure → bounded retry, NOT immediate failure.
        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
        expect(task.decisionParseFailures).toBe(1)

        // Arbiter re-dispatched with the ruling prompt.
        const arbiterCall = calls.find(c => c.sessionId === "ses_arbiter")
        expect(arbiterCall).toBeDefined()
        expect(arbiterCall!.text).toContain("[Arbitration ruling]")

        // Stale malformed response cleared.
        expect(task.responses["arbiter"]).toBeUndefined()
    })

    test("parse failure: second consecutive failure terminates the run", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            arbitrationStage: true,
            // Arbiter emitted no <ruling> tag again.
            responses: { arbiter: "Still cannot decide." },
            decisionParseFailures: 1,   // already failed once → this is the second
        })
        const runId = task.runId!
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "arbiter", sessionId: "ses_arbiter" }],
        })

        await handleArbitrateIdle(ctx, team)

        // Second parse failure → run terminated.
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()

        // The terminated event carries the failure marker.
        await waitForEvent(team.directory, runId, "terminated")
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
        const ctx = makeCtx({ calls })
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
        await waitForEvent(team.directory, runId, "terminated")
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
        const ctx = makeCtx({ calls })
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

        // recordEvent is fire-and-forget; wait for the arbitrated event to flush.
        await waitForEvent(team.directory, runId, "arbitrated")
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
        const ctx = makeCtx({ calls })
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

        await waitForEvent(team.directory, runId, "round")
        const events = await readRunEvents(team.directory, runId)
        const roundEvent = events.find(e => e.kind === "round")
        expect(roundEvent).toBeDefined()
        expect(roundEvent!.round).toBe(2)
    })
})


// =======================================================================
// Tool-level fixtures (disk-backed team state + master session indexing).
// teamArbitrateTool validation (LOW-1) and team_resume (LOW-2) both flow
// through resolveCallerInTeam + loadTeamState, so they need real on-disk
// state and an indexed master session.
// =======================================================================

/** Track indexed master sessions so each test cleans up its index entry. */
const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

/** Minimal PluginContext exposing only storageRoot (teamArbitrateTool validation). */


/** Create an active on-disk team and index its master session. */
async function setupArbitrateTeam(
    root: string,
    sid: string,
    members: MemberState[] = [makeMember("arbiter"), makeMember("alice"), makeMember("bob")],
): Promise<void> {
    await initTeamState(root, makeState("alpha", sid, members, Date.now()), sid)
    await rebuildSessionIndex(root, `${root}__unused`)
}

// --- LOW-1: teamArbitrateTool input validation (error branches) ---

describe("teamArbitrateTool: input validation", () => {
    test('arbiter = "master" is rejected before any team lookup', async () => {
        const root = tmpRoot("arb-val-master")
        const sid = "ses_arb_val_master"
        tracked.push(sid)
        await setupArbitrateTeam(root, sid)
        const result = await teamArbitrateTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                task: "Should we ship on Friday?",
                arbiter: "master",
                debaters: ["alice", "bob"],
            },
            makeToolContext(sid),
        )
        expect(result).toBe('Error: arbiter must be a member name, not "master"')
    })

    test("duplicate debater names are rejected", async () => {
        const root = tmpRoot("arb-val-dupnames")
        const sid = "ses_arb_val_dupnames"
        tracked.push(sid)
        await setupArbitrateTeam(root, sid)
        const result = await teamArbitrateTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                task: "Should we ship on Friday?",
                arbiter: "arbiter",
                debaters: ["alice", "alice"],
            },
            makeToolContext(sid),
        )
        expect(result).toBe("Error: debaters must have unique names")
    })

    test("arbiter that is also a debater is rejected", async () => {
        const root = tmpRoot("arb-val-selfdebater")
        const sid = "ses_arb_val_selfdebater"
        tracked.push(sid)
        await setupArbitrateTeam(root, sid)
        const result = await teamArbitrateTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                task: "Should we ship on Friday?",
                arbiter: "arbiter",
                debaters: ["arbiter", "bob"],
            },
            makeToolContext(sid),
        )
        expect(result).toBe("Error: arbiter must not also be a debater")
    })

    test("unknown member is rejected", async () => {
        const root = tmpRoot("arb-val-unknown")
        const sid = "ses_arb_val_unknown"
        tracked.push(sid)
        await setupArbitrateTeam(root, sid)
        const result = await teamArbitrateTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                task: "Should we ship on Friday?",
                arbiter: "arbiter",
                debaters: ["alice", "ghost"],
            },
            makeToolContext(sid),
        )
        expect(result).toBe('Error: arbiter/debaters "ghost" is not a member of team "alpha"')
    })

    test("signoff_policy 'decider' without signoff_decider is rejected", async () => {
        const root = tmpRoot("arb-val-nodecider")
        const sid = "ses_arb_val_nodecider"
        tracked.push(sid)
        await setupArbitrateTeam(root, sid)
        const result = await teamArbitrateTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                task: "Should we ship on Friday?",
                arbiter: "arbiter",
                debaters: ["alice", "bob"],
                signoff_policy: "decider",
            },
            makeToolContext(sid),
        )
        expect(result).toBe(
            "Error: signoff_policy 'decider' requires signoff_decider (a member name)",
        )
    })

    test("signoff_policy 'decider' with an unknown signoff_decider is rejected", async () => {
        const root = tmpRoot("arb-val-baddecider")
        const sid = "ses_arb_val_baddecider"
        tracked.push(sid)
        await setupArbitrateTeam(root, sid)
        const result = await teamArbitrateTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                task: "Should we ship on Friday?",
                arbiter: "arbiter",
                debaters: ["alice", "bob"],
                signoff_policy: "decider",
                signoff_decider: "ghost",
            },
            makeToolContext(sid),
        )
        expect(result).toBe('Error: signoff_decider "ghost" is not a member of team "alpha"')
    })
})

// --- LOW-2: team_resume arbitrate branches ---
describe("team_resume: arbitrate case", () => {
    test("Phase A re-dispatches only debaters that have no captured response", async () => {
        const root = tmpRoot("arb-resume-a-redispatch")
        const sid = "ses_arb_resume_a_redispatch"
        tracked.push(sid)
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            disputants: ["alice", "bob"],
            arbitrationStage: false,
            maxRounds: 1,
            currentRound: 1,
            // alice argued before the crash; bob did not.
            responses: { alice: "ship it" },
        })
        const team = await setupFailedTeam(root, sid, task, [
            makeMember("arbiter", "ses_arbiter"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const calls: string[] = []
        const ctx = makeResumeCtx(root, async req => {
            calls.push(req.path.id)
        })

        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        expect(res).toContain("Resumed arbitrate")
        // Only the debater missing a response (bob) is re-dispatched; not alice,
        // not the arbiter. The run stays in the debate phase.
        expect(calls).toEqual(["ses_bob"])
        expect((team.activeTask as ArbitrateTask | undefined)?.arbitrationStage).toBe(false)
    })

    test("Phase A with all debater responses re-drives the barrier into the ruling phase", async () => {
        const root = tmpRoot("arb-resume-a-barrier")
        const sid = "ses_arb_resume_a_barrier"
        tracked.push(sid)
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            disputants: ["alice", "bob"],
            arbitrationStage: false,
            maxRounds: 1,
            currentRound: 1,
            // Both debaters already argued -> nothing to re-dispatch.
            responses: { alice: "ship it", bob: "wait" },
        })
        const team = await setupFailedTeam(root, sid, task, [
            makeMember("arbiter", "ses_arbiter"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const calls: string[] = []
        const ctx = makeResumeCtx(root, async req => {
            calls.push(req.path.id)
        })

        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        expect(res).toContain("Resumed arbitrate")
        // Zero debaters re-dispatched -> handleArbitrateIdle transitions to the
        // ruling phase and dispatches the arbiter.
        expect((team.activeTask as ArbitrateTask | undefined)?.arbitrationStage).toBe(true)
        expect(calls).toEqual(["ses_arbiter"])
    })

    test("Phase B re-dispatches the arbiter when it has no captured ruling", async () => {
        const root = tmpRoot("arb-resume-b-redispatch")
        const sid = "ses_arb_resume_b_redispatch"
        tracked.push(sid)
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            disputants: ["alice", "bob"],
            arbitrationStage: true,
            // Arbiter was dispatched but crashed before producing a ruling.
            responses: { alice: "ship it", bob: "wait" },
        })
        const team = await setupFailedTeam(root, sid, task, [
            makeMember("arbiter", "ses_arbiter"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const calls: string[] = []
        const ctx = makeResumeCtx(root, async req => {
            calls.push(req.path.id)
        })

        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        expect(res).toContain("Resumed arbitrate")
        // Arbiter has no response -> re-dispatched; the ruling phase is preserved.
        expect(calls).toEqual(["ses_arbiter"])
        expect((team.activeTask as ArbitrateTask | undefined)?.arbitrationStage).toBe(true)
    })

    test("Phase B fails when the checkpoint arbiter is missing from the team", async () => {
        const root = tmpRoot("arb-resume-b-missing")
        const sid = "ses_arb_resume_b_missing"
        tracked.push(sid)
        const task = makeArbitrateTask({
            arbiterMember: "ghost",
            arbitrationStage: true,
            responses: { alice: "ship it", bob: "wait" },
        })
        const team = await setupFailedTeam(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])

        await teamResumeTool(makeResumeCtx(root, async () => {})).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const record = await readRunRecord(team.directory, task.runId!)
        expect(record?.reason).toBe("arbitrate_resume_missing_arbiter")
    })

    test("Phase B with a captured ruling re-runs handleArbitrateIdle to deliver", async () => {
        const root = tmpRoot("arb-resume-b-deliver")
        const sid = "ses_arb_resume_b_deliver"
        tracked.push(sid)
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            disputants: ["alice", "bob"],
            arbitrationStage: true,
            // Arbiter already produced a valid ruling before the crash.
            responses: {
                alice: "ship it",
                bob: "wait",
                arbiter: '<ruling>{"decision": "delay to Monday", "rationale": "risk"}</ruling>',
            },
        })
        const team = await setupFailedTeam(root, sid, task, [
            makeMember("arbiter", "ses_arbiter"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const calls: string[] = []
        const ctx = makeResumeCtx(root, async req => {
            calls.push(req.path.id)
        })

        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        expect(res).toContain("Resumed arbitrate")
        // Arbiter response present -> handleArbitrateIdle parses the ruling and
        // delivers to the leader; the run completes (task cleared, team idle).
        expect(calls).toEqual([sid])
        expect(team.activeTask).toBeUndefined()
        expect(team.status).toBe("idle")
    })
})

// --- LOW-3: buildSummary arbitrate case ---

describe("buildSummary: arbitrate case", () => {
    test("leads with the ruling + rationale, shows debater positions, excludes <ruling> JSON", async () => {
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            disputants: ["alice", "bob"],
            arbitrationStage: true,
            arbitrationRuling: "delay to Monday",
            arbitrationRationale: "regression risk",
            responses: {
                // The arbiter's <ruling> decision must NOT leak into the summary.
                arbiter: '<ruling>{"decision":"delay to Monday","rationale":"regression risk"}</ruling>',
                alice: "Ship on Friday",
                bob: "Wait until Monday",
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "arbiter" }, { name: "alice" }, { name: "bob" }],
        })

        const summary = await buildSummary(team, task, "arbitrate_complete:ruled")

        // Head reflects mode + reason.
        expect(summary).toContain("<mode>arbitrate</mode>")
        expect(summary).toContain("<reason>arbitrate_complete:ruled</reason>")
        // The binding ruling and its rationale lead the summary.
        expect(summary).toContain("[Ruling]")
        expect(summary).toContain("delay to Monday")
        expect(summary).toContain("[Rationale]")
        expect(summary).toContain("regression risk")
        // Each debater's final position is shown.
        expect(summary).toContain("by alice:")
        expect(summary).toContain("Ship on Friday")
        expect(summary).toContain("by bob:")
        expect(summary).toContain("Wait until Monday")
        // The arbiter's raw <ruling> decision JSON is excluded as noise.
        expect(summary).not.toContain("<ruling>")
    })

    test("falls back to 'Ruling: (none)' and omits the Rationale line when the ruling is unset", async () => {
        const task = makeArbitrateTask({
            arbiterMember: "arbiter",
            disputants: ["alice", "bob"],
            arbitrationStage: true,
            // No ruling captured (e.g. delivered on a failure path).
            responses: { alice: "Ship on Friday", bob: "Wait until Monday" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "arbiter" }, { name: "alice" }, { name: "bob" }],
        })

        const summary = await buildSummary(team, task, "arbitrate_complete:arbiter_unavailable")

        // No ruling -> placeholder, and the Rationale line is omitted entirely.
        expect(summary).toContain("[Ruling]")
        expect(summary).toContain("(none)")
        expect(summary).not.toContain("[Rationale]")
        // Debater positions are still included.
        expect(summary).toContain("by alice:")
        expect(summary).toContain("by bob:")
    })
})

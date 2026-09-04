import { afterEach, describe, expect, test } from "bun:test"



import { getExpectedMember } from "../src/orchestration/lifecycle/idle.js"
import { advanceToGatedStage, handleTollgateIdle, startVerification } from "../src/orchestration/modes/tollgate.js"
import { parseVerdict } from "../src/orchestration/protocol/decisions.js"
import { readRunRecord, runStatusFromReason } from "../src/orchestration/records/runs.js"
import { buildSummary } from "../src/orchestration/records/summary.js"
import { teamTollgateTool } from "../src/tools/modes/tollgate.js"
import { teamResumeTool } from "../src/tools/control/resume.js"
import type { GatedStage, MemberState, TollgateTask } from "../src/core/types.js"
import { initTeamState, loadTeamState, saveTeamState, type Team } from "../src/state/store.js"

import type { PluginContext } from "../src/core/context.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { type DispatchCall, makeCtx, makeMember, makeState, makeTeam, makeToolContext, setupFailedTeam, tmpRoot } from './helpers.js';

// --- fixtures ---



/** Build a GatedStage with sensible defaults. */
function gate(opts: Partial<GatedStage> & Pick<GatedStage, "member" | "verifier">): GatedStage {
    return {
        member: opts.member,
        verifier: opts.verifier,
        task: opts.task ?? "produce the artifact",
        completed: opts.completed ?? false,
        criteria: opts.criteria ?? "numerically correct within tolerance",
        reference: opts.reference,
        verdict: opts.verdict,
        attempts: opts.attempts ?? 0,
        invalidAttempts: opts.invalidAttempts ?? 0,
    }
}

/** Minimal valid tollgate ActiveTask with sensible defaults. */
function makeTollgateTask(opts: Partial<TollgateTask> = {}): TollgateTask {
    return {
        type: "tollgate",
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
        signoffPolicy: "none",
        tollgatePhase: "produce",
        ...opts,
    } as TollgateTask
}



/** Simulate processIdle Step 1 (flip a member to idle) and return it. */
function idle(team: Team, name: string): MemberState {
    const m = team.members.find(x => x.name === name)
    if (!m) throw new Error(`no member ${name}`)
    m.status = "idle"
    return m
}

// Canonical verifier <verdict> payloads.
const V = {
    pass: '<verdict>{"result":"PASS","rationale":"within tolerance","diff":""}</verdict>',
    fail: (rationale = "off by 1e-3", diff = "|got-expected|_max=1.2e-3 @grid[3]") =>
        `<verdict>{"result":"FAIL","rationale":"${rationale}","diff":"${diff}"}</verdict>`,
    invalid: (rationale = "golden reference missing") =>
        `<verdict>{"result":"INVALID","rationale":"${rationale}","diff":""}</verdict>`,
    judge: '<判定>{"result":"PASS","rationale":"ok","diff":""}</判定>',
}

// --- parseVerdict (pure function) ---

describe("parseVerdict", () => {
    test("parses a PASS verdict", () => {
        const r = parseVerdict(V.pass)
        expect(r.verdict).toBe("PASS")
        expect(r.rationale).toBe("within tolerance")
        expect(r.diff).toBe("")
        expect(r.parseFailed).toBeUndefined()
    })

    test("parses a FAIL verdict carrying the diff", () => {
        const r = parseVerdict(V.fail("conservation violated", "L2_norm=4e-2"))
        expect(r.verdict).toBe("FAIL")
        expect(r.rationale).toBe("conservation violated")
        expect(r.diff).toBe("L2_norm=4e-2")
    })

    test("parses an INVALID verdict", () => {
        expect(parseVerdict(V.invalid("reference corrupted")).verdict).toBe("INVALID")
    })

    test("result is case-insensitive (lowercase pass)", () => {
        expect(parseVerdict('<verdict>{"result":"pass"}</verdict>').verdict).toBe("PASS")
    })

    test("returns parseFailed when no tag is present", () => {
        const r = parseVerdict("the output looks fine, no verdict tag")
        expect(r.parseFailed).toBe(true)
        expect(r.verdict).toBeUndefined()
    })

    test("returns parseFailed for malformed JSON inside the tag", () => {
        expect(parseVerdict("<verdict>not valid json</verdict>").parseFailed).toBe(true)
    })

    test("returns parseFailed when result value is unrecognized", () => {
        expect(parseVerdict('<verdict>{"result":"MAYBE"}</verdict>').parseFailed).toBe(true)
    })

    test("returns parseFailed when result is missing", () => {
        expect(parseVerdict('<verdict>{"rationale":"no result"}</verdict>').parseFailed).toBe(true)
    })

    test("parses the bilingual <判定> alias", () => {
        const r = parseVerdict(V.judge)
        expect(r.verdict).toBe("PASS")
        expect(r.rationale).toBe("ok")
    })

    test("does NOT parse an arbitrate <裁决> tag (collision avoided)", () => {
        // <裁决> is owned by parseArbitrationDecision; tollgate must ignore it so
        // the two parsers never cross-wire. This is the regression guard.
        const r = parseVerdict('<裁决>{"result":"PASS","rationale":"leaked"}</裁决>')
        expect(r.parseFailed).toBe(true)
        expect(r.verdict).toBeUndefined()
    })

    test("rationale and diff default to empty string when absent or non-string", () => {
        const r = parseVerdict('<verdict>{"result":"PASS"}</verdict>')
        expect(r.rationale).toBe("")
        expect(r.diff).toBe("")
        const r2 = parseVerdict('<verdict>{"result":"PASS","rationale":42,"diff":true}</verdict>')
        expect(r2.rationale).toBe("")
        expect(r2.diff).toBe("")
    })

    test("parses a tag embedded in longer verifier output", () => {
        const text = `Aligning by grid points...\nMax diff 3e-4, within tol.\n\n${V.pass}\nDone.`
        expect(parseVerdict(text).verdict).toBe("PASS")
    })

    test("handles empty string and undefined-like input", () => {
        expect(parseVerdict("").parseFailed).toBe(true)
        expect(parseVerdict(undefined as unknown as string).parseFailed).toBe(true)
    })
})

// --- getExpectedMember: tollgate three-phase identity gate ---

describe("getExpectedMember: tollgate type", () => {
    const g = gate({ member: "alice", verifier: "bob" })

    test("produce phase returns the producer", () => {
        const task = makeTollgateTask({ gatedStages: [g], tollgatePhase: "produce" })
        expect(getExpectedMember(task)).toBe("alice")
    })

    test("verify phase returns the verifier (NOT the producer)", () => {
        const task = makeTollgateTask({ gatedStages: [g], tollgatePhase: "verify" })
        expect(getExpectedMember(task)).toBe("bob")
        // The producer's idle in verify phase is therefore a stray.
        expect(getExpectedMember(task)).not.toBe("alice")
    })

    test("escalate phase returns the escalateTo handler (load-bearing)", () => {
        const task = makeTollgateTask({
            gatedStages: [g],
            tollgatePhase: "escalate",
            escalateTo: "carol",
        })
        // Without this returning escalateTo, the escalator's idle would be
        // treated as stray in processIdle Step 3 and the run would deadlock.
        expect(getExpectedMember(task)).toBe("carol")
    })

    test("escalate phase with no escalateTo returns null (delivered to leader)", () => {
        const task = makeTollgateTask({ gatedStages: [g], tollgatePhase: "escalate" })
        expect(getExpectedMember(task)).toBeNull()
    })

    test("undefined phase defaults to produce (returns producer)", () => {
        const task = makeTollgateTask({ gatedStages: [g] })
        ;(task as { tollgatePhase?: TollgateTask["tollgatePhase"] }).tollgatePhase = undefined
        expect(getExpectedMember(task)).toBe("alice")
    })

    test("currentStageIndex out of range returns null", () => {
        const task = makeTollgateTask({
            gatedStages: [g],
            currentStageIndex: 5,
            tollgatePhase: "verify",
        })
        expect(getExpectedMember(task)).toBeNull()
    })

    test("signoff stage overrides phase (any reviewer may advance)", () => {
        const task = makeTollgateTask({
            gatedStages: [g],
            tollgatePhase: "verify",
            signoffStage: true,
        })
        expect(getExpectedMember(task)).toBeNull()
    })
})

// --- handleTollgateIdle: produce -> verify transition ---

describe("handleTollgateIdle: produce -> verify", () => {
    test("producer idle in produce phase dispatches the verifier and sets phase=verify", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "produce",
            responses: { alice: "the produced artifact" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await handleTollgateIdle(ctx, team, idle(team, "alice"))

        expect(task.tollgatePhase).toBe("verify")
        const verifierCall = calls.find(c => c.sessionId === "ses_bob")
        expect(verifierCall).toBeDefined()
        expect(verifierCall!.text).toContain("[Verification gate]")
        // The verifier receives the producer's OUTPUT and the criteria (NOT the
        // producer's task description) — it judges the output, not the task.
        expect(verifierCall!.text).toContain("the produced artifact")
        expect(verifierCall!.text).toContain("numerically correct within tolerance")
        // The producer was NOT re-dispatched by the produce->verify transition.
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)
    })

    test("producer idle without output retries or fails, never hangs", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "produce",
            responses: { alice: "" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", turnCount: 1 },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await handleTollgateIdle(ctx, team, idle(team, "alice"))

        // N16-tollgate: empty producer output now retries the produce stage
        // instead of silently hanging. With maxGateRetries=0 (default),
        // the first empty output exhausts retries and fails the run.
        // The run must NOT stay stuck in produce with 0 calls.
        const advanced = task.tollgatePhase !== "produce" || calls.length > 0 || team.status === "failed"
        expect(advanced).toBe(true)
    })

    test("stray idle in produce phase (verifier idles) is ignored", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "produce",
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await handleTollgateIdle(ctx, team, idle(team, "bob"))

        expect(task.tollgatePhase).toBe("produce")
        expect(calls).toHaveLength(0)
    })

    test("stray idle in verify phase (producer idles) is ignored", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "verify",
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await handleTollgateIdle(ctx, team, idle(team, "alice"))

        expect(task.tollgatePhase).toBe("verify")
        expect(calls).toHaveLength(0)
    })

    test("verifier with no live session in produce phase escalates as INVALID", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "produce",
            responses: { alice: "artifact" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob" }, // no session -> verifier unavailable
                { name: "carol", sessionId: "ses_carol" },
            ],
        })
        task.escalateTo = "carol"

        await handleTollgateIdle(ctx, team, idle(team, "alice"))

        // Verifier unavailable is an INVALID condition: escalated to carol, not
        // penalizing the producer.
        expect(task.gatedStages![0].verdict).toBe("INVALID")
        expect(task.tollgatePhase).toBe("escalate")
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(true)
    })
})

// --- PASS advances / completes ---

describe("handleTollgateIdle: PASS advances and completes", () => {
    test("single gate PASS -> tollgate_complete, delivered to leader", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "verify",
            responses: { alice: "artifact", bob: V.pass },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await handleTollgateIdle(ctx, team, idle(team, "bob"))

        expect(task.gatedStages![0].completed).toBe(true)
        expect(task.gatedStages![0].verdict).toBe("PASS")
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        expect(calls.some(c => c.sessionId === "ses_lead")).toBe(true)
    })

    test("PASS on gate 0 advances to gate 1 (dispatches gate-1 producer)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [
                gate({ member: "alice", verifier: "bob" }),
                gate({ member: "dave", verifier: "eve", task: "build the integrator" }),
            ],
            tollgatePhase: "verify",
            responses: { alice: "flux core", bob: V.pass },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "dave", sessionId: "ses_dave" },
                { name: "eve", sessionId: "ses_eve" },
            ],
        })

        await handleTollgateIdle(ctx, team, idle(team, "bob"))

        expect(task.gatedStages![0].completed).toBe(true)
        expect(task.currentStageIndex).toBe(1)
        expect(task.tollgatePhase).toBe("produce")
        // Gate-1 producer dispatched with its task; gate-0 producer NOT re-run.
        const daveCall = calls.find(c => c.sessionId === "ses_dave")
        expect(daveCall).toBeDefined()
        expect(daveCall!.text).toContain("build the integrator")
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)
    })

    test("all gates PASS -> tollgate_complete", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [
                gate({ member: "alice", verifier: "bob", completed: true }),
                gate({ member: "dave", verifier: "eve" }),
            ],
            currentStageIndex: 1,
            tollgatePhase: "verify",
            responses: { alice: "flux", dave: "integrator", eve: V.pass },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "dave", sessionId: "ses_dave" },
                { name: "eve", sessionId: "ses_eve" },
            ],
        })

        await handleTollgateIdle(ctx, team, idle(team, "eve"))

        expect(task.gatedStages!.every(s => s.completed)).toBe(true)
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        expect(calls.some(c => c.sessionId === "ses_lead")).toBe(true)
    })
})

// --- FAIL retry semantics ---

describe("handleTollgateIdle: FAIL retry semantics", () => {
    test("default maxGateRetries=0 -> first FAIL fails the run", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "verify",
            // maxGateRetries unset -> default 0
            responses: { alice: "artifact", bob: V.fail() },
        })
        const runId = task.runId!
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await handleTollgateIdle(ctx, team, idle(team, "bob"))

        expect(task.gatedStages![0].attempts).toBe(1)
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        // The producer was NOT retried (default 0 -> fail immediately).
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)

        // T-4 regression: the persisted run record is classified as failed.
        const record = await readRunRecord(team.directory, runId)
        expect(record).not.toBeNull()
        expect(record!.status).toBe("failed")
        expect(record!.reason).toContain("tollgate_failed")
    })

    test("maxGateRetries=2 -> exactly 2 retries then fail (attempts counted)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "verify",
            maxGateRetries: 2,
            responses: { alice: "artifact", bob: V.fail() },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        // FAIL #1: attempts 1, within 2 -> retry (back to produce).
        await handleTollgateIdle(ctx, team, idle(team, "bob"))
        expect(team.status).toBe("busy")
        expect(task.tollgatePhase).toBe("produce")
        expect(task.gatedStages![0].attempts).toBe(1)
        const fail1 = calls.find(c => c.sessionId === "ses_alice")
        expect(fail1).toBeDefined()
        expect(fail1!.text).toContain("Gate FAILED")
        expect(fail1!.text).toContain("attempt 1/2")
        expect(fail1!.text).toContain("off by 1e-3")

        // Producer resubmits -> produce idle -> re-verify.
        task.responses["alice"] = "revised artifact 1"
        await handleTollgateIdle(ctx, team, idle(team, "alice"))
        expect(task.tollgatePhase).toBe("verify")
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(true)
        // startVerification clears responses[verifier] before dispatch.
        // Simulate bob (verifier) actually producing output after dispatch.
        task.responses["bob"] = V.fail()

        // FAIL #2: attempts 2, within 2 -> retry.
        calls.length = 0
        await handleTollgateIdle(ctx, team, idle(team, "bob"))
        expect(team.status).toBe("busy")
        expect(task.tollgatePhase).toBe("produce")
        expect(task.gatedStages![0].attempts).toBe(2)
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(true)

        // Producer resubmits -> produce idle -> re-verify.
        task.responses["alice"] = "revised artifact 2"
        await handleTollgateIdle(ctx, team, idle(team, "alice"))
        expect(task.tollgatePhase).toBe("verify")
        // Re-populate verifier output after dispatch clears it.
        task.responses["bob"] = V.fail()

        // FAIL #3: attempts 3, exceeds 2 -> fail.
        await handleTollgateIdle(ctx, team, idle(team, "bob"))
        expect(task.gatedStages![0].attempts).toBe(3)
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
    })

    test("FAIL retry does NOT start the downstream gate's producer", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [
                gate({ member: "alice", verifier: "bob" }),
                gate({ member: "dave", verifier: "eve", task: "downstream work" }),
            ],
            tollgatePhase: "verify",
            maxGateRetries: 3,
            responses: { alice: "artifact", bob: V.fail() },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "dave", sessionId: "ses_dave" },
                { name: "eve", sessionId: "ses_eve" },
            ],
        })

        await handleTollgateIdle(ctx, team, idle(team, "bob"))

        // Gate-0 FAIL -> producer alice gets the diff; downstream dave NOT started.
        expect(task.currentStageIndex).toBe(0)
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(true)
        expect(calls.some(c => c.sessionId === "ses_dave")).toBe(false)
    })
})

// --- INVALID escalation: T-1 deadlock regression (core) ---

describe("handleTollgateIdle: INVALID escalation", () => {
    test("INVALID + escalateTo -> escalate phase -> re-verify, producer never re-dispatched", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "verify",
            escalateTo: "carol",
            responses: { alice: "artifact", bob: V.invalid("reference corrupted") },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", turnCount: 1 },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        })
        const producerTurnBefore = team.members.find(m => m.name === "alice")!.turnCount

        // Load-bearing: in escalate phase the identity gate returns the
        // escalator, so its idle is not a stray (the original deadlock root).
        task.tollgatePhase = "verify"
        expect(getExpectedMember(task)).toBe("bob")

        // Verifier emits INVALID -> isolate + escalate to carol.
        await handleTollgateIdle(ctx, team, idle(team, "bob"))
        expect(task.gatedStages![0].verdict).toBe("INVALID")
        expect(task.tollgatePhase as string).toBe("escalate")
        expect(getExpectedMember(task)).toBe("carol")
        // Escalator dispatched; producer and verifier NOT re-dispatched yet.
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(true)
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(false)
        // Producer is NOT penalized: turnCount unchanged.
        expect(team.members.find(m => m.name === "alice")!.turnCount).toBe(producerTurnBefore)

        // Carol fixes the verifier/reference and idles -> re-verify.
        calls.length = 0
        task.responses.bob = V.pass // the verifier now renders a verdict
        await handleTollgateIdle(ctx, team, idle(team, "carol"))

        // Re-entered verify, dispatched the verifier, reached a PASS verdict.
        // No deadlock: the run progressed past escalate.
        expect(task.tollgatePhase).toBe("verify")
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(true)
        // Producer STILL never re-dispatched through the whole INVALID cycle.
        expect(team.members.find(m => m.name === "alice")!.turnCount).toBe(producerTurnBefore)
    })

    test("INVALID without escalateTo -> HITL escalation to leader (approval pause), not auto-fail", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "verify",
            // no escalateTo
            responses: { alice: "artifact", bob: V.invalid("cannot align") },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await handleTollgateIdle(ctx, team, idle(team, "bob"))

        expect(task.gatedStages![0].verdict).toBe("INVALID")
        // The run is now paused for HITL approval, not auto-failed.
        // The team is still busy (approval pending).
        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
        expect(team.activeTask?.approvalStage).toBeTruthy()
        // Producer NOT penalized (no re-dispatch).
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)
    })

    test("parse failure (no verdict tag) is treated as INVALID, not a producer FAIL", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "verify",
            escalateTo: "carol",
            responses: { alice: "artifact", bob: "I cannot evaluate this." }, // no <verdict>
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        })

        await handleTollgateIdle(ctx, team, idle(team, "bob"))

        // Unparseable verifier output -> INVALID (escalated), producer untouched.
        expect(task.gatedStages![0].verdict).toBe("INVALID")
        expect(task.tollgatePhase).toBe("escalate")
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(true)
    })
})

// --- INVALID cycle cap (P2 regression) ---

describe("handleTollgateIdle: INVALID cycle cap", () => {
    test("maxInvalidCycles=2 -> the 3rd INVALID fails with tollgate_invalid:exhausted", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "verify",
            escalateTo: "carol",
            maxInvalidCycles: 2,
            // The verifier persistently cannot evaluate: every verify phase yields INVALID.
            responses: { alice: "artifact", bob: V.invalid("cannot align") },
        })
        const runId = task.runId!
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        })

        // INVALID #1: invalidAttempts 1, within cap -> escalate to carol.
        await handleTollgateIdle(ctx, team, idle(team, "bob"))
        expect(task.gatedStages![0].invalidAttempts).toBe(1)
        expect(task.tollgatePhase).toBe("escalate")
        expect(team.status).toBe("busy")
        // Escalation handler reports done -> re-verify (verdict cleared).
        await handleTollgateIdle(ctx, team, idle(team, "carol"))
        expect(task.tollgatePhase).toBe("verify")

        // INVALID #2: invalidAttempts 2, == cap (still within) -> escalate again.
        await handleTollgateIdle(ctx, team, idle(team, "bob"))
        expect(task.gatedStages![0].invalidAttempts).toBe(2)
        expect(task.tollgatePhase).toBe("escalate")
        expect(team.status).toBe("busy")
        await handleTollgateIdle(ctx, team, idle(team, "carol"))
        expect(task.tollgatePhase).toBe("verify")

        // INVALID #3: invalidAttempts 3 > cap(2) -> the run FAILS (no more looping).
        await handleTollgateIdle(ctx, team, idle(team, "bob"))
        expect(task.gatedStages![0].invalidAttempts).toBe(3)
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        // The escalator was NOT re-dispatched on the exhausting cycle.
        const carolCallsBefore = calls.filter(c => c.sessionId === "ses_carol").length
        expect(carolCallsBefore).toBe(2) // exactly two escalations, not a third

        // Run record classified as failed with the exhausted marker.
        const record = await readRunRecord(team.directory, runId)
        expect(record).not.toBeNull()
        expect(record!.status).toBe("failed")
        expect(record!.reason).toContain("tollgate_invalid:exhausted")
    })
})

// --- run-record classification (T-4) ---

describe("runStatusFromReason: tollgate markers", () => {
    test("tollgate_complete is classified as completed", () => {
        expect(runStatusFromReason("tollgate_complete")).toBe("completed")
    })

    test("tollgate_failed:<producer> is classified as failed", () => {
        expect(runStatusFromReason("tollgate_failed:alice")).toBe("failed")
    })

    test("tollgate_invalid:<producer>:<reason> is classified as failed", () => {
        expect(runStatusFromReason("tollgate_invalid:alice:verifier_unavailable")).toBe("failed")
    })
})

describe("persisted run record: all-PASS is completed", () => {
    test("single-gate PASS persists a completed run record", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "verify",
            responses: { alice: "artifact", bob: V.pass },
        })
        const runId = task.runId!
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await handleTollgateIdle(ctx, team, idle(team, "bob"))

        const record = await readRunRecord(team.directory, runId)
        expect(record).not.toBeNull()
        expect(record!.type).toBe("tollgate")
        expect(record!.status).toBe("completed")
        expect(record!.reason).toBe("tollgate_complete")
    })
})

// --- startVerification / advanceToGatedStage (exported helpers) ---

describe("startVerification / advanceToGatedStage", () => {
    test("startVerification sets phase=verify and dispatches the verifier", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const g = gate({ member: "alice", verifier: "bob" })
        const task = makeTollgateTask({ gatedStages: [g], tollgatePhase: "produce" })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await startVerification(ctx, team, g)

        expect(task.tollgatePhase).toBe("verify")
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(true)
    })

    test("advanceToGatedStage dispatches the producer with its task", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const g = gate({ member: "alice", verifier: "bob", task: "produce flux core" })
        const task = makeTollgateTask({ gatedStages: [g], tollgatePhase: "produce" })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await advanceToGatedStage(ctx, team, g)

        const aliceCall = calls.find(c => c.sessionId === "ses_alice")
        expect(aliceCall).toBeDefined()
        expect(aliceCall!.text).toContain("produce flux core")
    })
})

// --- buildSummary: tollgate case ---

describe("buildSummary: tollgate case", () => {
    test("renders per-gate verdict rows and completed-gate outputs", async () => {
        const task = makeTollgateTask({
            gatedStages: [
                gate({ member: "alice", verifier: "bob", completed: true, verdict: "PASS" }),
                gate({ member: "dave", verifier: "eve", verdict: "FAIL", attempts: 2 }),
            ],
            responses: { alice: "flux output here" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice" }, { name: "bob" }, { name: "dave" }, { name: "eve" },
            ],
        })

        const summary = await buildSummary(team, task, "tollgate_failed:dave")

        expect(summary).toContain("<mode>tollgate</mode>")
        expect(summary).toContain("<reason>tollgate_failed:dave</reason>")
        expect(summary).toContain("[Gates]")
        // Gate 0: PASS, producer->verifier.
        expect(summary).toContain("[PASS] alice -> verified by bob")
        // Gate 1: FAIL with retry count.
        expect(summary).toContain("[FAIL] dave -> verified by eve")
        expect(summary).toContain("(2 retries)")
        // Completed gate's output is included.
        expect(summary).toContain("by alice:")
        expect(summary).toContain("flux output here")
    })
})

// =======================================================================
// Tool-level fixtures (disk-backed team state + master session indexing).
// teamTollgateTool validation and team_resume both flow through
// resolveCallerInTeam + loadTeamState, so they need real on-disk state and
// an indexed master session.
// =======================================================================

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})



function makeToolCtxWithCapture(root: string, calls: DispatchCall[]): PluginContext {
    return {
        storageRoot: root,
        scope: "project",
        directory: "/app",
        client: {
            session: {
                promptAsync: async (args: any) => {
                    calls.push({ sessionId: args.path.id, text: args.body.parts[0].text })
                    return { data: {} }
                },
            },
        },
    } as unknown as PluginContext
}

async function setupTollgateTeam(
    root: string,
    sid: string,
    members: MemberState[] = [
        makeMember("alice", "ses_alice"),
        makeMember("bob", "ses_bob"),
        makeMember("carol", "ses_carol"),
    ],
): Promise<void> {
    await initTeamState(root, makeState("alpha", sid, members, Date.now()), sid)
    await rebuildSessionIndex(root, `${root}__unused`)
}

// --- teamTollgateTool: input validation ---

describe("teamTollgateTool: input validation", () => {
    test("verifier equal to producer is rejected (no self-verification)", async () => {
        const root = tmpRoot("tg-val-selfverify")
        const sid = "ses_tg_val_selfverify"
        tracked.push(sid)
        await setupTollgateTeam(root, sid)
        const result = await teamTollgateTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                stages: [{ member: "alice", task: "do x", verifier: "alice", criteria: "ok" }],
            },
            makeToolContext(sid),
        )
        expect(result).toBe('Error: stage verifier "alice" must not equal its producer "alice"')
    })

    test("unknown member in a stage is rejected", async () => {
        const root = tmpRoot("tg-val-unknown")
        const sid = "ses_tg_val_unknown"
        tracked.push(sid)
        await setupTollgateTeam(root, sid)
        const result = await teamTollgateTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                stages: [
                    { member: "alice", task: "do x", verifier: "ghost", criteria: "ok" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toBe('Error: unknown member "ghost" in stages/escalate_to')
    })

    test("unknown escalate_to member is rejected", async () => {
        const root = tmpRoot("tg-val-badescalate")
        const sid = "ses_tg_val_badescalate"
        tracked.push(sid)
        await setupTollgateTeam(root, sid)
        const result = await teamTollgateTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                stages: [{ member: "alice", task: "do x", verifier: "bob", criteria: "ok" }],
                escalate_to: "ghost",
            },
            makeToolContext(sid),
        )
        expect(result).toBe('Error: unknown member "ghost" in stages/escalate_to')
    })

    test("non-master caller is rejected (master-only)", async () => {
        const root = tmpRoot("tg-val-nomaster")
        const masterSid = "ses_tg_m"
        const memberSid = "ses_tg_a"
        tracked.push(masterSid, memberSid)
        await setupTollgateTeam(root, masterSid, [
            makeMember("alice", memberSid),
            makeMember("bob", "ses_bob"),
        ])
        const result = await teamTollgateTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                // Valid verifier (!= member) so the self-verification check is
                // passed and the master-only gate is actually reached.
                stages: [{ member: "alice", task: "do x", verifier: "bob", criteria: "ok" }],
            },
            makeToolContext(memberSid),
        )
        expect(result).toContain("master-only")
    })

    test("already-busy team is rejected (single-active gate)", async () => {
        const root = tmpRoot("tg-val-busy")
        const sid = "ses_tg_val_busy"
        tracked.push(sid)
        await setupTollgateTeam(root, sid)
        // Put the team into a busy state with an active task.
        const team = await loadTeamState(root, "alpha", sid)
        await team.mutex.runExclusive(async () => {
            team.status = "busy"
            team.activeTask = makeTollgateTask({ gatedStages: [gate({ member: "alice", verifier: "bob" })] })
            await saveTeamState(team)
        })
        const result = await teamTollgateTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                stages: [{ member: "alice", task: "do x", verifier: "bob", criteria: "ok" }],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("already has an active orchestration")
    })

    test("signoff_policy 'decider' without signoff_decider is rejected", async () => {
        const root = tmpRoot("tg-val-nodecider")
        const sid = "ses_tg_val_nodecider"
        tracked.push(sid)
        await setupTollgateTeam(root, sid)
        const result = await teamTollgateTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                stages: [{ member: "alice", task: "do x", verifier: "bob", criteria: "ok" }],
                signoff_policy: "decider",
            },
            makeToolContext(sid),
        )
        expect(result).toBe(
            "Error: signoff_policy 'decider' requires signoff_decider (a member name)",
        )
    })
})

describe("teamTollgateTool: happy-path start", () => {
    test("valid start commits a tollgate task in produce phase and dispatches gate-0 producer", async () => {
        const root = tmpRoot("tg-start-ok")
        const sid = "ses_tg_start_ok"
        tracked.push(sid)
        await setupTollgateTeam(root, sid)
        const calls: DispatchCall[] = []
        const result = await teamTollgateTool(makeToolCtxWithCapture(root, calls)).execute(
            {
                team_id: "alpha",
                stages: [
                    { member: "alice", task: "produce flux", verifier: "bob", criteria: "tol 1e-4" },
                ],
                escalate_to: "carol",
                max_gate_retries: 1,
            },
            makeToolContext(sid),
        )

        expect(result).toBe('team_tollgate started on "alpha" with 1 gate(s).')
        // Only the stage-0 producer dispatched; verification starts on its idle.
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(true)
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(false)

        const team = await loadTeamState(root, "alpha", sid)
        expect(team.activeTask?.type).toBe("tollgate")
        const tgTask = team.activeTask as TollgateTask | undefined
        expect(tgTask?.tollgatePhase).toBe("produce")
        expect(tgTask?.escalateTo).toBe("carol")
        expect(tgTask?.maxGateRetries).toBe(1)
        expect(tgTask?.gatedStages).toHaveLength(1)
    })
})

// --- team_resume: tollgate three-phase recovery (T-5) ---
describe("team_resume: tollgate case", () => {
    test("verify phase with a captured PASS verdict re-runs the gate and completes", async () => {
        const root = tmpRoot("tg-resume-verify-deliver")
        const sid = "ses_tg_resume_v_deliver"
        tracked.push(sid)
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "verify",
            responses: { alice: "artifact", bob: V.pass },
        })
        const team = await setupFailedTeam(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ storageRoot: root, calls })

        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        expect(res).toContain("Resumed tollgate")
        // Captured verdict re-parsed -> tollgate_complete -> delivered to leader.
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        // loadTeamState sets team.leadSessionId = sid; delivery goes to sid.
        expect(calls.some(c => c.sessionId === sid)).toBe(true)
    })

    test("verify phase without a captured verdict re-dispatches the verifier", async () => {
        const root = tmpRoot("tg-resume-verify-redispatch")
        const sid = "ses_tg_resume_v_redispatch"
        tracked.push(sid)
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "verify",
            responses: { alice: "artifact" }, // no bob response yet
        })
        const team = await setupFailedTeam(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ storageRoot: root, calls })

        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        expect(res).toContain("Resumed tollgate")
        expect((team.activeTask as TollgateTask | undefined)?.tollgatePhase).toBe("verify")
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(true)
    })

    test("escalate phase re-dispatches the escalation handler", async () => {
        const root = tmpRoot("tg-resume-escalate")
        const sid = "ses_tg_resume_escalate"
        tracked.push(sid)
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "escalate",
            escalateTo: "carol",
            responses: { alice: "artifact", bob: V.invalid() },
        })
        const team = await setupFailedTeam(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
            makeMember("carol", "ses_carol"),
        ])
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ storageRoot: root, calls })

        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        expect(res).toContain("Resumed tollgate")
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(true)
        expect(team.activeTask ? (team.activeTask as TollgateTask).tollgatePhase : undefined).toBe("escalate")
    })

    test("escalate phase fails when the checkpoint escalation actor is missing", async () => {
        const root = tmpRoot("tg-resume-escalate-missing")
        const sid = "ses_tg_resume_escalate_missing"
        tracked.push(sid)
        const task = makeTollgateTask({
            gatedStages: [gate({ member: "alice", verifier: "bob" })],
            tollgatePhase: "escalate",
            escalateTo: "carol",
            responses: { alice: "artifact", bob: V.invalid() },
        })
        const team = await setupFailedTeam(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])

        await teamResumeTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const record = await readRunRecord(team.directory, task.runId!)
        expect(record?.reason).toBe("tollgate_resume_missing_escalation_actor")
    })

    test("produce phase re-dispatches the current gate's producer", async () => {
        const root = tmpRoot("tg-resume-produce")
        const sid = "ses_tg_resume_produce"
        tracked.push(sid)
        const task = makeTollgateTask({
            gatedStages: [
                gate({ member: "alice", verifier: "bob", task: "produce flux" }),
                gate({ member: "dave", verifier: "eve", completed: true }),
            ],
            currentStageIndex: 0,
            tollgatePhase: "produce",
        })
        await setupFailedTeam(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ storageRoot: root, calls })

        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        expect(res).toContain("Resumed tollgate")
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(true)
        const aliceCall = calls.find(c => c.sessionId === "ses_alice")
        expect(aliceCall!.text).toContain("produce flux")
    })
})

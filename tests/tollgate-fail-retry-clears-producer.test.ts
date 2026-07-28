/**
 * H43 (2026-07-28 audit): tollgate FAIL retry does not clear the stale
 * producer artifact before re-dispatch.
 *
 * Bug: handleTollgateIdle (tollgate.ts:298-311) on a FAIL verdict sets
 * tollgatePhase = "produce" and re-dispatches the producer with feedback,
 * but does NOT delete task.responses[stage.member]. The stale artifact
 * remains in the slot. A subsequent stale idle (or verifier reading the
 * slot) could re-evaluate the OLD failed artifact, incorrectly consuming
 * a retry attempt.
 *
 * Contrast: advanceToGatedStage:113 DOES delete task.responses[stage.member]
 * before re-dispatch (HIGH-D fix). The FAIL-retry path lacks the same
 * clearing. C17 (already fixed) added the same clearing to
 * startVerification for the verifier slot.
 *
 * Fix: delete task.responses[stage.member] before re-dispatching the
 * producer on FAIL retry, mirroring advanceToGatedStage.
 */
import { afterEach, describe, expect, test } from "bun:test"

import { handleTollgateIdle } from "../src/orchestration/modes/tollgate.js"
import type { GatedStage, MemberState, TollgateTask } from "../src/core/types.js"
import { initTeamState, saveTeamState, type Team } from "../src/state/store.js"
import { type DispatchCall, makeCtx, makeMember, makeState, makeTeam, tmpRoot } from './helpers.js'
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"

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

function idle(team: Team, name: string): MemberState {
    const m = team.members.find(x => x.name === name)
    if (!m) throw new Error(`no member ${name}`)
    m.status = "idle"
    return m
}

const V = {
    fail: (rationale = "off by 1e-3", diff = "|got-expected|_max=1.2e-3") =>
        `<verdict>{"result":"FAIL","rationale":"${rationale}","diff":"${diff}"}</verdict>`,
}

describe("H43: tollgate FAIL retry clears stale producer artifact", () => {
    const LEAD = "ses_h43_lead"
    let dispatches: DispatchCall[] = []

    afterEach(() => {
        dispatches.length = 0
        unindexSession(LEAD)
    })

    test("FAIL retry deletes responses[stage.member] before re-dispatch", async () => {
        const root = tmpRoot("h43-stale-producer")
        const alice = makeMember("alice", "ses_a")
        const bob = makeMember("bob", "ses_b")
        const stage = gate({ member: "alice", verifier: "bob" })
        const task = makeTollgateTask({
            gatedStages: [stage],
            tollgatePhase: "verify",
            maxGateRetries: 2,
            responses: { alice: "OLD_ARTIFACT", bob: V.fail() },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_a" },
                { name: "bob", sessionId: "ses_b" },
            ],
        })
        const ctx = makeCtx({ calls: dispatches })

        await team.mutex.runExclusive(async () => {
            await handleTollgateIdle(ctx, team, idle(team, "bob"))
            await saveTeamState(team)
        })

        // Producer was re-dispatched (FAIL retry).
        expect(dispatches.some(c => c.sessionId === "ses_a")).toBe(true)
        // tollgatePhase is back to produce.
        expect(task.tollgatePhase).toBe("produce")
        // H43: the stale producer artifact MUST be cleared.
        expect(task.responses["alice"]).toBeUndefined()
    })
})

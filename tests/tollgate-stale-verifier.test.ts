/**
 * C17 (2026-07-28 audit): tollgate startVerification does not clear the
 * verifier's stale response before dispatch, so a reused verifier (across
 * gates or after INVALID re-verify) can have its OLD verdict parsed as
 * the NEW gate's verdict.
 *
 * Bug: startVerification (tollgate.ts:78) sets tollgatePhase = "verify"
 * and dispatches the verifier, but never deletes
 * task.responses[stage.verifier]. The verify-phase idle handler at
 * tollgate.ts:248 then parses whatever is in that slot — if the verifier
 * was reused across gates (tollgate allows member reuse across
 * producer/verifier roles), the previous gate's verdict leaks in.
 *
 * Contrast: advanceToGatedStage:113 DOES delete task.responses[stage.member]
 * before re-dispatching the producer (HIGH-D fix). The verifier path lacks
 * the same clearing.
 *
 * Fix: startVerification must delete task.responses[stage.verifier] before
 * dispatch, mirroring the producer-side clearing in advanceToGatedStage.
 */
import { afterEach, describe, expect, test } from "bun:test"

import { getExpectedMember } from "../src/orchestration/lifecycle/idle.js"
import { advanceToGatedStage, handleTollgateIdle, startVerification } from "../src/orchestration/modes/tollgate.js"
import type { GatedStage, MemberState, TollgateTask } from "../src/core/types.js"
import { initTeamState, loadTeamState, saveTeamState, type Team } from "../src/state/store.js"

import type { PluginContext } from "../src/core/context.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { type DispatchCall, makeCtx, makeMember, makeState, makeTeam, makeToolContext, tmpRoot } from './helpers.js'

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

const V = {
    pass: '<verdict>{"result":"PASS","rationale":"within tolerance","diff":""}</verdict>',
}

describe("C17: startVerification clears stale verifier response", () => {
    const LEAD = "ses_c17_lead"
    let dispatches: DispatchCall[] = []
    let ctx: PluginContext

    afterEach(() => {
        dispatches.length = 0
        unindexSession(LEAD)
    })

    test("startVerification deletes responses[stage.verifier] before dispatch", async () => {
        dispatches = []
        ctx = makeCtx({ calls: dispatches })
        const root = tmpRoot("c17-stale-verifier")
        const alice = makeMember("alice", "ses_a")
        const bob = makeMember("bob", "ses_b")
        const stage = gate({ member: "alice", verifier: "bob" })
        const team = await initTeamState(
            root,
            makeState("c17-team", LEAD, [alice, bob], Date.now()),
            LEAD,
        )
        // Simulate a stale verdict from a previous gate (bob reused across gates).
        team.activeTask = makeTollgateTask({ gatedStages: [stage], tollgatePhase: "produce" })
        team.activeTask.responses["bob"] = V.pass

        await team.mutex.runExclusive(async () => {
            await startVerification(ctx, team, stage)
            await saveTeamState(team)
        })

        // On UNFIXED code: responses["bob"] still holds the stale PASS.
        // On FIXED code: startVerification deleted it before dispatch.
        expect(team.activeTask?.responses["bob"]).toBeUndefined()
        // Verifier was dispatched.
        expect(dispatches.some(d => d.sessionId === "ses_b")).toBe(true)
    })
})

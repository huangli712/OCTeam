/**
 * H44 (2026-07-28 audit): tollgate INVALID approval can't express "retry
 * verification".
 *
 * Bug: tollgate.ts:189-204 when no escalateTo handler is configured, creates
 * a `tollgate_gate` approval with summary "Approve to retry verification".
 * But approve.ts:128-141 resumes `tollgate_gate` by checking
 * `task.tollgatePhase === "produce"` — at INVALID time the phase is still
 * "verify", so it falls through to `advanceTollgateAfterPass` (post-PASS
 * advance), which incorrectly advances to the next gate instead of
 * re-verifying the current gate.
 *
 * Fix: approve.ts tollgate_gate resume must handle `tollgatePhase === "verify"`
 * by calling startVerification to re-verify the current gate, matching the
 * approval summary's "retry verification" semantics.
 */
import { afterEach, describe, expect, test } from "bun:test"

import { applyApprovalDecision } from "../src/tools/control/approve.js"
import type { GatedStage, TollgateTask } from "../src/core/types.js"
import { initTeamState, saveTeamState } from "../src/state/store.js"
import { type DispatchCall, makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"
import { unindexSession } from "../src/state/resolve.js"

function gate(opts: Partial<GatedStage> & Pick<GatedStage, "member" | "verifier">): GatedStage {
    return {
        member: opts.member,
        verifier: opts.verifier,
        task: opts.task ?? "produce the artifact",
        completed: opts.completed ?? false,
        criteria: opts.criteria ?? "ok",
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

describe("H44: tollgate INVALID approval retries verification (not advances)", () => {
    const LEAD = "ses_h44_lead"
    let dispatches: DispatchCall[] = []

    afterEach(() => {
        dispatches.length = 0
        unindexSession(LEAD)
    })

    test("approve INVALID-retry → re-dispatches verifier (NOT advance to next gate)", async () => {
        const root = tmpRoot("h44-invalid-retry")
        const alice = makeMember("alice", "ses_a")
        const bob = makeMember("bob", "ses_b")
        const stages: GatedStage[] = [
            gate({ member: "alice", verifier: "bob" }),
            gate({ member: "carol", verifier: "dave", completed: false }),
        ]
        // Task is at stage 0, verify phase, with a pending INVALID-retry approval.
        const task = makeTollgateTask({
            gatedStages: stages,
            tollgatePhase: "verify",
            currentStageIndex: 0,
            // Simulate the approval state set by tollgate.ts:194-198.
            approvalStage: {} as TollgateTask["approvalStage"],
            approvalRequest: {
                id: "h44-approval",
                kind: "tollgate_gate",
                stage: 0,
                summary: "Gate INVALID ... Approve to retry verification.",
                requestedAt: Date.now(),
            },
        })
        const ctx = makeCtx({ calls: dispatches })
        const team = await initTeamState(
            root,
            makeState("h44-team", LEAD, [alice, bob, makeMember("carol", "ses_c"), makeMember("dave", "ses_d")], Date.now()),
            LEAD,
        )
        team.activeTask = task
        team.status = "busy"

        await team.mutex.runExclusive(async () => {
            await applyApprovalDecision(ctx, team, { approved: true })
            await saveTeamState(team)
        })

        // On UNFIXED code: approve.ts falls through to advanceTollgateAfterPass
        // → currentStageIndex moves to 1 (carol's gate), stage 0 un-verified.
        // On FIXED code: startVerification re-dispatches bob (verifier) for
        // stage 0; currentStageIndex stays at 0.
        expect(task.currentStageIndex).toBe(0)
        expect(task.tollgatePhase).toBe("verify")
        // Verifier (bob) should have been re-dispatched, NOT carol (next gate producer).
        expect(dispatches.some(d => d.sessionId === "ses_b")).toBe(true)
    })
})

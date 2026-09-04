/**
 * Regression: handleGatePass must NOT mark the gate as completed before
 * evaluating the `where` condition. When `where.score_gte` is unevaluable
 * (verifier emitted PASS but omitted the required score field), the gate
 * routes to handleInvalidVerdict which re-dispatches the verifier (per
 * on_invalid='retry_verifier'). Pre-fix the gate was already marked completed,
 * so the idle router skipped it on retry → the verifier's fresh response was
 * never processed → the run deadlocked until wall-clock timeout.
 *
 * The fix moves resetStepAfterCompletion({completed:true}) AFTER the where
 * check. The gate is only marked completed when it is truly settling.
 */
import { describe, expect, test } from "bun:test"

import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import type { WorkflowGateStep, WorkflowStep } from "../src/core/types.js"
import { makeCtx, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js"

function gateStepAt(steps: readonly WorkflowStep[] | undefined, index: number): WorkflowGateStep {
    const step = steps?.[index]
    if (step?.kind !== "gate") throw new Error(`Expected gate step at index ${index}`)
    return step
}

describe("PASS-with-unevaluable-where does not deadlock on retry_verifier", () => {
    test("gate is NOT marked completed when where is unevaluable, so the retry idle still processes", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", id: "t1", member: "alice", task: "do work", completed: true, output: "alice output" },
                {
                    kind: "gate",
                    id: "g1",
                    verifier: "bob",
                    criteria: "passes tests",
                    onFail: "fail",
                    onInvalid: "retry_verifier",
                    maxInvalidRetries: 2,
                    invalidAttempts: 0,
                    // where requires score and on_pass_goto for where to fire;
                    // verifier's PASS omits score → unevaluable → INVALID retry.
                    where: { kind: "score_gte", value: 7 },
                    onPassGoto: 0,
                    completed: false,
                    // Pre-dispatched state so processIdle treats this as a verifier turn.
                    dispatchedAt: Date.now(),
                    dispatchedActor: "bob",
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice output" },
            activeStepIndices: [1],
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        // PASS verdict without score → where.score_gte unevaluable → INVALID path.
        const ctx = makeCtx({
            outputs: { ses_bob: '<verdict>{"result":"PASS","rationale":"looks ok"}</verdict>' },
            calls,
        })

        await processIdle(ctx, team, team.members[1], "ses_bob")

        // The gate MUST NOT be marked completed (the INVALID retry path needs
        // the idle router to process the verifier's next response).
        const gate = gateStepAt(task.steps, 1)
        expect(gate.completed).toBe(false)
        // The verifier MUST have been re-dispatched with the retry nudge.
        const redispatch = calls.find(c => c.sessionId === "ses_bob")
        expect(redispatch).toBeDefined()
        expect(redispatch!.text).toMatch(/re-evaluate|invalid|INVALID|could not be evaluated/i)
        // Invalid attempts counter MUST have incremented.
        expect(gate.invalidAttempts).toBe(1)
    })
})

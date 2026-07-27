/**
 * Regression test for H-1: backward jump must reset retry counters on the
 * TRIGGERING gate (not just intermediate gates).
 *
 * Bug: src/orchestration/workflow/engine.ts applyJump (line 500) gates the
 * counter reset on `if (i !== gateIndex)` — the triggering gate is skipped
 * when zeroing attempts/invalidAttempts/malformedAttempts/timeoutAttempts.
 * After a backward jump, the triggering gate re-runs, but it INHERITS the
 * exhausted retry budget from the previous cycle. A gate configured with
 * `on_fail: retry, max_retries: 1` that already used its retry on the prior
 * pass will fail immediately on the re-run, defeating the purpose of the
 * backward jump (which is to give the path another chance).
 *
 * Fix: drop the `i !== gateIndex` guard so all re-entered gates — including
 * the triggering one — reset their retry counters. jumpCount (which bounds
 * the OUTER loop) is preserved by being incremented before this reset block
 * and not touched inside it, so the loop-cap protection is retained.
 */

import { afterAll, describe, expect, test } from "bun:test"

import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import type { WorkflowGateStep, WorkflowStep } from "../src/core/types.js"
import { cleanupTmpRoots, makeCtx, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js"

function gateStepAt(steps: readonly WorkflowStep[] | undefined, index: number): WorkflowGateStep {
    const step = steps?.[index]
    if (step?.kind !== "gate") throw new Error(`Expected gate step at index ${index}`)
    return step
}

afterAll(cleanupTmpRoots)

const FAIL_VERDICT =
    '<verdict>{"result":"FAIL","rationale":"wrong","diff":"off by one"}</verdict>'

describe("H-1: backward jump resets triggering gate retry counters", () => {
    test("triggering gate's attempts/invalidAttempts/malformedAttempts/timeoutAttempts are zeroed after backward jump", async () => {
        const calls: DispatchCall[] = []
        // Two-step workflow: task → gate with on_fail_goto back to step 0.
        // The gate has accumulated retry budget from a prior cycle.
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "impl",
                    completed: true,
                    output: "first impl",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "ok",
                    onFail: "fail",
                    onFailGoto: 0, // backward jump to step 0
                    jumpCount: 0,
                    completed: false,
                    // Pre-existing exhausted budget from earlier in this run.
                    // The H-1 bug: these are NOT reset for the triggering gate,
                    // so the re-run inherits the exhausted budget.
                    attempts: 2,
                    invalidAttempts: 1,
                    malformedAttempts: 1,
                    timeoutAttempts: 1,
                    maxRetries: 1,
                    maxInvalidRetries: 1,
                    maxMalformedRetries: 1,
                    maxTimeoutRetries: 1,
                },
            ],
            currentStageIndex: 1,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ outputs: { ses_bob: FAIL_VERDICT }, calls: calls })

        await processIdle(ctx, team, team.members[1], "ses_bob")

        // The backward jump happened.
        expect(gateStepAt(task.steps, 1).jumpCount).toBe(1)
        expect(task.currentStageIndex).toBe(0)

        // H-1 fix: the triggering gate's retry counters MUST be reset so the
        // re-run gets a fresh budget. Pre-fix: they stayed at 2/1/1/1.
        const gate = gateStepAt(task.steps, 1)
        expect(gate.attempts).toBe(0)
        expect(gate.invalidAttempts).toBe(0)
        expect(gate.malformedAttempts).toBe(0)
        expect(gate.timeoutAttempts).toBe(0)
    })

    test("control: intermediate gate counters are still reset (preserves prior fix)", async () => {
        // Three-step workflow: gate0 → task → gate1, with gate1 jumping back
        // to step 0. gate0 is an INTERMEDIATE gate (not the trigger) and must
        // also have its counters reset (the prior fix covered this case).
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "gate",
                    verifier: "alice",
                    criteria: "first gate",
                    completed: true,
                    attempts: 3,
                    invalidAttempts: 2,
                    malformedAttempts: 0,
                    timeoutAttempts: 0,
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "impl",
                    completed: true,
                    output: "impl",
                },
                {
                    kind: "gate",
                    verifier: "carol",
                    criteria: "second gate",
                    onFail: "fail",
                    onFailGoto: 0,
                    jumpCount: 0,
                    completed: false,
                    attempts: 1,
                },
            ],
            currentStageIndex: 2,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        })
        const ctx = makeCtx({ outputs: { ses_carol: FAIL_VERDICT }, calls: calls })

        await processIdle(ctx, team, team.members[2], "ses_carol")

        expect(task.currentStageIndex).toBe(0)
        // Intermediate gate (step 0) reset.
        const intermediateGate = gateStepAt(task.steps, 0)
        expect(intermediateGate.attempts).toBe(0)
        expect(intermediateGate.invalidAttempts).toBe(0)
        // Triggering gate (step 2) also reset (H-1 fix).
        const triggeringGate = gateStepAt(task.steps, 2)
        expect(triggeringGate.attempts).toBe(0)
    })
})

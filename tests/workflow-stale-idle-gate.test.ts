/**
 * H-8 regression: stale idle guard must cover gate steps too. Pre-fix the
 * guard ran only for task steps; a gate step with step.output already set
 * (from a prior verifier PASS) could be re-processed on a stale idle
 * (capturedNew=false), double-counting the verdict or routing to
 * on_malformed/parse_failure on the same already-consumed output.
 *
 * Ensemble gates accumulate verifier outputs into step.output, so the same
 * double-processing risk applies — the fix extends the guard to gate steps.
 */
import { describe, expect, test } from "bun:test"

import { handleWorkflowIdle } from "../src/orchestration/workflow/handler.js"
import type { WorkflowGateStep, WorkflowStep } from "../src/core/types.js"
import { makeCtx, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js"

function gateStepAt(steps: readonly WorkflowStep[] | undefined, index: number): WorkflowGateStep {
    const step = steps?.[index]
    if (step?.kind !== "gate") throw new Error(`Expected gate step at index ${index}`)
    return step
}

describe("H-8: stale idle guard covers gate steps", () => {
    test("gate idle with capturedNew=false and step.output already set is a no-op", async () => {
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
                    completed: false,
                    // Pre-set output to mimic a prior verifier turn that was
                    // captured but not yet cleared (e.g. ensemble gatekeeping).
                    output: '<verdict>{"result":"PASS","rationale":"ok"}</verdict>',
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
        const ctx = makeCtx({ calls })

        // Stale idle: capturedNew=false (no new content since the last capture).
        await handleWorkflowIdle(ctx, team, team.members[1], false)

        // The gate MUST NOT have been advanced / completed by the stale idle.
        const gate = gateStepAt(task.steps, 1)
        expect(gate.completed).toBe(false)
        // No dispatch should have fired from the stale idle.
        expect(calls).toHaveLength(0)
    })

    test("control: fresh gate idle (capturedNew=true) still processes normally", async () => {
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
                    completed: false,
                    dispatchedAt: Date.now(),
                    dispatchedActor: "bob",
                },
            ],
            currentStageIndex: 1,
            // Pre-populate bob's response so handleGateVerdict can read the
            // verdict without requiring the full capture path.
            responses: {
                alice: "alice output",
                bob: '<verdict>{"result":"PASS","rationale":"fresh ok"}</verdict>',
            },
            activeStepIndices: [1],
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ calls })

        await handleWorkflowIdle(ctx, team, team.members[1], true)

        // Fresh idle processes the verdict — gate completed, run advances.
        const gate = gateStepAt(task.steps, 1)
        expect(gate.completed).toBe(true)
    })
})

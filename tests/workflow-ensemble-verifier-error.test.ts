/**
 * Regression test for H-7: a fanout ensemble gate's branch can be correctly
 * re-identified as already-errored when ANY of its verifiers errors out,
 * not just the first verifier in the list.
 *
 * Bug: src/orchestration/workflow/fanout.ts recordedErroredBranchForMember
 * used `workflowStepActorName(step) === memberName` to find a branch already
 * marked errored for a given member. For ensemble gates, workflowStepActorName
 * returns the FIRST verifier only. When a SECOND verifier in the same branch
 * errors out (e.g. crashed mid-verification), the lookup fails → returns null →
 * markWorkflowFanoutBranchErrored returns "not_fanout" → the caller treats
 * this as a non-fanout error and may terminate the workflow incorrectly.
 *
 * Fix: the lookup now also checks if memberName appears in step.verifiers (the
 * ensemble list), so any verifier's error can rediscover the already-errored
 * branch and the workflow degrades gracefully.
 */

import { describe, expect, test } from "bun:test"

import { markWorkflowFanoutBranchErrored } from "../src/orchestration/workflow/fanout.js"
import type { WorkflowStep, WorkflowTask } from "../src/core/types.js"

function makeEnsembleFanoutTask(): WorkflowTask {
    const steps: WorkflowStep[] = [
        { kind: "fanout" } as WorkflowStep,
        // Branch A: ensemble gate with verifiers [v1, v2]
        {
            kind: "gate",
            verifiers: ["v1", "v2"],
            criteria: "test",
            branch: { fanoutIndex: 0, branchId: "A", joinIndex: 3 },
            dispatchedActor: "v1",
        } as WorkflowStep,
        // Branch B: simple task
        {
            kind: "task",
            member: "alice",
            task: "b",
            branch: { fanoutIndex: 0, branchId: "B", joinIndex: 3 },
        } as WorkflowStep,
        // Join
        {
            kind: "join",
            join: {
                fanoutIndex: 0,
                joinPolicy: "all",
                branchTailIndices: [1, 2],
                maxErrored: 0,
            },
        } as WorkflowStep,
    ]
    return {
        type: "workflow",
        runId: "r1",
        mode: "workflow",
        steps,
        currentStageIndex: 1,
        activeStepIndices: [1, 2],
        responses: {},
    } as unknown as WorkflowTask
}

describe("H-7: ensemble verifier error finds already-errored branch via any verifier", () => {
    test("first verifier error marks branch A errored", () => {
        const task = makeEnsembleFanoutTask()
        // v1 errors out first.
        const result = markWorkflowFanoutBranchErrored(task, "v1")
        // With "all" policy and maxErrored=0, the first error fails the join.
        expect(result.kind === "failed" || result.kind === "degraded").toBe(true)
        // Branch A is recorded as errored.
        const join = task.steps![3]
        if (join.kind === "join") {
            expect(join.join?.erroredBranchIds).toContain("A")
        }
    })

    test("second verifier error (v2) still finds branch A errored, does not return not_fanout", () => {
        const task = makeEnsembleFanoutTask()
        // First: v1 errors → marks branch A errored.
        markWorkflowFanoutBranchErrored(task, "v1")
        // Second: v2 errors (same branch). Pre-fix: returns not_fanout
        // because workflowStepActorName only returns v1. Post-fix: finds
        // branch A via the verifiers list.
        const result = markWorkflowFanoutBranchErrored(task, "v2")
        // Should NOT return not_fanout (which would let the caller mishandle).
        expect(result.kind).not.toBe("not_fanout")
    })

    test("control: unrelated member still returns not_fanout", () => {
        const task = makeEnsembleFanoutTask()
        const result = markWorkflowFanoutBranchErrored(task, "unknown-member")
        expect(result.kind).toBe("not_fanout")
    })
})

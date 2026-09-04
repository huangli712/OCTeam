/**
 * Regression test: any_success join policy must open the join as soon
 * as ONE branch succeeds, rather than waiting for all branches to reach
 * terminal state.
 *
 * Bug: src/orchestration/workflow/dag.ts isJoinMetadataSatisfied requires
 * every branch tail to be terminal before evaluating the policy (line 284:
 * `if (!isTerminalWorkflowStep(tail)) return false`). For any_success, this
 * defeats the policy's purpose — remaining branches can hang until global
 * timeout even though the join is already satisfiable.
 *
 * Fix: when joinPolicy is "any_success", evaluate early — if at least one
 * branch is terminal+successful, mark remaining non-terminal branches as
 * skipped and treat the join as satisfied.
 */

import { describe, expect, test } from "bun:test"

import { isWorkflowJoinSatisfied } from "../src/orchestration/workflow/dag.js"
import type { WorkflowStep } from "../src/core/types.js"

function makeSteps(): WorkflowStep[] {
    return [
        { kind: "fanout" } as WorkflowStep,
        // branch A (success)
        { kind: "task", member: "alice", task: "a", completed: true, branch: { fanoutIndex: 0, branchId: "A" } } as WorkflowStep,
        // branch B (still running — NOT terminal)
        { kind: "task", member: "bob", task: "b", completed: false, branch: { fanoutIndex: 0, branchId: "B" } } as WorkflowStep,
        // join
        {
            kind: "join",
            join: {
                fanoutIndex: 0,
                joinPolicy: "any_success",
                branchTailIndices: [1, 2],
            },
        } as unknown as WorkflowStep,
    ]
}

describe("any_success join opens on first success", () => {
    test("any_success: join is ready when ONE branch succeeds (other still running)", () => {
        const steps = makeSteps()
        // Step 1 (alice) is completed; step 2 (bob) is still running.
        // any_success should be satisfied by alice alone.
        const joinStep = steps[3]
        const ready = isWorkflowJoinSatisfied(steps, joinStep)
        expect(ready).toBe(true)
    })

    test("any_success: after early-open, the remaining branch is marked skipped", () => {
        const steps = makeSteps()
        isWorkflowJoinSatisfied(steps, steps[3])
        // The still-running branch B should be marked as skipped so it does
        // not block dispatch or produce a confusing late result.
        expect(steps[2].skipped).toBe(true)
        expect(steps[2].completed).toBe(true)
    })

    test("control: 'all' policy still requires every branch terminal", () => {
        const steps = makeSteps()
        // Switch to "all" policy.
        ;(steps[3] as { join: { joinPolicy: string } }).join.joinPolicy = "all"
        const ready = isWorkflowJoinSatisfied(steps, steps[3])
        expect(ready).toBe(false)
        // bob's branch is NOT skipped under "all".
        expect(steps[2].skipped).not.toBe(true)
    })

    test("control: any_success with NO successes yet is NOT ready", () => {
        const steps: WorkflowStep[] = [
            { kind: "fanout" } as WorkflowStep,
            { kind: "task", member: "alice", task: "a", completed: false, branch: { fanoutIndex: 0, branchId: "A" } } as WorkflowStep,
            { kind: "task", member: "bob", task: "b", completed: false, branch: { fanoutIndex: 0, branchId: "B" } } as WorkflowStep,
            {
                kind: "join",
                join: { fanoutIndex: 0, joinPolicy: "any_success", branchTailIndices: [1, 2] },
            } as unknown as WorkflowStep,
        ]
        const ready = isWorkflowJoinSatisfied(steps, steps[3])
        expect(ready).toBe(false)
    })

    test("control: any_success with only errored branches is NOT ready (no successes)", () => {
        const steps: WorkflowStep[] = [
            { kind: "fanout" } as WorkflowStep,
            { kind: "task", member: "alice", task: "a", completed: true, branch: { fanoutIndex: 0, branchId: "A" } } as WorkflowStep,
            { kind: "task", member: "bob", task: "b", completed: true, branch: { fanoutIndex: 0, branchId: "B" } } as WorkflowStep,
            {
                kind: "join",
                join: {
                    fanoutIndex: 0,
                    joinPolicy: "any_success",
                    branchTailIndices: [1, 2],
                    erroredBranchIds: ["A", "B"],
                },
            } as unknown as WorkflowStep,
        ]
        const ready = isWorkflowJoinSatisfied(steps, steps[3])
        expect(ready).toBe(false)
    })
})

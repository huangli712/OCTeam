/**
 * Gate target resolution lives separately to avoid a cycle among dag.ts,
 * invariants.ts, and gate.ts. These pure functions have no dependency on other
 * workflow modules; the branch check is local to keep the graph acyclic.
 */

import type { WorkflowStep } from "../../core/types.js"

/** Check whether a step belongs to the same fanout branch as the given metadata.
 * Defined locally to avoid a cycle through dag.ts and invariants.ts. */
function isSameWorkflowBranch(
    step: WorkflowStep,
    branch: NonNullable<WorkflowStep["branch"]>,
): boolean {
    const stepBranch = step.branch
    return stepBranch !== undefined
        && stepBranch.fanoutIndex === branch.fanoutIndex
        && stepBranch.branchId === branch.branchId
}

/** Check whether a gate can reference a given task or join step (same-branch check). */
function canGateReferenceTask(
    steps: readonly WorkflowStep[],
    gateIndex: number,
    targetIndex: number,
): boolean {
    const gate = steps[gateIndex]
    const target = steps[targetIndex]
    if (gate?.kind !== "gate") return false
    // join is always top-level (no branch) and carries joinedOutput; allow it.
    if (target?.kind === "join") return true
    if (target?.kind !== "task") return false

    const gateBranch = gate.branch
    if (gateBranch === undefined) return target.branch === undefined
    return isSameWorkflowBranch(target, gateBranch)
}

/**
 * Find the nearest preceding TASK step index for a gate. Returns -1 when none.
 */
/** Scan backward from gateIndex for the nearest preceding task step. */
export function precedingTaskIndex(steps: readonly WorkflowStep[], gateIndex: number): number {
    for (let i = gateIndex - 1; i >= 0; i--) {
        if (canGateReferenceTask(steps, gateIndex, i)) return i
    }
    return -1
}

/** Return the single target task index for a gate (first of multi-target if present). */
export function gateTargetIndex(steps: readonly WorkflowStep[], gateIndex: number): number {
    const targets = gateTargetIndices(steps, gateIndex)
    return targets[0] ?? -1
}

/** Return all target task indices a gate verifies (explicit or inferred). */
export function gateTargetIndices(steps: readonly WorkflowStep[], gateIndex: number): number[] {
    const gate = steps[gateIndex]
    if (gate?.kind !== "gate") return []
    if (
        gate.targetStepIndices !== undefined &&
        gate.targetStepIndices.length > 0
    ) {
        return gate.targetStepIndices
            .filter((targetIndex) =>
                canGateReferenceTask(steps, gateIndex, targetIndex),
            )
            .sort((a, b) => a - b)
    }
    if (gate.targetStepIndex !== undefined) {
        return canGateReferenceTask(steps, gateIndex, gate.targetStepIndex)
            ? [gate.targetStepIndex]
            : []
    }
    const nearest = precedingTaskIndex(steps, gateIndex)
    return nearest < 0 ? [] : [nearest]
}

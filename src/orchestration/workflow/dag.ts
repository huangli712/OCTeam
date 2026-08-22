/**
 * Workflow DAG traversal: step actor resolution, ready-set calculation,
 * join satisfaction, fanout validation, and branch identity helpers.
 */

import type {
    WorkflowFanoutStep,
    WorkflowJoinMetadata,
    WorkflowStep,
    WorkflowTask,
} from "../../core/types.js"
//
import { joinPolicySatisfied } from "./join-policy.js"
import { includesWorkflowIndex } from "./invariants.js"

/** Outcome of validateWorkflowDag: either ok or a reason string. */
export type WorkflowDagValidationResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string }

/** Thrown when a workflow step kind exhausts the never type (compile-time invariant). */
export class WorkflowDagInvariantError extends Error {
    constructor(value: never) {
        super(`Unexpected workflow step kind: ${String(value)}`)
        this.name = "WorkflowDagInvariantError"
    }
}

/** Exhaustive-switch guard for WorkflowStepKind. Throws at runtime only if the type system is bypassed. */
export function assertNeverWorkflowStepKind(value: never): never {
    throw new WorkflowDagInvariantError(value)
}

/** Sort workflow step indices ascending. */
export function sortedWorkflowIndices(indices: readonly number[]): number[] {
    return [...indices].sort((left, right) => left - right)
}

/** Push an index to the list if not already present. */
function pushUniqueWorkflowIndex(indices: number[], index: number): void {
    if (!indices.includes(index)) indices.push(index)
}

/** Record an unavailable ensemble verifier as a producer-neutral INVALID vote. */
export function recordUnavailableEnsembleVerifier(
    step: WorkflowStep | undefined,
    verifierName: string,
): boolean {
    if (
        step?.kind !== "gate"
        || step.verifiers?.includes(verifierName) !== true
        || step.ensembleResults?.[verifierName] !== undefined
    ) {
        return false
    }
    if (step.ensembleResults === undefined) step.ensembleResults = {}
    step.ensembleResults[verifierName] = {
        verdict: "INVALID",
        score: undefined,
        confidence: undefined,
        issues: undefined,
        rationale: "verifier unavailable",
        diff: undefined,
        parseFailed: false,
    }
    return true
}

/** Find the active step index a member is dispatched to, or null if none. */
export function findActiveWorkflowStepIndexForMember(
    task: Pick<WorkflowTask, "activeStepIndices" | "currentStageIndex" | "steps">,
    memberName: string,
): number | null {
    const steps = task.steps ?? []

    for (const index of getActiveWorkflowStepIndices(task)) {
        const step = steps[index]
        if (step === undefined || step.completed) continue
        // ensemble gate: check if member is one of the verifiers with pending results
        if (step.kind === "gate" && step.verifiers !== undefined) {
            if (step.verifiers.includes(memberName) && step.ensembleResults?.[memberName] === undefined) {
                return index
            }
            continue
        }
        if (workflowStepActor(step) === memberName) return index
    }
    return null
}

/** Collect step indices whose actors are ready (not yet completed). */
export function readyWorkflowStepIndices(
    task: Pick<WorkflowTask, "activeStepIndices" | "currentStageIndex" | "steps">,
): readonly number[] {
    const steps = task.steps ?? []
    const ready: number[] = []

    for (const index of getActiveWorkflowStepIndices(task)) {
        // A visited set guards against corrupted branch metadata forming
        // a cycle. collectReadyWorkflowStepIndices and collectWorkflowSuccessors
        // recurse into each other; without this guard a tampered joinIndex or
        // branch range that loops back could cause a stack overflow.
        const visited = new Set<number>()
        collectReadyWorkflowStepIndices(steps, index, ready, visited)
    }

    return ready
}

/** Validate that the workflow step list contains no recursive fanout. */
export function validateWorkflowDag(steps: readonly WorkflowStep[]): WorkflowDagValidationResult {
    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]
        if (step === undefined) continue

        switch (step.kind) {
            case "fanout":
                if (isInsideAnotherFanout(steps, index)) {
                    return { ok: false, reason: `recursive_fanout:${index}` }
                }
                break
            case "task":
            case "gate":
            case "join":
                break
            default:
                assertNeverWorkflowStepKind(step)
        }
    }

    return { ok: true }
}

/** Extract the start index of each branch in a fanout step. */
function fanoutBranchHeadIndices(step: WorkflowFanoutStep): readonly number[] {
    const fanout = step.fanout
    if (fanout === undefined) return []

    return fanout.branchRanges.map(range => range.startIndex)
}

/** Return the set of step indices currently active for dispatch. */
export function getActiveWorkflowStepIndices(
    task: Pick<WorkflowTask, "activeStepIndices" | "currentStageIndex">,
): readonly number[] {
    return task.activeStepIndices ?? [task.currentStageIndex]
}

/** Collect non-null actor names for all active workflow steps. */
export function getActiveWorkflowStepActors(
    task: Pick<WorkflowTask, "activeStepIndices" | "currentStageIndex" | "steps">,
): readonly string[] {
    const steps = task.steps ?? []
    const actors: string[] = []

    for (const index of getActiveWorkflowStepIndices(task)) {
        const step = steps[index]
        if (step === undefined) continue
        // Ensemble gates have multiple verifiers — include ALL of them so
        // termination's error-tolerance check sees every active verifier.
        if (step.kind === "gate" && step.verifiers !== undefined) {
            for (const v of step.verifiers) {
                if (step.ensembleResults?.[v] === undefined) actors.push(v)
            }
            continue
        }
        const actor = workflowStepActor(step)
        if (actor !== null) actors.push(actor)
    }

    return actors
}

/** Resolve the dispatched or primary actor name for a workflow step. */
export function workflowStepActor(step: WorkflowStep | undefined): string | null {
    if (step === undefined) return null

    switch (step.kind) {
        case "task":
            return step.dispatchedActor ?? step.member ?? null
        case "gate":
            return step.dispatchedActor ?? step.verifier ?? null
        case "join":
            return step.dispatchedAt === undefined
                || (step.join?.joinPolicy !== "reduce"
                    && step.join?.joinPolicy !== "select")
                ? null
                : step.dispatchedActor ?? step.join?.reducerMember ?? null
        case "fanout":
            return null
        default:
            return assertNeverWorkflowStepKind(step)
    }
}

/** Resolve the dispatched or primary actor name for a step. */
export function workflowStepActorName(step: WorkflowStep): string | undefined {
    switch (step.kind) {
        case "task":
            return step.dispatchedActor ?? step.member
        case "gate":
            return step.dispatchedActor ?? step.verifier
        case "join":
            return step.dispatchedActor
        case "fanout":
            return undefined
        default:
            throw new WorkflowDagInvariantError(step)
    }
}

/** Recursively collect indices of ready (unblocked, not completed) workflow steps. */
function collectReadyWorkflowStepIndices(
    steps: readonly WorkflowStep[],
    index: number,
    ready: number[],
    visited: Set<number>,
): void {
    // Stop recursing if corrupted metadata returns to an index already visited
    // during this traversal.
    if (visited.has(index)) return
    visited.add(index)
    const step = steps[index]
    if (step === undefined) return

    switch (step.kind) {
        case "task":
        case "gate":
            if (!step.completed) {
                pushUniqueWorkflowIndex(ready, index)
                return
            }
            collectWorkflowSuccessors(steps, index, ready, visited)
            return
        case "fanout":
            for (const branchHeadIndex of fanoutBranchHeadIndices(step)) {
                collectReadyWorkflowStepIndices(steps, branchHeadIndex, ready, visited)
            }
            return
        case "join":
            if (!step.completed) {
                if (isWorkflowJoinSatisfied(steps, step)) pushUniqueWorkflowIndex(ready, index)
                return
            }
            collectWorkflowSuccessors(steps, index, ready, visited)
            return
        default:
            assertNeverWorkflowStepKind(step)
    }
}

/** Collect successor step indices from a completed step, respecting branch boundaries. */
function collectWorkflowSuccessors(
    steps: readonly WorkflowStep[],
    index: number,
    ready: number[],
    visited: Set<number>,
): void {
    const step = steps[index]
    if (step === undefined) return

    const branch = step.branch
    if (branch !== undefined) {
        const nextBranchIndex = index + 1
        const nextBranchStep = steps[nextBranchIndex]
        if (nextBranchStep !== undefined && isSameWorkflowBranch(nextBranchStep, branch)) {
            collectReadyWorkflowStepIndices(steps, nextBranchIndex, ready, visited)
            return
        }
        collectReadyWorkflowStepIndices(steps, branch.joinIndex, ready, visited)
        return
    }

    collectReadyWorkflowStepIndices(steps, index + 1, ready, visited)
}

/** Check whether a step belongs to the same fanout branch as the given metadata. */
export function isSameWorkflowBranch(
    step: WorkflowStep,
    branch: NonNullable<WorkflowStep["branch"]>,
): boolean {
    const stepBranch = step.branch
    return stepBranch !== undefined
        && stepBranch.fanoutIndex === branch.fanoutIndex
        && stepBranch.branchId === branch.branchId
}

/** Whether a join step's satisfaction predicate holds for its fanout — for
 *  any_success this actively completes and skips the losing branches (the
 *  first terminal successful branch opens the join); otherwise it checks
 *  whether all branches are terminal (completed or errored) and the policy
 *  is met. */
export function isWorkflowJoinSatisfied(steps: readonly WorkflowStep[], joinStep: WorkflowStep): boolean {
    switch (joinStep.kind) {
        case "join":
            return joinStep.join === undefined ? false : isJoinMetadataSatisfied(steps, joinStep.join)
        case "task":
        case "gate":
        case "fanout":
            return false
        default:
            return assertNeverWorkflowStepKind(joinStep)
    }
}

/** Check whether a join step's metadata indicates all branches have reached a terminal state.
 * For any_success, an early-open fast path fires as soon as ONE branch is
 * terminal+successful: the remaining non-terminal branches are marked
 * skipped+completed so the join opens immediately. */
function isJoinMetadataSatisfied(
    steps: readonly WorkflowStep[],
    join: WorkflowJoinMetadata,
): boolean {
    const erroredBranchIds = new Set(join.erroredBranchIds ?? [])
    const survivorBranchIds: string[] = []
    let errors = 0

    // For any_success, scan branches once and open the join as soon as one
    // reaches a terminal successful state. Mark every remaining non-terminal
    // branch as skipped and completed.
    //
    // use_survivors only tolerates errored branches and joins the survivors;
    // it does not cancel healthy branches on the first success.
    if (join.joinPolicy === "any_success") {
        let successFound = false
        for (const tailIndex of join.branchTailIndices) {
            const tail = steps[tailIndex]
            if (tail === undefined) return false
            const branchId = tail.branch?.branchId
            if (branchId !== undefined && erroredBranchIds.has(branchId)) continue
            if (isTerminalWorkflowStep(tail)) {
                successFound = true
                break
            }
        }
        if (successFound) {
            // Mark every non-terminal, non-errored branch as skipped so the
            // join opens immediately and late results are ignored.
            //
            // Walk each losing branch's full range so intermediate steps cannot
            // remain dispatchable after the join opens.
            const fanoutStep = steps[join.fanoutIndex]
            const branchRanges = fanoutStep?.kind === "fanout" && fanoutStep.fanout !== undefined
                ? fanoutStep.fanout.branchRanges
                : undefined
            const branchIdsOnFanout = fanoutStep?.kind === "fanout" && fanoutStep.fanout !== undefined
                ? fanoutStep.fanout.branchIds
                : undefined
            for (const tailIndex of join.branchTailIndices) {
                const tail = steps[tailIndex]
                if (tail === undefined) continue
                const branchId = tail.branch?.branchId
                if (branchId !== undefined && erroredBranchIds.has(branchId)) continue
                if (isTerminalWorkflowStep(tail)) continue
                if (
                    branchId !== undefined
                    && branchRanges !== undefined
                    && branchIdsOnFanout !== undefined
                ) {
                    const rangeIdx = branchIdsOnFanout.indexOf(branchId)
                    const rangeEntry = rangeIdx >= 0 ? branchRanges[rangeIdx] : undefined
                    if (rangeEntry !== undefined) {
                        for (let r = rangeEntry.startIndex; r <= rangeEntry.endIndex; r++) {
                            const rs = steps[r]
                            if (rs === undefined) continue
                            // Mark the whole losing branch as skipped, including
                            // completed intermediate steps, so its content cannot
                            // enter the joined output.
                            rs.completed = true
                            rs.skipped = true
                        }
                        continue
                    }
                }
                // Fallback: no range info — mark the tail only.
                tail.completed = true
                tail.skipped = true
            }
            return true
        }
        // No success yet — fall through to the standard terminal-required scan
        // so the function still returns false while no branch has succeeded.
    }

    for (const tailIndex of join.branchTailIndices) {
        const tail = steps[tailIndex]
        if (tail === undefined) return false

        const branchId = tail.branch?.branchId
        if (branchId !== undefined && erroredBranchIds.has(branchId)) {
            errors += 1
            continue
        }

        if (!isTerminalWorkflowStep(tail)) return false
        if (branchId !== undefined) survivorBranchIds.push(branchId)
    }

    return joinPolicySatisfied(join, survivorBranchIds, errors)
}

/** Check whether a workflow step is in a terminal (completed or skipped) state. */
function isTerminalWorkflowStep(step: WorkflowStep): boolean {
    return step.completed || step.skipped === true
}

/** Check whether a step at the given index is nested inside an existing fanout branch. */
function isInsideAnotherFanout(steps: readonly WorkflowStep[], index: number): boolean {
    for (let candidateIndex = 0; candidateIndex < steps.length; candidateIndex += 1) {
        if (candidateIndex === index) continue

        const candidate = steps[candidateIndex]
        if (candidate === undefined) continue

        switch (candidate.kind) {
            case "fanout":
                if (candidate.fanout?.branchRanges.some(range => includesWorkflowIndex(range, index)) === true) {
                    return true
                }
                break
            case "task":
            case "gate":
            case "join":
                break
            default:
                assertNeverWorkflowStepKind(candidate)
        }
    }

    return false
}

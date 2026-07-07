import type { WorkflowBranchRange, WorkflowStep, WorkflowTask } from "./types.js"

export type WorkflowDagValidationResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string }

export class WorkflowDagInvariantError extends Error {
    constructor(value: never) {
        super(`Unexpected workflow step kind: ${String(value)}`)
        this.name = "WorkflowDagInvariantError"
    }
}

function assertNever(value: never): never {
    throw new WorkflowDagInvariantError(value)
}

export function getActiveWorkflowStepIndices(
    task: Pick<WorkflowTask, "activeStepIndices" | "currentStageIndex">,
): readonly number[] {
    return task.activeStepIndices ?? [task.currentStageIndex]
}

export function workflowStepActor(step: WorkflowStep | undefined): string | null {
    if (step === undefined) return null

    switch (step.kind) {
        case "task":
            return step.member ?? null
        case "gate":
            return step.verifier ?? null
        case "fanout":
        case "join":
            return null
        default:
            return assertNever(step.kind)
    }
}

export function getActiveWorkflowStepActors(
    task: Pick<WorkflowTask, "activeStepIndices" | "currentStageIndex" | "steps">,
): readonly string[] {
    const steps = task.steps ?? []
    const actors: string[] = []

    for (const index of getActiveWorkflowStepIndices(task)) {
        const actor = workflowStepActor(steps[index])
        if (actor !== null) actors.push(actor)
    }

    return actors
}

export function findActiveWorkflowStepIndexForMember(
    task: Pick<WorkflowTask, "activeStepIndices" | "currentStageIndex" | "steps">,
    memberName: string,
): number | null {
    const steps = task.steps ?? []

    for (const index of getActiveWorkflowStepIndices(task)) {
        const step = steps[index]
        if (step === undefined || step.completed) continue
        if (workflowStepActor(step) === memberName) return index
    }

    return null
}

export function readyWorkflowStepIndices(
    task: Pick<WorkflowTask, "activeStepIndices" | "currentStageIndex" | "steps">,
): readonly number[] {
    const steps = task.steps ?? []
    const ready: number[] = []

    for (const index of getActiveWorkflowStepIndices(task)) {
        collectReadyWorkflowStepIndices(steps, index, ready)
    }

    return ready
}

export function isWorkflowJoinSatisfied(steps: readonly WorkflowStep[], joinStep: WorkflowStep): boolean {
    switch (joinStep.kind) {
        case "join":
            return joinStep.join === undefined ? false : isJoinMetadataSatisfied(steps, joinStep.join)
        case "task":
        case "gate":
        case "fanout":
            return false
        default:
            return assertNever(joinStep.kind)
    }
}

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
                assertNever(step.kind)
        }
    }

    return { ok: true }
}

function fanoutBranchHeadIndices(step: WorkflowStep): readonly number[] {
    const fanout = step.fanout
    if (fanout === undefined) return []

    return fanout.branchRanges.map(range => range.startIndex)
}

function collectReadyWorkflowStepIndices(
    steps: readonly WorkflowStep[],
    index: number,
    ready: number[],
): void {
    const step = steps[index]
    if (step === undefined) return

    switch (step.kind) {
        case "task":
        case "gate":
            if (!step.completed) {
                pushUniqueWorkflowIndex(ready, index)
                return
            }
            collectWorkflowSuccessors(steps, index, ready)
            return
        case "fanout":
            for (const branchHeadIndex of fanoutBranchHeadIndices(step)) {
                collectReadyWorkflowStepIndices(steps, branchHeadIndex, ready)
            }
            return
        case "join":
            if (!step.completed) {
                if (isWorkflowJoinSatisfied(steps, step)) pushUniqueWorkflowIndex(ready, index)
                return
            }
            collectWorkflowSuccessors(steps, index, ready)
            return
        default:
            assertNever(step.kind)
    }
}

function collectWorkflowSuccessors(
    steps: readonly WorkflowStep[],
    index: number,
    ready: number[],
): void {
    const step = steps[index]
    if (step === undefined) return

    const branch = step.branch
    if (branch !== undefined) {
        const nextBranchIndex = index + 1
        const nextBranchStep = steps[nextBranchIndex]
        if (nextBranchStep !== undefined && isSameWorkflowBranch(nextBranchStep, branch)) {
            collectReadyWorkflowStepIndices(steps, nextBranchIndex, ready)
            return
        }
        collectReadyWorkflowStepIndices(steps, branch.joinIndex, ready)
        return
    }

    collectReadyWorkflowStepIndices(steps, index + 1, ready)
}

function isSameWorkflowBranch(
    step: WorkflowStep,
    branch: NonNullable<WorkflowStep["branch"]>,
): boolean {
    const stepBranch = step.branch
    return stepBranch !== undefined && stepBranch.fanoutIndex === branch.fanoutIndex && stepBranch.branchId === branch.branchId
}

function pushUniqueWorkflowIndex(indices: number[], index: number): void {
    if (!indices.includes(index)) indices.push(index)
}

function isJoinMetadataSatisfied(
    steps: readonly WorkflowStep[],
    join: NonNullable<WorkflowStep["join"]>,
): boolean {
    const erroredBranchIds = new Set(join.erroredBranchIds ?? [])
    const survivorBranchIds: string[] = []
    let errors = 0

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

/**
 * Apply the join policy to decide whether a fully-terminal fanout survives.
 * Every policy waits until all branches are terminal (completed or errored);
 * the policy only changes the success criterion. Default (no joinPolicy) keeps
 * the legacy max_errored tolerance semantics.
 */
function joinPolicySatisfied(
    join: NonNullable<WorkflowStep["join"]>,
    survivorBranchIds: readonly string[],
    errors: number,
): boolean {
    const total = join.branchTailIndices.length
    const survivors = survivorBranchIds.length
    switch (join.joinPolicy) {
        case undefined:
        case "tolerance":
            return survivors > 0 && errors <= join.maxErrored
        case "all":
        case "reduce":
            return errors === 0
        case "quorum": {
            const threshold = join.quorum ?? 0
            return survivors / total >= threshold
        }
        case "any_success":
            return survivors >= 1
        case "required_branches": {
            const required = join.requiredBranchIds ?? []
            const survivorSet = new Set(survivorBranchIds)
            return required.every(branchId => survivorSet.has(branchId))
        }
        default:
            return survivors > 0 && errors <= join.maxErrored
    }
}

function isTerminalWorkflowStep(step: WorkflowStep): boolean {
    return step.completed || step.skipped === true
}

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
                assertNever(candidate.kind)
        }
    }

    return false
}

function includesWorkflowIndex(range: WorkflowBranchRange, index: number): boolean {
    return range.startIndex <= index && index <= range.endIndex
}

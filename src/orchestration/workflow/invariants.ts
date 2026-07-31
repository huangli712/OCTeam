/**
 * Workflow step invariant checker: validates the runtime state of a workflow
 * task's steps against structural constraints (ordering, bounds, branch ranges).
 */

import type {
    WorkflowBranchMetadata,
    WorkflowBranchRange,
    WorkflowFanoutStep,
    WorkflowFanoutMetadata,
    WorkflowGateStep,
    WorkflowJoinMetadata,
    WorkflowJoinStep,
    WorkflowStep,
    WorkflowTask,
} from "../../core/types.js"
import { gateTargetIndices } from "./gate-targets.js"
import { joinPolicySatisfied } from "./join-policy.js"

/** Default per-gate jump cap (mirrors engine.ts; kept local to avoid a circular import). */
const DEFAULT_MAX_JUMPS = 3

/** Result of a workflow invariant check: either ok or a list of violations. */
export type WorkflowInvariantCheckResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly violations: readonly string[] }

/** Internal accumulator for invariant checks: the step array under validation and the collected violations. */
type WorkflowInvariantContext = {
    readonly steps: readonly WorkflowStep[]
    readonly violations: string[]
}

/** Validate all runtime invariants on a workflow task's step state. */
export function checkWorkflowInvariants(task: WorkflowTask): WorkflowInvariantCheckResult {
    const context: WorkflowInvariantContext = { steps: task.steps ?? [], violations: [] }
    checkActiveStepIndices(context, task.activeStepIndices)
    for (let index = 0; index < context.steps.length; index += 1) {
        const step = context.steps[index]
        if (step !== undefined) checkStep(context, index, step)
    }
    return context.violations.length === 0 ? { ok: true } : { ok: false, violations: context.violations }
}

/** Validate that active step indices are sorted, unique, in-bounds, and point to advanceable steps. */
function checkActiveStepIndices(
    context: WorkflowInvariantContext,
    activeStepIndices: readonly number[] | undefined,
): void {
    if (activeStepIndices === undefined) return

    const seen = new Set<number>()
    let previousIndex = -1
    for (let position = 0; position < activeStepIndices.length; position += 1) {
        const index = activeStepIndices[position]
        if (index === undefined) continue
        if (index <= previousIndex) {
            context.violations.push(`active[${position}]: index ${index} is not sorted after ${previousIndex}`)
        }
        previousIndex = index
        if (seen.has(index)) {
            context.violations.push(`active[${position}]: duplicate index ${index}`)
            continue
        }
        seen.add(index)
        if (!isIndexInBounds(context.steps, index)) {
            context.violations.push(`active[${position}]: index ${index} out of bounds`)
            continue
        }
        const step = context.steps[index]
        if (step === undefined) continue
        const violation = activeStepViolation(context.steps, index, step)
        if (violation !== null) context.violations.push(`active[${position}]: ${violation}`)
    }
}

/** Check whether an active step can advance based on its kind and state; return a violation string or null. */
function activeStepViolation(steps: readonly WorkflowStep[], index: number, step: WorkflowStep): string | null {
    if (step.completed) return `step ${index} is completed`
    switch (step.kind) {
        case "task":
        case "gate":
            return null
        case "fanout":
            return canFanoutAdvance(steps, step.fanout) ? null : `step ${index} fanout cannot advance`
        case "join":
            if (step.join !== undefined && isJoinSatisfied(steps, index, step.join)) {
                return null
            }
            return `step ${index} join cannot advance`
        default:
            return assertNever(step)
    }
}

/** Validate common step properties and dispatch to kind-specific checks. */
function checkStep(context: WorkflowInvariantContext, index: number, step: WorkflowStep): void {
    if (step.skipped === true && !step.completed) context.violations.push(`step ${index}: skipped requires completed`)
    if (step.branch !== undefined) checkBranchMetadata(context, index, step.branch)

    switch (step.kind) {
        case "task": {
            if (step.taskAttempts !== undefined && step.taskAttempts > (step.maxTaskRetries ?? 0) + 1) {
                context.violations.push(
                    `step ${index}: taskAttempts ${step.taskAttempts} exceeds cap ${step.maxTaskRetries ?? 0}`,
                )
            }
            return
        }
        case "gate":
            checkGateStep(context, index, step)
            return
        case "fanout":
            checkFanoutStep(context, index, step)
            return
        case "join":
            checkJoinStep(context, index, step)
            return
        default:
            assertNever(step)
    }
}

/** Validate a gate step's target indices, verifier conflicts, and attempt counters. */
function checkGateStep(context: WorkflowInvariantContext, index: number, step: WorkflowGateStep): void {
    const targetIndices = gateTargetIndices(context.steps, index)
    const explicitTargetIndices = step.targetStepIndices !== undefined && step.targetStepIndices.length > 0
        ? step.targetStepIndices
        : step.targetStepIndex === undefined
            ? undefined
            : [step.targetStepIndex]
    if (explicitTargetIndices === undefined && targetIndices.length === 0) {
        context.violations.push(`step ${index}: gate has no previous task target`)
    }
    for (const targetIndex of explicitTargetIndices ?? []) {
        if (!targetIndices.includes(targetIndex)) {
            context.violations.push(`step ${index}: target ${targetIndex} is not a previous task or join step`)
        }
    }

    for (const targetIndex of targetIndices) {
        const target = context.steps[targetIndex]
        // gate→join is legal: a join carries joinedOutput and can be verified
        // (matches gate.ts:183 and validate.ts:638). Only task and join are
        // valid gate targets; fanout is a pure structural marker.
        if (targetIndex >= index || (target?.kind !== "task" && target?.kind !== "join")) {
            context.violations.push(`step ${index}: target ${targetIndex} is not a previous task or join step`)
            continue
        }
        // join has no member, so the self-verification check does not apply.
        if (target?.kind === "join") continue
        if (step.verifier !== undefined && target.member !== undefined && step.verifier === target.member) {
            context.violations.push(`step ${index}: verifier matches target ${targetIndex} member`)
        }
        if (step.verifiers !== undefined && target.member !== undefined && step.verifiers.includes(target.member)) {
            context.violations.push(`step ${index}: ensemble verifier matches target ${targetIndex} member`)
        }
    }
    if (step.verifier !== undefined && step.verifiers !== undefined) {
        context.violations.push(`step ${index}: verifier and verifiers are mutually exclusive`)
    }
    // I-H7: validate goto edges. Pre-fix invariant checker did NOT validate
    // onPassGoto/onFailGoto/onInvalidGoto — out-of-bounds, cross-branch, or
    // self-referencing goto targets passed invariant checks, and the runtime
    // gatedGotoIndex returned -1, silently treating "invalid goto" as "no
    // goto" and continuing sequential execution.
    for (const [field, gotoIdx] of [
        ["onPassGoto", step.onPassGoto],
        ["onFailGoto", step.onFailGoto],
        ["onInvalidGoto", step.onInvalidGoto],
    ] as const) {
        if (gotoIdx === undefined) continue
        // MEDIUM: reject non-integer indices before bounds check to avoid
        // accessing steps[1.5] === undefined and crashing on .kind access.
        if (!Number.isInteger(gotoIdx)) {
            context.violations.push(`step ${index}: ${field} ${gotoIdx} is not an integer`)
            continue
        }
        if (gotoIdx < 0 || gotoIdx >= context.steps.length) {
            context.violations.push(`step ${index}: ${field} ${gotoIdx} is out of bounds`)
            continue
        }
        if (gotoIdx === index) {
            context.violations.push(`step ${index}: ${field} ${gotoIdx} is self-referencing`)
            continue
        }
        const target = context.steps[gotoIdx]
        if (target.kind !== "task" && target.kind !== "gate") {
            context.violations.push(`step ${index}: ${field} ${gotoIdx} targets a ${target.kind} step (only task/gate allowed)`)
            continue
        }
        // Cross-branch check: goto target must be in the same branch (or
        // top-level if gate is top-level).
        if (step.branch !== undefined) {
            if (target.branch === undefined || target.branch.fanoutIndex !== step.branch.fanoutIndex
                || target.branch.branchId !== step.branch.branchId) {
                context.violations.push(`step ${index}: ${field} ${gotoIdx} crosses branch boundary`)
            }
        } else if (target.branch !== undefined) {
            context.violations.push(`step ${index}: ${field} ${gotoIdx} targets inside a branch from top-level gate`)
        }
    }
    for (const counter of [
        { field: "attempts", value: step.attempts, cap: step.maxRetries ?? 0 },
        { field: "invalidAttempts", value: step.invalidAttempts, cap: step.maxInvalidRetries ?? 0 },
        { field: "malformedAttempts", value: step.malformedAttempts, cap: step.maxMalformedRetries ?? 0 },
        { field: "timeoutAttempts", value: step.timeoutAttempts, cap: step.maxTimeoutRetries ?? 0 },
        { field: "jumpCount", value: step.jumpCount, cap: step.maxJumps ?? DEFAULT_MAX_JUMPS },
        { field: "loopIterations", value: step.loopIterations, cap: step.loop?.maxIterations ?? 0 },
    ] as const) {
        if (counter.value !== undefined && counter.value > counter.cap + 1) {
            context.violations.push(`step ${index}: ${counter.field} ${counter.value} exceeds cap ${counter.cap}`)
        }
    }
}

/** Validate that a branch's metadata is consistent with its fanout and join markers. */
function checkBranchMetadata(context: WorkflowInvariantContext, index: number, branch: WorkflowBranchMetadata): void {
    const fanout = fanoutAt(context.steps, branch.fanoutIndex)
    if (fanout === null) {
        context.violations.push(`step ${index}: branch fanout ${branch.fanoutIndex} is not a fanout marker`)
        return
    }
    const join = context.steps[branch.joinIndex]
    if (join?.kind !== "join" || join.join === undefined) {
        context.violations.push(`step ${index}: branch join ${branch.joinIndex} is not a join marker`)
    } else if (join.join.fanoutIndex !== branch.fanoutIndex) {
        context.violations.push(
            `step ${index}: branch join ${branch.joinIndex} points to fanout ${join.join.fanoutIndex}`,
        )
    }
    if (branch.joinIndex !== fanout.joinIndex) {
        context.violations.push(
            `step ${index}: branch join ${branch.joinIndex} differs from fanout join ${fanout.joinIndex}`,
        )
    }

    const branchIdIndex = fanout.branchIds.indexOf(branch.branchId)
    if (branchIdIndex < 0) {
        context.violations.push(`step ${index}: branchId ${branch.branchId} is not in fanout ${branch.fanoutIndex}`)
        return
    }
    const declaredBranchId = fanout.branchIds[branch.branchIndex]
    if (declaredBranchId === undefined) {
        context.violations.push(`step ${index}: branchIndex ${branch.branchIndex} is out of fanout range`)
    } else if (declaredBranchId !== branch.branchId) {
        context.violations.push(
            `step ${index}: branchIndex ${branch.branchIndex} maps to branch `
                + `${declaredBranchId}, not ${branch.branchId}`,
        )
    }
    const range = fanout.branchRanges[branchIdIndex]
    if (range === undefined) {
        context.violations.push(`step ${index}: branchId ${branch.branchId} has no branch range`)
    } else if (!includesWorkflowIndex(range, index)) {
        context.violations.push(`step ${index}: index is outside branch range ${range.startIndex}-${range.endIndex}`)
    }
}

/** Validate a fanout step's join link, branch ranges, and range ordering. */
function checkFanoutStep(context: WorkflowInvariantContext, index: number, step: WorkflowFanoutStep): void {
    const fanout = step.fanout
    if (fanout === undefined) {
        context.violations.push(`step ${index}: fanout metadata is missing`)
        return
    }
    const join = context.steps[fanout.joinIndex]
    if (join?.kind !== "join" || join.join === undefined) {
        context.violations.push(`step ${index}: fanout join ${fanout.joinIndex} is not a join marker`)
    }
    if (fanout.branchIds.length !== fanout.branchRanges.length) {
        context.violations.push(`step ${index}: branch id/range count mismatch`)
    }

    for (let rangeIndex = 0; rangeIndex < fanout.branchRanges.length; rangeIndex += 1) {
        const range = fanout.branchRanges[rangeIndex]
        if (range === undefined) continue
        if (range.startIndex > range.endIndex) {
            context.violations.push(`step ${index}: branch range ${rangeIndex} is empty`)
        }
        if (!isIndexInBounds(context.steps, range.startIndex) || !isIndexInBounds(context.steps, range.endIndex)) {
            context.violations.push(`step ${index}: branch range ${rangeIndex} out of bounds`)
        }
        if (range.startIndex <= index) {
            context.violations.push(`step ${index}: branch range ${rangeIndex} must start after fanout`)
        }
        if (range.endIndex >= fanout.joinIndex) {
            context.violations.push(
                `step ${index}: branch range ${rangeIndex} must end before join ${fanout.joinIndex}`,
            )
        }
        for (let previousIndex = 0; previousIndex < rangeIndex; previousIndex += 1) {
            const previous = fanout.branchRanges[previousIndex]
            if (previous !== undefined && rangesOverlap(previous, range)) {
                context.violations.push(`step ${index}: branch range ${rangeIndex} overlaps ${previousIndex}`)
            }
        }
        // MEDIUM #13: verify every step in the branch range has the correct
        // branch metadata. Pre-fix code only checked that steps WITH metadata
        // are in a valid range — not that all steps IN a range have metadata.
        const expectedBranchId = fanout.branchIds[rangeIndex]
        for (let si = range.startIndex; si <= range.endIndex; si += 1) {
            const rangeStep = context.steps[si]
            if (rangeStep === undefined) continue
            if (rangeStep.branch === undefined) {
                context.violations.push(`step ${si}: in branch range ${rangeIndex} but has no branch metadata`)
            } else if (rangeStep.branch.fanoutIndex !== index
                || rangeStep.branch.branchId !== expectedBranchId) {
                context.violations.push(
                    `step ${si}: branch metadata mismatch (expected fanout ${index}/${expectedBranchId}`
                        + `, got ${rangeStep.branch.fanoutIndex}/${rangeStep.branch.branchId})`,
                )
            }
        }
    }
}

/** Validate a join step's fanout link, branch tails, errored/survivor IDs, and policy satisfaction. */
function checkJoinStep(context: WorkflowInvariantContext, index: number, step: WorkflowJoinStep): void {
    const join = step.join
    if (join === undefined) {
        context.violations.push(`step ${index}: join metadata is missing`)
        return
    }
    const fanout = fanoutAt(context.steps, join.fanoutIndex)
    if (fanout === null) {
        context.violations.push(`step ${index}: join fanout ${join.fanoutIndex} is not a fanout marker`)
        return
    }
    if (fanout.joinIndex !== index) {
        context.violations.push(`step ${index}: fanout ${join.fanoutIndex} points to join ${fanout.joinIndex}`)
    }

    for (const tailIndex of join.branchTailIndices) {
        const tail = context.steps[tailIndex]
        if (tail === undefined) {
            context.violations.push(`step ${index}: branch tail ${tailIndex} out of bounds`)
        } else if (tail.branch?.fanoutIndex !== join.fanoutIndex) {
            context.violations.push(`step ${index}: branch tail ${tailIndex} is not in fanout ${join.fanoutIndex}`)
        } else {
            // MEDIUM: verify tail matches the branch range's endIndex.
            const fanout = context.steps[join.fanoutIndex]
            if (fanout?.kind === "fanout" && fanout.fanout) {
                const range = fanout.fanout.branchRanges[fanout.fanout.branchIds.indexOf(tail.branch!.branchId)]
                if (range && tailIndex !== range.endIndex) {
                    context.violations.push(`step ${index}: branch tail ${tailIndex} does not match range endIndex ${range.endIndex}`)
                }
            }
        }
    }
    for (const branchId of join.erroredBranchIds ?? []) {
        if (!fanout.branchIds.includes(branchId)) {
            context.violations.push(`step ${index}: errored branch ${branchId} is not in fanout`)
        }
    }
    for (const branchId of join.survivorBranchIds ?? []) {
        if (!fanout.branchIds.includes(branchId)) {
            context.violations.push(`step ${index}: survivor branch ${branchId} is not in fanout`)
        }
    }
    if (!step.completed) return

    const erroredBranchIds = new Set(join.erroredBranchIds ?? [])
    const survivorBranchIds = fanout.branchIds.filter(branchId => !erroredBranchIds.has(branchId))
    if (!joinPolicySatisfied(join, survivorBranchIds, erroredBranchIds.size)) {
        context.violations.push(`step ${index}: completed join violates ${join.joinPolicy ?? "tolerance"} policy`)
    }
    for (let branchIndex = 0; branchIndex < fanout.branchIds.length; branchIndex += 1) {
        const branchId = fanout.branchIds[branchIndex]
        if (branchId === undefined || erroredBranchIds.has(branchId)) continue
        const tailIndex = join.branchTailIndices[branchIndex]
        if (tailIndex === undefined || !isTerminalStep(context.steps[tailIndex])) {
            context.violations.push(`step ${index}: completed join has non-terminal branch ${branchId}`)
        }
    }
}

/** Check whether a fanout has at least one non-empty branch range with an in-bounds start index. */
function canFanoutAdvance(steps: readonly WorkflowStep[], fanout: WorkflowFanoutMetadata | undefined): boolean {
    if (fanout === undefined) return false
    const join = steps[fanout.joinIndex]
    if (join?.kind !== "join" || join.join === undefined) return false
    return fanout.branchRanges.some(
        range => range.startIndex <= range.endIndex
            && isIndexInBounds(steps, range.startIndex)
            && range.endIndex < fanout.joinIndex,
    )
}

/** Check whether a join's branches are all terminal and its join policy is satisfied. */
function isJoinSatisfied(steps: readonly WorkflowStep[], joinIndex: number, join: WorkflowJoinMetadata): boolean {
    const fanout = fanoutAt(steps, join.fanoutIndex)
    if (fanout === null || fanout.joinIndex !== joinIndex) return false
    const erroredBranchIds = new Set(join.erroredBranchIds ?? [])
    const survivorBranchIds: string[] = []
    for (let branchIndex = 0; branchIndex < fanout.branchIds.length; branchIndex += 1) {
        const branchId = fanout.branchIds[branchIndex]
        if (branchId === undefined || erroredBranchIds.has(branchId)) continue
        const tailIndex = join.branchTailIndices[branchIndex]
        if (tailIndex === undefined || !isTerminalStep(steps[tailIndex])) return false
        survivorBranchIds.push(branchId)
    }
    return joinPolicySatisfied(join, survivorBranchIds, erroredBranchIds.size)
}

/** Return the fanout metadata at the given index, or null if it is not a fanout step. */
function fanoutAt(steps: readonly WorkflowStep[], index: number): WorkflowFanoutMetadata | null {
    const step = steps[index]
    return step?.kind === "fanout" && step.fanout !== undefined ? step.fanout : null
}

/** Check whether a step is in a terminal state (completed or skipped). */
function isTerminalStep(step: WorkflowStep | undefined): boolean {
    return step?.completed === true || step?.skipped === true
}

/** Check that an index is a non-negative integer within the steps array bounds. */
function isIndexInBounds(steps: readonly WorkflowStep[], index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < steps.length
}

/** Check whether an index falls within the given branch range. */
export function includesWorkflowIndex(range: WorkflowBranchRange, index: number): boolean {
    return range.startIndex <= index && index <= range.endIndex
}

/** Check whether two branch ranges overlap. */
function rangesOverlap(left: WorkflowBranchRange, right: WorkflowBranchRange): boolean {
    return left.startIndex <= right.endIndex && right.startIndex <= left.endIndex
}

/** Exhaustive match guard: throw if an unreachable value is reached. */
function assertNever(value: never): never {
    throw new Error(`Unhandled workflow step kind: ${String(value)}`)
}

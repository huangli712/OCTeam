/**
 * Workflow step lowering: converts public WorkflowToolStep[] into the internal
 * LoweredWorkflowStep[] representation (flat fanout branches, resolved refs).
 * Also handles matrix/foreach expansion and validation error label formatting.
 *
 * Dry-run preview formatting lives in format.ts.
 *
 * Extracted from the workflow tool entry point.
 */

import type {
    WorkflowBranchMetadata,
    WorkflowFanoutMetadata,
    WorkflowJoinMetadata,
    WorkflowStep,
} from "../../core/types.js"
import { parseWorkflowCondition } from "../../orchestration/workflow/gate.js"
import type {
    WorkflowFanoutBranch,
    WorkflowLinearToolStep,
    WorkflowStepRef,
    WorkflowToolStep,
} from "./engine.js"

// --- lowered types ---

/** Identifies a step's position within a fanout branch for error messages. */
export type WorkflowBranchContext = {
    readonly fanoutStepNumber: number
    readonly branchId: string
    readonly branchStepNumber: number
}

/** A linear step in the lowered (flat) representation with optional branch metadata. */
export type LoweredWorkflowLinearStep = WorkflowLinearToolStep & {
    readonly branch?: WorkflowBranchMetadata
    readonly branchContext?: WorkflowBranchContext
}

/** A fanout step in the lowered representation with resolved fanout metadata. */
export type LoweredWorkflowFanoutStep = {
    readonly kind: "fanout"
    readonly id?: string
    readonly fanout: WorkflowFanoutMetadata
}

/** A join marker step in the lowered representation. */
export type LoweredWorkflowJoinStep = {
    readonly kind: "join"
    readonly id?: string
    readonly join: WorkflowJoinMetadata
}

/** Union of all lowered workflow step kinds. */
export type LoweredWorkflowStep = LoweredWorkflowLinearStep | LoweredWorkflowFanoutStep | LoweredWorkflowJoinStep

// --- invariant guard ---

/** Invariant violation for unexpected workflow step kind during lowering. */
class WorkflowToolInvariantError extends Error {
    constructor(value: never) {
        super(`Unexpected workflow tool step kind: ${String(value)}`)
        this.name = "WorkflowToolInvariantError"
    }
}

/** Exhaustiveness-check helper: throws on unreachable code paths. */
export function assertNever(value: never): never {
    throw new WorkflowToolInvariantError(value)
}

// --- type guards ---

/** Test whether a workflow step is a linear (non-fanout) kind. */
export function isLinearToolStep(step: WorkflowToolStep): step is WorkflowLinearToolStep {
    return step.kind === "task" || step.kind === "gate"
}
// --- ref resolution (lowered) ---

/** Whether a lowered step kind is a valid gate target (task or join). */
function isGateTargetKind(step: LoweredWorkflowStep | undefined): boolean {
    return step?.kind === "task" || step?.kind === "join"
}

/** Resolve a gate's target_step or targets entry to a lowered step index. */
export function resolveGateTargetRef(
    steps: readonly LoweredWorkflowStep[],
    gateIndex: number,
    target: WorkflowStepRef,
): number {
    if (typeof target === "number") {
        const idx = target - 1
        return idx >= 0 && idx < gateIndex && isGateTargetKind(steps[idx]) ? idx : -1
    }
    const idx = steps.findIndex((s, i) => i < gateIndex && isGateTargetKind(s) && s.id === target)
    return idx
}

export function resolveGateTargetIndex(steps: readonly LoweredWorkflowStep[], gateIndex: number): number {
    const gate = steps[gateIndex]
    if (gate?.kind !== "gate") return -1
    const target = gate.target_step
    if (target === undefined) {
        for (let i = gateIndex - 1; i >= 0; i--) {
            if (isGateTargetKind(steps[i])) return i
        }
        return -1
    }
    return resolveGateTargetRef(steps, gateIndex, target)
}

/** Resolve a gate's targets array to a sorted list of lowered step indices. */
export function resolveGateTargetIndices(steps: readonly LoweredWorkflowStep[], gateIndex: number): number[] {
    const gate = steps[gateIndex]
    if (gate?.kind !== "gate") return []
    if (gate.targets !== undefined) {
        const indices: number[] = []
        for (const target of gate.targets) {
            const idx = resolveGateTargetRef(steps, gateIndex, target)
            if (idx < 0) return []
            if (!indices.includes(idx)) indices.push(idx)
        }
        return indices.sort((a, b) => a - b)
    }
    const target = resolveGateTargetIndex(steps, gateIndex)
    return target < 0 ? [] : [target]
}

/** Resolve a single inputs entry to a lowered step index. */
export function resolveWorkflowInputRef(
    steps: readonly LoweredWorkflowStep[],
    consumerIndex: number,
    ref: WorkflowStepRef,
): number {
    const idx = typeof ref === "number"
        ? ref - 1
        : steps.findIndex((step, index) => index < consumerIndex && step.id === ref)
    const input = steps[idx]
    if (idx < 0 || idx >= consumerIndex || (input?.kind !== "task" && input?.kind !== "join")) return -1
    return idx
}

/** Resolve a task step's inputs array to lowered step indices. */
export function resolveWorkflowInputIndices(
    steps: readonly LoweredWorkflowStep[],
    consumerIndex: number,
): number[] | undefined {
    const step = steps[consumerIndex]
    if (step?.kind !== "task" || step.inputs === undefined) return undefined
    return step.inputs.map(input => resolveWorkflowInputRef(steps, consumerIndex, input))
}

/** Check whether a consumer step is allowed to consume output from an input step. */
export function canConsumeWorkflowInput(
    steps: readonly LoweredWorkflowStep[],
    consumerIndex: number,
    inputIndex: number,
): boolean {
    const consumer = steps[consumerIndex]
    const input = steps[inputIndex]
    if (consumer?.kind !== "task" || input === undefined) return false
    if (input.kind !== "task" && input.kind !== "join") return false
    const consumerBranch = consumer.branch
    const inputBranch = input.kind === "task" ? input.branch : undefined
    if (consumerBranch === undefined) return inputBranch === undefined
    if (inputBranch === undefined) return inputIndex < consumerBranch.fanoutIndex
    return inputBranch.fanoutIndex === consumerBranch.fanoutIndex && inputBranch.branchId === consumerBranch.branchId
}

/** Return the first index from a list, or undefined if empty. */
export function primaryTargetIndex(indices: number[]): number | undefined {
    return indices.length === 0 ? undefined : indices[0]
}

/** Resolve a gate's goto reference to a lowered step index. */
export function resolveGotoIndex(
    steps: readonly LoweredWorkflowStep[],
    gateIndex: number,
    ref: WorkflowStepRef | undefined,
): number {
    if (ref === undefined) return -1
    if (typeof ref === "number") {
        const idx = ref - 1
        return idx >= 0 && idx < steps.length && idx !== gateIndex ? idx : -1
    }
    const idx = steps.findIndex((s, i) => i !== gateIndex && s.id === ref)
    return idx
}

/** Check whether a gate's target ref points to a fanout marker step.
 * join is a valid gate target (it carries joinedOutput), only fanout is a
 * pure structural marker that cannot be verified. */
export function resolvesToMarkerStep(
    steps: readonly LoweredWorkflowStep[],
    gateIndex: number,
    ref: WorkflowStepRef,
): boolean {
    const idx = typeof ref === "number"
        ? ref - 1
        : steps.findIndex((s, i) => i < gateIndex && s.id === ref)
    if (idx < 0 || idx >= gateIndex) return false
    const target = steps[idx]
    if (target === undefined) return false
    switch (target.kind) {
        case "fanout":
            return true
        case "join":
        case "task":
        case "gate":
            return false
        default:
            return assertNever(target)
    }
}

// --- ref conversion (public → flat) ---

/** Convert a public 1-based step ref to a flat lowered index. */
export function convertTopLevelRef(ref: WorkflowStepRef, publicToFlat: readonly number[]): WorkflowStepRef {
    if (typeof ref === "string") return ref
    const flatIndex = publicToFlat[ref - 1]
    return flatIndex === undefined ? ref : flatIndex + 1
}

/** Convert a branch-local step ref to a flat lowered index. */
export function convertBranchRef(
    ref: WorkflowStepRef,
    branchStartIndex: number,
    branchStepCount: number,
): WorkflowStepRef {
    if (typeof ref === "string") return ref
    const localIndex = ref - 1
    return localIndex >= 0 && localIndex < branchStepCount ? branchStartIndex + localIndex + 1 : ref
}

/** Resolve a gate's target ref in the public (pre-lowering) step array. */
export function resolvePublicTaskRef(
    steps: readonly WorkflowToolStep[],
    gateIndex: number,
    target: WorkflowStepRef,
): number {
    if (typeof target === "number") {
        const idx = target - 1
        return idx >= 0 && idx < gateIndex && steps[idx]?.kind === "task" ? idx : -1
    }
    return steps.findIndex((step, index) => index < gateIndex && step.kind === "task" && step.id === target)
}

/** Resolve a gate's implicit or explicit target in the public step array. */
export function resolvePublicGateTargetIndex(steps: readonly WorkflowToolStep[], gateIndex: number): number {
    const gate = steps[gateIndex]
    if (gate?.kind !== "gate") return -1
    if (gate.target_step !== undefined) return resolvePublicTaskRef(steps, gateIndex, gate.target_step)
    for (let index = gateIndex - 1; index >= 0; index -= 1) {
        if (steps[index]?.kind === "task") return index
    }
    return -1
}

/** Resolve a gate's goto ref in the public step array. */
export function resolvePublicGotoRef(
    steps: readonly WorkflowToolStep[],
    gateIndex: number,
    ref: WorkflowStepRef,
): number {
    if (typeof ref === "number") {
        const idx = ref - 1
        return idx >= 0 && idx < steps.length && idx !== gateIndex ? idx : -1
    }
    return steps.findIndex((step, index) => index !== gateIndex && step.id === ref)
}

// --- step lowering ---

/** Lower a single linear (task or gate) step to the flat representation. */
export function lowerLinearStep(
    step: WorkflowLinearToolStep,
    convertRef: (ref: WorkflowStepRef) => WorkflowStepRef,
    branch: WorkflowBranchMetadata | undefined,
    branchContext: WorkflowBranchContext | undefined,
): LoweredWorkflowLinearStep {
    const inputLowered = step.inputs === undefined
        ? step
        : { ...step, inputs: step.inputs.map(input => convertRef(input)) }
    if (step.kind === "task") {
        return branch === undefined || branchContext === undefined
        ? inputLowered
        : { ...inputLowered, branch, branchContext }
    }
    const lowered: WorkflowLinearToolStep = {
        ...inputLowered,
        target_step: step.target_step === undefined ? undefined : convertRef(step.target_step),
        targets: step.targets?.map(target => convertRef(target)),
        on_pass_goto: step.on_pass_goto === undefined ? undefined : convertRef(step.on_pass_goto),
        on_fail_goto: step.on_fail_goto === undefined ? undefined : convertRef(step.on_fail_goto),
        on_invalid_goto: step.on_invalid_goto === undefined ? undefined : convertRef(step.on_invalid_goto),
    }
    return branch === undefined || branchContext === undefined ? lowered : { ...lowered, branch, branchContext }
}

/** Lower a full public WorkflowToolStep array into the flat LoweredWorkflowStep array. */
export function lowerWorkflowSteps(steps: readonly WorkflowToolStep[]): readonly LoweredWorkflowStep[] {
    const loweredSteps: LoweredWorkflowStep[] = []
    const publicToFlat: number[] = []

    for (let publicIndex = 0; publicIndex < steps.length; publicIndex += 1) {
        const step = steps[publicIndex]
        if (step === undefined) continue

        switch (step.kind) {
            case "task":
            case "gate":
                if (!isLinearToolStep(step)) break
                publicToFlat[publicIndex] = loweredSteps.length
                loweredSteps.push(lowerLinearStep(
                    step, ref => convertTopLevelRef(ref, publicToFlat),
                    undefined, undefined,
                ))
                break
            case "join":
                publicToFlat[publicIndex] = loweredSteps.length
                loweredSteps.push({
                    kind: "join", id: step.id,
                    join: { fanoutIndex: -1, branchTailIndices: [], maxErrored: 0 },
                })
                break
            case "fanout": {
                const joinStep = steps[publicIndex + 1]
                const branches = step.branches ?? []
                const fanoutIndex = loweredSteps.length
                const totalBranchSteps = branches.reduce((sum, branch) => sum + branch.steps.length, 0)
                const joinIndex = fanoutIndex + totalBranchSteps + 1
                const branchRanges = branches.map((branch, branchIndex) => {
                    const previousLength = branches
                        .slice(0, branchIndex)
                        .reduce((sum, previousBranch) => sum + previousBranch.steps.length, 0)
                    return {
                        startIndex: fanoutIndex + previousLength + 1,
                        endIndex: fanoutIndex + previousLength + branch.steps.length,
                    }
                })
                const branchIds = branches.map(branch => branch.id)
                const maxErrored = step.max_errored ?? 0
                publicToFlat[publicIndex] = fanoutIndex
                if (joinStep !== undefined) publicToFlat[publicIndex + 1] = joinIndex
                loweredSteps.push({
                    kind: "fanout",
                    id: step.id,
                    fanout: {
                        branchIds,
                        branchRanges,
                        joinIndex,
                        maxErrored,
                        ...(step.join_policy !== undefined ? { joinPolicy: step.join_policy } : {}),
                        ...(step.quorum !== undefined ? { quorum: step.quorum } : {}),
                        ...(step.required_branches !== undefined ? { requiredBranchIds: step.required_branches } : {}),
                        ...(step.reducer_member !== undefined ? { reducerMember: step.reducer_member } : {}),
                        ...(step.use_survivors === true ? { useSurvivors: true } : {}),
                    },
                })
                for (let branchIndex = 0; branchIndex < branches.length; branchIndex += 1) {
                    const branch = branches[branchIndex]
                    const range = branchRanges[branchIndex]
                    if (branch === undefined || range === undefined) continue
                    for (let branchStepIndex = 0; branchStepIndex < branch.steps.length; branchStepIndex += 1) {
                        const branchStep = branch.steps[branchStepIndex]
                        if (branchStep === undefined) continue
                        switch (branchStep.kind) {
                            case "task":
                            case "gate": {
                                if (!isLinearToolStep(branchStep)) break
                                const branchMetadata: WorkflowBranchMetadata = {
                                    fanoutIndex,
                                    branchId: branch.id,
                                    branchIndex,
                                    joinIndex,
                                }
                                const branchContext: WorkflowBranchContext = {
                                    fanoutStepNumber: publicIndex + 1,
                                    branchId: branch.id,
                                    branchStepNumber: branchStepIndex + 1,
                                }
                                loweredSteps.push(lowerLinearStep(
                                    branchStep,
                                    ref => convertBranchRef(ref, range.startIndex, branch.steps.length),
                                    branchMetadata,
                                    branchContext,
                                ))
                                break
                            }
                            case "fanout":
                            case "join":
                                break
                            default:
                                assertNever(branchStep.kind)
                        }
                    }
                }
                loweredSteps.push({
                    kind: "join",
                    id: joinStep?.kind === "join" ? joinStep.id : undefined,
                    join: {
                        fanoutIndex,
                        branchTailIndices: branchRanges.map(range => range.endIndex),
                        maxErrored,
                        ...(step.join_policy !== undefined ? { joinPolicy: step.join_policy } : {}),
                        ...(step.quorum !== undefined ? { quorum: step.quorum } : {}),
                        ...(step.required_branches !== undefined ? { requiredBranchIds: step.required_branches } : {}),
                        ...(step.reducer_member !== undefined ? { reducerMember: step.reducer_member } : {}),
                        ...(step.use_survivors === true ? { useSurvivors: true } : {}),
                    },
                })
                publicIndex += 1
                break
            }
            default:
                assertNever(step.kind)
        }
    }

    return loweredSteps
}

/** Convert a lowered step to a runtime WorkflowStep with resolved refs and metadata. */
export function toWorkflowStep(
    step: LoweredWorkflowStep,
    steps: readonly LoweredWorkflowStep[],
    index: number,
): WorkflowStep {
    switch (step.kind) {
        case "task":
            return {
                kind: "task",
                id: step.id,
                member: step.member,
                fallbackMember: step.fallback_member,
                task: step.task,
                inputs: resolveWorkflowInputIndices(steps, index),
                exposeOutput: step.expose_output,
                retryOn: step.retry_on === undefined
                    ? undefined
                    : step.retry_on.empty
                      ? { kind: "empty" }
                      : step.retry_on.output_contains !== undefined
                        ? { kind: "output_contains", pattern: step.retry_on.output_contains }
                        : step.retry_on.output_not_contains !== undefined
                          ? { kind: "output_not_contains", pattern: step.retry_on.output_not_contains }
                          : step.retry_on.regex !== undefined
                            ? { kind: "regex", pattern: step.retry_on.regex }
                            : undefined,
                maxTaskRetries: step.max_task_retries,
                taskAttempts: 0,
                approvalBefore: step.approval_before,
                approvalAfter: step.approval_after,
                maxOutputBytes: step.max_output_bytes,
                timeoutMs: step.timeout_ms,
                onTimeout: step.on_timeout ?? "fail",
                maxTimeoutRetries: step.max_timeout_retries,
                timeoutAttempts: 0,
                branch: step.branch,
                completed: false,
            }
        case "gate": {
            const targetIndices = resolveGateTargetIndices(steps, index)
            const where = step.where === undefined ? undefined : parseWorkflowCondition(step.where)
            return {
                kind: "gate",
                id: step.id,
                verifier: step.verifier,
                fallbackVerifier: step.fallback_verifier,
                verifiers: step.verifiers,
                ensemblePolicy: step.ensemble_policy,
                ensembleQuorum: step.ensemble_quorum,
                criteria: step.criteria,
                targetStepIndex: primaryTargetIndex(targetIndices),
                targetStepIndices: step.targets !== undefined ? targetIndices : undefined,
                onFail: step.on_fail ?? "fail",
                maxRetries: step.max_retries,
                attempts: 0,
                onInvalid: step.on_invalid ?? "fail",
                maxInvalidRetries: step.max_invalid_retries,
                invalidAttempts: 0,
                onMalformed: step.on_malformed,
                maxMalformedRetries: step.max_malformed_retries,
                malformedAttempts: 0,
                onPassGoto: resolveGotoIndex(steps, index, step.on_pass_goto),
                onFailGoto: resolveGotoIndex(steps, index, step.on_fail_goto),
                onInvalidGoto: resolveGotoIndex(steps, index, step.on_invalid_goto),
                where: where !== undefined && "condition" in where ? where.condition : undefined,
                approvalBefore: step.approval_before,
                approvalAfter: step.approval_after,
                maxJumps: step.max_jumps,
                jumpCount: 0,
                loop: step.loop === undefined ? undefined : {
                    maxIterations: step.loop.max_iterations,
                    onExhaust: step.loop.on_exhaust ?? "fail",
                },
                loopIterations: 0,
                timeoutMs: step.timeout_ms,
                onTimeout: step.on_timeout ?? "fail",
                maxTimeoutRetries: step.max_timeout_retries,
                timeoutAttempts: 0,
                branch: step.branch,
                completed: false,
            }
        }
        case "fanout":
            return {
                kind: "fanout",
                id: step.id,
                fanout: step.fanout,
                completed: false,
            }
        case "join":
            return {
                kind: "join",
                id: step.id,
                join: step.join,
                completed: false,
            }
        default:
            return assertNever(step)
    }
}

// --- matrix/foreach expansion ---

/** Expand matrix and foreach template fanout steps into explicit branches. */
export function expandMatrixForeachFanout(steps: readonly WorkflowToolStep[]): WorkflowToolStep[] {
    return steps.map(step => {
        if (step.kind !== "fanout") return step
        const matrix = step.matrix
        const foreach = step.foreach
        if (matrix === undefined && foreach === undefined) return step
        if (step.branches !== undefined) return step
        const templateSteps = step.steps ?? []
        if (templateSteps.length === 0) return step
        const branches = matrix !== undefined
            ? expandMatrix(matrix, templateSteps)
            : expandForeach(foreach ?? [], step.as ?? "item", templateSteps)
        const { matrix: _m, foreach: _f, as: _a, steps: _t, ...rest } = step
        return { ...rest, branches } satisfies WorkflowToolStep
    })
}

/** Expand matrix vars into cartesian product branches from template steps. */
function expandMatrix(
    matrix: Readonly<Record<string, readonly string[]>>,
    templateSteps: readonly WorkflowToolStep[],
): WorkflowFanoutBranch[] {
    const keys = Object.keys(matrix)
    const combos = cartesianProduct(keys.map(k => matrix[k] ?? []))
    return combos.map(combo => {
        const vars: Record<string, string> = {}
        keys.forEach((key, i) => { vars[key] = combo[i] ?? "" })
        const branchId = combo.join("_")
        return { id: branchId, steps: substituteVarsInSteps(templateSteps, vars) }
    })
}

/** Expand foreach values into one branch per value using template steps. */
function expandForeach(
    values: readonly string[],
    asName: string,
    templateSteps: readonly WorkflowToolStep[],
): WorkflowFanoutBranch[] {
    return values.map(value => {
        const vars: Record<string, string> = { [asName]: value }
        const branchId = sanitizeBranchId(value)
        return { id: branchId, steps: substituteVarsInSteps(templateSteps, vars) }
    })
}

/** Compute the cartesian product of string arrays for matrix expansion. */
function cartesianProduct(arrays: readonly (readonly string[])[]): readonly (readonly string[])[] {
    if (arrays.length === 0) return [[]]
    return arrays.reduce<readonly (readonly string[])[]>(
        (acc, curr) => acc.flatMap(combo => curr.map(v => [...combo, v])),
        [[]],
    )
}

/** Substitute template variables across all steps in an array. */
function substituteVarsInSteps(steps: readonly WorkflowToolStep[], vars: Record<string, string>): WorkflowToolStep[] {
    return steps.map(step => substituteVarsInStep(step, vars))
}

/** Substitute ${var} placeholders in string fields of a single step. */
function substituteVarsInStep(step: WorkflowToolStep, vars: Record<string, string>): WorkflowToolStep {
    return {
        ...step,
        ...(typeof step.task === "string" ? { task: substituteVars(step.task, vars) } : {}),
        ...(typeof step.criteria === "string" ? { criteria: substituteVars(step.criteria, vars) } : {}),
        ...(typeof step.member === "string" ? { member: substituteVars(step.member, vars) } : {}),
        ...(typeof step.fallback_member === "string"
            ? { fallback_member: substituteVars(step.fallback_member, vars) }
            : {}),
        ...(typeof step.verifier === "string" ? { verifier: substituteVars(step.verifier, vars) } : {}),
        ...(typeof step.fallback_verifier === "string"
            ? { fallback_verifier: substituteVars(step.fallback_verifier, vars) }
            : {}),
        ...(typeof step.reducer_member === "string"
            ? { reducer_member: substituteVars(step.reducer_member, vars) }
            : {}),
    }
}

/** Replace ${name} placeholders with variable values. */
function substituteVars(text: string, vars: Record<string, string>): string {
    return text.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name: string) => vars[name] ?? match)
}

/** Sanitize a foreach value into a safe branch id (alphanumeric, hyphens, underscores only). */
function sanitizeBranchId(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64) || "branch"
}

// --- validation error labels ---
// (dry-run preview formatting lives in format.ts; these two helpers
// serve validation error messages and stay with the lowering engine.)

/** Format a human-readable step location string for validation error output. */
export function stepLocation(
    step: LoweredWorkflowStep,
    displayStep: number,
    includeKind: boolean,
): string {
    switch (step.kind) {
        case "task":
        case "gate": {
            const branchContext = step.branchContext
            if (branchContext !== undefined) {
                const kindTag = includeKind ? ` (${step.kind})` : ""
                return (`fanout step ${branchContext.fanoutStepNumber}`
                    + ` branch "${branchContext.branchId}" step ${branchContext.branchStepNumber}${kindTag}`)
            }
            return includeKind ? `step ${displayStep} (${step.kind})` : `step ${displayStep}`
        }
        case "fanout":
        case "join":
            return includeKind ? `step ${displayStep} (${step.kind})` : `step ${displayStep}`
        default:
            return assertNever(step)
    }
}

/** Format a target step label for validation error messages. */
export function targetStepErrorLabel(
    step: LoweredWorkflowStep,
    targetIndex: number,
): string {
    switch (step.kind) {
        case "task":
        case "gate":
            return step.branchContext === undefined
                ? `target step ${targetIndex + 1}`
                : `target step ${step.branchContext.branchStepNumber}`
        case "fanout":
        case "join":
            return `target step ${targetIndex + 1}`
        default:
            return assertNever(step)
    }
}


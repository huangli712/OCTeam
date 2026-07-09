/**
 * Workflow step lowering: converts public WorkflowToolStep[] into the internal
 * LoweredWorkflowStep[] representation (flat fanout branches, resolved refs).
 * Also handles matrix/foreach expansion and dry-run label formatting.
 *
 * Extracted from tools/workflow.ts.
 */

import type {
    WorkflowBranchMetadata,
    WorkflowFanoutMetadata,
    WorkflowJoinMetadata,
    WorkflowStep,
} from "../core/types.js"
import type { Team } from "../state/store.js"
import { parseWorkflowCondition, formatWorkflowCondition } from "../orchestration/gate.js"
import type {
    WorkflowFanoutBranch,
    WorkflowLinearToolStep,
    WorkflowStepRef,
    WorkflowToolStep,
} from "./workflow.js"

// --- lowered types ---

export type WorkflowBranchContext = {
    readonly fanoutStepNumber: number
    readonly branchId: string
    readonly branchStepNumber: number
}

export type LoweredWorkflowLinearStep = WorkflowLinearToolStep & {
    readonly branch?: WorkflowBranchMetadata
    readonly branchContext?: WorkflowBranchContext
}

export type LoweredWorkflowFanoutStep = {
    readonly kind: "fanout"
    readonly id?: string
    readonly fanout: WorkflowFanoutMetadata
}

export type LoweredWorkflowJoinStep = {
    readonly kind: "join"
    readonly id?: string
    readonly join: WorkflowJoinMetadata
}

export type LoweredWorkflowStep = LoweredWorkflowLinearStep | LoweredWorkflowFanoutStep | LoweredWorkflowJoinStep

// --- invariant guard ---

class WorkflowToolInvariantError extends Error {
    constructor(value: never) {
        super(`Unexpected workflow tool step kind: ${String(value)}`)
        this.name = "WorkflowToolInvariantError"
    }
}

export function assertNever(value: never): never {
    throw new WorkflowToolInvariantError(value)
}

// --- type guards ---

export function isLinearToolStep(step: WorkflowToolStep): step is WorkflowLinearToolStep {
    return step.kind === "task" || step.kind === "gate"
}

export function isFanoutToolStep(step: WorkflowToolStep): step is import("./workflow.js").WorkflowFanoutToolStep {
    return step.kind === "fanout"
}

// --- ref resolution (lowered) ---

export function resolveGateTargetRef(steps: readonly LoweredWorkflowStep[], gateIndex: number, target: WorkflowStepRef): number {
    if (typeof target === "number") {
        const idx = target - 1
        return idx >= 0 && idx < gateIndex && steps[idx]?.kind === "task" ? idx : -1
    }
    const idx = steps.findIndex((s, i) => i < gateIndex && s.kind === "task" && s.id === target)
    return idx
}

export function resolveGateTargetIndex(steps: readonly LoweredWorkflowStep[], gateIndex: number): number {
    const gate = steps[gateIndex]
    if (gate?.kind !== "gate") return -1
    const target = gate.target_step
    if (target === undefined) {
        for (let i = gateIndex - 1; i >= 0; i--) {
            if (steps[i]?.kind === "task") return i
        }
        return -1
    }
    return resolveGateTargetRef(steps, gateIndex, target)
}

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

export function resolveWorkflowInputRef(steps: readonly LoweredWorkflowStep[], consumerIndex: number, ref: WorkflowStepRef): number {
    const idx = typeof ref === "number"
        ? ref - 1
        : steps.findIndex((step, index) => index < consumerIndex && step.id === ref)
    const input = steps[idx]
    if (idx < 0 || idx >= consumerIndex || (input?.kind !== "task" && input?.kind !== "join")) return -1
    return idx
}

export function resolveWorkflowInputIndices(steps: readonly LoweredWorkflowStep[], consumerIndex: number): number[] | undefined {
    const step = steps[consumerIndex]
    if (step?.kind !== "task" || step.inputs === undefined) return undefined
    return step.inputs.map(input => resolveWorkflowInputRef(steps, consumerIndex, input))
}

export function canConsumeWorkflowInput(steps: readonly LoweredWorkflowStep[], consumerIndex: number, inputIndex: number): boolean {
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

export function primaryTargetIndex(indices: number[]): number | undefined {
    return indices.length === 0 ? undefined : indices[0]
}

export function resolveGotoIndex(steps: readonly LoweredWorkflowStep[], gateIndex: number, ref: WorkflowStepRef | undefined): number {
    if (ref === undefined) return -1
    if (typeof ref === "number") {
        const idx = ref - 1
        return idx >= 0 && idx < steps.length && idx !== gateIndex ? idx : -1
    }
    const idx = steps.findIndex((s, i) => i !== gateIndex && s.id === ref)
    return idx
}

export function resolvesToMarkerStep(steps: readonly LoweredWorkflowStep[], gateIndex: number, ref: WorkflowStepRef): boolean {
    const idx = typeof ref === "number"
        ? ref - 1
        : steps.findIndex((s, i) => i < gateIndex && s.id === ref)
    if (idx < 0 || idx >= gateIndex) return false
    const target = steps[idx]
    if (target === undefined) return false
    switch (target.kind) {
        case "fanout":
        case "join":
            return true
        case "task":
        case "gate":
            return false
        default:
            return assertNever(target)
    }
}

// --- ref conversion (public → flat) ---

export function convertTopLevelRef(ref: WorkflowStepRef, publicToFlat: readonly number[]): WorkflowStepRef {
    if (typeof ref === "string") return ref
    const flatIndex = publicToFlat[ref - 1]
    return flatIndex === undefined ? ref : flatIndex + 1
}

export function convertBranchRef(ref: WorkflowStepRef, branchStartIndex: number, branchStepCount: number): WorkflowStepRef {
    if (typeof ref === "string") return ref
    const localIndex = ref - 1
    return localIndex >= 0 && localIndex < branchStepCount ? branchStartIndex + localIndex + 1 : ref
}

export function resolvePublicTaskRef(steps: readonly WorkflowToolStep[], gateIndex: number, target: WorkflowStepRef): number {
    if (typeof target === "number") {
        const idx = target - 1
        return idx >= 0 && idx < gateIndex && steps[idx]?.kind === "task" ? idx : -1
    }
    return steps.findIndex((step, index) => index < gateIndex && step.kind === "task" && step.id === target)
}

export function resolvePublicGateTargetIndex(steps: readonly WorkflowToolStep[], gateIndex: number): number {
    const gate = steps[gateIndex]
    if (gate?.kind !== "gate") return -1
    if (gate.target_step !== undefined) return resolvePublicTaskRef(steps, gateIndex, gate.target_step)
    for (let index = gateIndex - 1; index >= 0; index -= 1) {
        if (steps[index]?.kind === "task") return index
    }
    return -1
}

export function resolvePublicGotoRef(steps: readonly WorkflowToolStep[], gateIndex: number, ref: WorkflowStepRef): number {
    if (typeof ref === "number") {
        const idx = ref - 1
        return idx >= 0 && idx < steps.length && idx !== gateIndex ? idx : -1
    }
    return steps.findIndex((step, index) => index !== gateIndex && step.id === ref)
}

// --- step lowering ---

export function lowerLinearStep(
    step: WorkflowLinearToolStep,
    convertRef: (ref: WorkflowStepRef) => WorkflowStepRef,
    branch: WorkflowBranchMetadata | undefined,
    branchContext: WorkflowBranchContext | undefined,
): LoweredWorkflowLinearStep {
    const inputLowered = step.inputs === undefined ? step : { ...step, inputs: step.inputs.map(input => convertRef(input)) }
    if (step.kind === "task") {
        return branch === undefined || branchContext === undefined ? inputLowered : { ...inputLowered, branch, branchContext }
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
                loweredSteps.push(lowerLinearStep(step, ref => convertTopLevelRef(ref, publicToFlat), undefined, undefined))
                break
            case "join":
                publicToFlat[publicIndex] = loweredSteps.length
                loweredSteps.push({ kind: "join", id: step.id, join: { fanoutIndex: -1, branchTailIndices: [], maxErrored: 0 } })
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

export function toWorkflowStep(step: LoweredWorkflowStep, steps: readonly LoweredWorkflowStep[], index: number): WorkflowStep {
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

function expandMatrix(matrix: Readonly<Record<string, readonly string[]>>, templateSteps: readonly WorkflowToolStep[]): WorkflowFanoutBranch[] {
    const keys = Object.keys(matrix)
    const combos = cartesianProduct(keys.map(k => matrix[k] ?? []))
    return combos.map(combo => {
        const vars: Record<string, string> = {}
        keys.forEach((key, i) => { vars[key] = combo[i] ?? "" })
        const branchId = combo.join("_")
        return { id: branchId, steps: substituteVarsInSteps(templateSteps, vars) }
    })
}

function expandForeach(values: readonly string[], asName: string, templateSteps: readonly WorkflowToolStep[]): WorkflowFanoutBranch[] {
    return values.map(value => {
        const vars: Record<string, string> = { [asName]: value }
        const branchId = sanitizeBranchId(value)
        return { id: branchId, steps: substituteVarsInSteps(templateSteps, vars) }
    })
}

function cartesianProduct(arrays: readonly (readonly string[])[]): readonly (readonly string[])[] {
    if (arrays.length === 0) return [[]]
    return arrays.reduce<readonly (readonly string[])[]>(
        (acc, curr) => acc.flatMap(combo => curr.map(v => [...combo, v])),
        [[]],
    )
}

function substituteVarsInSteps(steps: readonly WorkflowToolStep[], vars: Record<string, string>): WorkflowToolStep[] {
    return steps.map(step => substituteVarsInStep(step, vars))
}

function substituteVarsInStep(step: WorkflowToolStep, vars: Record<string, string>): WorkflowToolStep {
    return {
        ...step,
        ...(typeof step.task === "string" ? { task: substituteVars(step.task, vars) } : {}),
        ...(typeof step.criteria === "string" ? { criteria: substituteVars(step.criteria, vars) } : {}),
        ...(typeof step.member === "string" ? { member: substituteVars(step.member, vars) } : {}),
        ...(typeof step.fallback_member === "string" ? { fallback_member: substituteVars(step.fallback_member, vars) } : {}),
        ...(typeof step.verifier === "string" ? { verifier: substituteVars(step.verifier, vars) } : {}),
        ...(typeof step.fallback_verifier === "string" ? { fallback_verifier: substituteVars(step.fallback_verifier, vars) } : {}),
        ...(typeof step.reducer_member === "string" ? { reducer_member: substituteVars(step.reducer_member, vars) } : {}),
    }
}

function substituteVars(text: string, vars: Record<string, string>): string {
    return text.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name: string) => vars[name] ?? match)
}

function sanitizeBranchId(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64) || "branch"
}

// --- dry-run labels ---

export function stepLocation(step: LoweredWorkflowStep, displayStep: number, includeKind: boolean): string {
    switch (step.kind) {
        case "task":
        case "gate": {
            const branchContext = step.branchContext
            if (branchContext !== undefined) {
                const kindTag = includeKind ? ` (${step.kind})` : ""
                return `fanout step ${branchContext.fanoutStepNumber} branch "${branchContext.branchId}" step ${branchContext.branchStepNumber}${kindTag}`
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

export function targetStepErrorLabel(step: LoweredWorkflowStep, targetIndex: number): string {
    switch (step.kind) {
        case "task":
        case "gate":
            return step.branchContext === undefined ? `target step ${targetIndex + 1}` : `target step ${step.branchContext.branchStepNumber}`
        case "fanout":
        case "join":
            return `target step ${targetIndex + 1}`
        default:
            return assertNever(step)
    }
}

// --- dry-run formatting ---

function stepTargetLabel(steps: readonly LoweredWorkflowStep[], gateIndex: number): string {
    const targetIndices = resolveGateTargetIndices(steps, gateIndex)
    if (targetIndices.length === 0) return "?"
    const labels = targetIndices.map(targetIndex => {
        const targetId = steps[targetIndex]?.id
        return targetId ? `${targetIndex + 1} (${targetId})` : `${targetIndex + 1}`
    })
    const first = labels[0]
    if (first === undefined) return "?"
    return labels.length === 1 ? `step ${first}` : `steps ${labels.join(", ")}`
}

function workflowStepLabel(steps: readonly LoweredWorkflowStep[], index: number): string {
    const id = steps[index]?.id
    return id ? `step ${index + 1} (${id})` : `step ${index + 1}`
}

function taskInputsLabel(steps: readonly LoweredWorkflowStep[], taskIndex: number): string | null {
    const inputIndices = resolveWorkflowInputIndices(steps, taskIndex)
    if (inputIndices === undefined) return null
    return `inputs=${inputIndices.map(index => workflowStepLabel(steps, index)).join(", ")}`
}

function whereLabel(where: import("./workflow.js").WorkflowWhere | undefined): string {
    if (where === undefined) return ""
    const parsed = parseWorkflowCondition(where)
    return "condition" in parsed ? ` when ${formatWorkflowCondition(parsed.condition)}` : ""
}

function gotoRefLabel(steps: readonly LoweredWorkflowStep[], gateIndex: number, ref: WorkflowStepRef): string {
    const idx = resolveGotoIndex(steps, gateIndex, ref)
    const id = idx >= 0 ? steps[idx]?.id : undefined
    return id ? `step ${idx + 1} (${id})` : idx >= 0 ? `step ${idx + 1}` : "?"
}

function branchDryRunPrefix(step: LoweredWorkflowLinearStep, activeBranchId: string | undefined): { readonly lines: readonly string[]; readonly activeBranchId: string | undefined } {
    const branchId = step.branchContext?.branchId
    if (branchId === undefined) return { lines: [], activeBranchId: undefined }
    if (branchId === activeBranchId) return { lines: [], activeBranchId }
    return { lines: [`  branch ${branchId}:`], activeBranchId: branchId }
}

export function formatWorkflowDryRun(args: import("./workflow.js").ResolvedWorkflowToolArgs): string {
    const loweredSteps = lowerWorkflowSteps(args.steps)
    const lines = [`Workflow dry run for "${args.team_id}" (${loweredSteps.length} step(s)):`]
    let activeBranchId: string | undefined
    for (let i = 0; i < loweredSteps.length; i++) {
        const step = loweredSteps[i]
        if (step === undefined) continue
        const idTag = step.id ? ` (${step.id})` : ""
        switch (step.kind) {
            case "task": {
                const branchPrefix = branchDryRunPrefix(step, activeBranchId)
                activeBranchId = branchPrefix.activeBranchId
                lines.push(...branchPrefix.lines)
                const controls: string[] = []
                if (step.approval_before) controls.push("approval_before")
                if (step.approval_after) controls.push("approval_after")
                if (step.fallback_member !== undefined) controls.push(`fallback_member=${step.fallback_member}`)
                if (step.max_output_bytes !== undefined) controls.push(`max_output_bytes=${step.max_output_bytes}`)
                if (step.expose_output === false) controls.push("expose_output=false")
                const inputs = taskInputsLabel(loweredSteps, i)
                if (inputs !== null) controls.push(inputs)
                const ctrlTag = controls.length > 0 ? `  [${controls.join(", ")}]` : ""
                const indent = step.branchContext === undefined ? "" : "  "
                lines.push(`${indent}${i + 1}. [task]${idTag} ${step.member ?? "?"}: ${step.task ?? ""}${ctrlTag}`)
                break
            }
            case "gate": {
                const branchPrefix = branchDryRunPrefix(step, activeBranchId)
                activeBranchId = branchPrefix.activeBranchId
                lines.push(...branchPrefix.lines)
                const controls: string[] = []
                if (step.approval_before) controls.push("approval_before")
                if (step.approval_after) controls.push("approval_after")
                if (step.fallback_verifier !== undefined) controls.push(`fallback_verifier=${step.fallback_verifier}`)
                const ctrlTag = controls.length > 0 ? `  [${controls.join(", ")}]` : ""
                const target = stepTargetLabel(loweredSteps, i)
                const retry = step.on_fail === "retry" ? `; on_fail=retry max_retries=${step.max_retries}` : step.on_fail === "skip" ? "; on_fail=skip" : ""
                const invalid = step.on_invalid && step.on_invalid !== "fail"
                    ? `; on_invalid=${step.on_invalid}${step.on_invalid === "retry_verifier" ? ` max_invalid_retries=${step.max_invalid_retries}` : ""}`
                    : ""
                const jumps: string[] = []
                const where = whereLabel(step.where)
                if (step.on_pass_goto !== undefined) jumps.push(`on_pass->${gotoRefLabel(loweredSteps, i, step.on_pass_goto)}${where}`)
                if (step.on_fail_goto !== undefined) jumps.push(`on_fail->${gotoRefLabel(loweredSteps, i, step.on_fail_goto)}${where}`)
                if (step.on_invalid_goto !== undefined) jumps.push(`on_invalid->${gotoRefLabel(loweredSteps, i, step.on_invalid_goto)}`)
                const jumpTag = jumps.length > 0 ? `; ${jumps.join(" ")} (max_jumps=${step.max_jumps ?? 3})` : ""
                const indent = step.branchContext === undefined ? "" : "  "
                lines.push(`${indent}${i + 1}. [gate]${idTag} ${step.verifier ?? "?"} verifies ${target}: ${step.criteria ?? ""}${retry}${invalid}${jumpTag}${ctrlTag}`)
                break
            }
            case "fanout": {
                activeBranchId = undefined
                const join = loweredSteps[step.fanout.joinIndex]
                const joinIdTag = join?.id ? ` (${join.id})` : ""
                const controls = [`max_errored=${step.fanout.maxErrored}`]
                if (step.fanout.joinPolicy !== undefined) controls.push(`join_policy=${step.fanout.joinPolicy}`)
                if (step.fanout.quorum !== undefined) controls.push(`quorum=${step.fanout.quorum}`)
                if (step.fanout.requiredBranchIds !== undefined) controls.push(`required_branches=${step.fanout.requiredBranchIds.join(",")}`)
                if (step.fanout.reducerMember !== undefined) controls.push(`reducer_member=${step.fanout.reducerMember}`)
                if (step.fanout.useSurvivors === true) controls.push("use_survivors=true")
                lines.push(`${i + 1}. [fanout]${idTag} branches: ${step.fanout.branchIds.join(", ")} -> join step ${step.fanout.joinIndex + 1}${joinIdTag}; ${controls.join("; ")}`)
                break
            }
            case "join": {
                activeBranchId = undefined
                const fanout = loweredSteps[step.join.fanoutIndex]
                const branchIds = fanout?.kind === "fanout" ? fanout.fanout.branchIds : []
                const controls = [`max_errored=${step.join.maxErrored}`]
                if (step.join.joinPolicy !== undefined) controls.push(`join_policy=${step.join.joinPolicy}`)
                if (step.join.reducerMember !== undefined) controls.push(`reducer_member=${step.join.reducerMember}`)
                if (step.join.useSurvivors === true) controls.push("use_survivors=true")
                lines.push(`${i + 1}. [join]${idTag} waits for all branches to reach a terminal state before applying join policy; branches: ${branchIds.join(", ")}; ${controls.join("; ")}`)
                break
            }
            default:
                assertNever(step)
        }
    }
    return lines.join("\n")
}

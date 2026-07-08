/**
 * team_workflow tool -- deterministic, declaratively-composed linear step
 * engine (GAP-2). Each step is either a `task` (one member produces output) or
 * a `gate` (a verifier renders a PASS/FAIL verdict over one or more prior task
 * outputs). The engine -- not the master LLM -- drives every step transition,
 * keeping intermediate results out of master context. No fanout/route/loop step
 * kinds.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import type {
    WorkflowBranchMetadata,
    WorkflowFanoutMetadata,
    WorkflowJoinMetadata,
    WorkflowStep,
    WorkflowTask,
} from "../core/types.js"
import { formatWorkflowCondition, parseWorkflowCondition } from "../core/workflow-conditions.js"
import { activationError } from "../core/utils.js"
import { dispatchToMember } from "../orchestration/dispatch.js"
import { maybePauseBeforeWorkflowStep } from "../orchestration/workflow.js"
import { resolveCallerInTeam } from "../state/resolve.js"
import { loadTeamState, type Team } from "../state/store.js"
import { loadWorkflowFile } from "./workflow-file.js"
import {
    DEFAULT_TIMEOUT_MS,
    baseTaskFields,
    humanApprovalSchemaFields,
    humanApprovalTaskFields,
    signoffSchemaFields,
    signoffTaskFields,
    startOrchestration,
    validateSignoff,
} from "./shared.js"

type WorkflowWhere = {
    readonly score_gte?: number
    readonly score_lt?: number
    readonly confidence_gte?: number
    readonly has_issue_severity?: "low" | "medium" | "high" | "critical"
}

type WorkflowStepRef = number | string

export type WorkflowToolStep = {
    readonly kind: "task" | "gate" | "fanout" | "join"
    readonly id?: string
    readonly member?: string
    readonly task?: string
    readonly verifier?: string
    readonly criteria?: string
    readonly target_step?: WorkflowStepRef
    readonly targets?: readonly WorkflowStepRef[]
    readonly inputs?: readonly WorkflowStepRef[]
    readonly expose_output?: boolean
    readonly on_fail?: "retry" | "fail"
    readonly max_retries?: number
    readonly on_invalid?: "fail" | "retry_verifier" | "escalate"
    readonly max_invalid_retries?: number
    readonly on_pass_goto?: WorkflowStepRef
    readonly on_fail_goto?: WorkflowStepRef
    readonly on_invalid_goto?: WorkflowStepRef
    readonly where?: WorkflowWhere
    readonly approval_before?: boolean
    readonly approval_after?: boolean
    readonly max_output_bytes?: number
    readonly timeout_ms?: number
    readonly on_timeout?: "fail" | "retry" | "skip"
    readonly max_timeout_retries?: number
    readonly max_jumps?: number
    readonly branches?: readonly WorkflowFanoutBranch[]
    readonly max_errored?: number
    readonly join_policy?: "all" | "quorum" | "any_success" | "required_branches" | "reduce"
    readonly quorum?: number
    readonly required_branches?: readonly string[]
    readonly reducer_member?: string
    readonly matrix?: Readonly<Record<string, readonly string[]>>
    readonly foreach?: readonly string[]
    readonly as?: string
    readonly steps?: readonly WorkflowToolStep[]  // template steps for matrix/foreach fanout
}

type WorkflowLinearToolStep = WorkflowToolStep & { readonly kind: "task" | "gate" }

type WorkflowFanoutBranch = {
    readonly id: string
    readonly steps: readonly WorkflowToolStep[]
}

type WorkflowFanoutToolStep = WorkflowToolStep & { readonly kind: "fanout" }

type WorkflowBranchContext = {
    readonly fanoutStepNumber: number
    readonly branchId: string
    readonly branchStepNumber: number
}

type LoweredWorkflowLinearStep = WorkflowLinearToolStep & {
    readonly branch?: WorkflowBranchMetadata
    readonly branchContext?: WorkflowBranchContext
}

type LoweredWorkflowFanoutStep = {
    readonly kind: "fanout"
    readonly id?: string
    readonly fanout: WorkflowFanoutMetadata
}

type LoweredWorkflowJoinStep = {
    readonly kind: "join"
    readonly id?: string
    readonly join: WorkflowJoinMetadata
}

type LoweredWorkflowStep = LoweredWorkflowLinearStep | LoweredWorkflowFanoutStep | LoweredWorkflowJoinStep

class WorkflowToolInvariantError extends Error {
    constructor(value: never) {
        super(`Unexpected workflow tool step kind: ${String(value)}`)
        this.name = "WorkflowToolInvariantError"
    }
}

function assertNever(value: never): never {
    throw new WorkflowToolInvariantError(value)
}

function isLinearToolStep(step: WorkflowToolStep): step is WorkflowLinearToolStep {
    return step.kind === "task" || step.kind === "gate"
}

function isFanoutToolStep(step: WorkflowToolStep): step is WorkflowFanoutToolStep {
    return step.kind === "fanout"
}

type WorkflowToolArgs = {
    team_id: string
    steps?: readonly WorkflowToolStep[]
    workflow_file?: string
    vars?: Record<string, string>
    dry_run?: boolean
    signoff_policy?: "none" | "decider" | "peer-quorum"
    signoff_decider?: string
}

type ResolvedWorkflowToolArgs = Omit<WorkflowToolArgs, "steps"> & { steps: readonly WorkflowToolStep[] }

/**
 * Resolve a gate target reference (number 1-based or string step id).
 * Returns -1 when the target cannot be resolved or points forward/to a gate.
 */
function resolveGateTargetRef(steps: readonly LoweredWorkflowStep[], gateIndex: number, target: WorkflowStepRef): number {
    if (typeof target === "number") {
        const idx = target - 1
        return idx >= 0 && idx < gateIndex && steps[idx]?.kind === "task" ? idx : -1
    }
    const idx = steps.findIndex((s, i) => i < gateIndex && s.kind === "task" && s.id === target)
    return idx
}

/** Resolve the primary single target, or nearest preceding task when omitted. */
function resolveGateTargetIndex(steps: readonly LoweredWorkflowStep[], gateIndex: number): number {
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

/** Resolve all gate targets. `targets` wins; otherwise this is the single target. */
function resolveGateTargetIndices(steps: readonly LoweredWorkflowStep[], gateIndex: number): number[] {
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

function resolveWorkflowInputRef(steps: readonly LoweredWorkflowStep[], consumerIndex: number, ref: WorkflowStepRef): number {
    const idx = typeof ref === "number"
        ? ref - 1
        : steps.findIndex((step, index) => index < consumerIndex && step.id === ref)
    const input = steps[idx]
    if (idx < 0 || idx >= consumerIndex || (input?.kind !== "task" && input?.kind !== "join")) return -1
    return idx
}

function resolveWorkflowInputIndices(steps: readonly LoweredWorkflowStep[], consumerIndex: number): number[] | undefined {
    const step = steps[consumerIndex]
    if (step?.kind !== "task" || step.inputs === undefined) return undefined
    return step.inputs.map(input => resolveWorkflowInputRef(steps, consumerIndex, input))
}

function canConsumeWorkflowInput(steps: readonly LoweredWorkflowStep[], consumerIndex: number, inputIndex: number): boolean {
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

function primaryTargetIndex(indices: number[]): number | undefined {
    return indices.length === 0 ? undefined : indices[0]
}

/**
 * Resolve a verdict-driven goto target (1-based number or step id) to a 0-based
 * step index. Unlike gate target_step, a goto may reference ANY step (task or
 * gate) except the gate itself. Returns -1 when unresolvable.
 */
function resolveGotoIndex(steps: readonly LoweredWorkflowStep[], gateIndex: number, ref: WorkflowStepRef | undefined): number {
    if (ref === undefined) return -1
    if (typeof ref === "number") {
        const idx = ref - 1
        return idx >= 0 && idx < steps.length && idx !== gateIndex ? idx : -1
    }
    const idx = steps.findIndex((s, i) => i !== gateIndex && s.id === ref)
    return idx
}

function resolvesToMarkerStep(steps: readonly LoweredWorkflowStep[], gateIndex: number, ref: WorkflowStepRef): boolean {
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

function isTeamMember(team: Team, name: string): boolean {
    return team.members.some(member => member.name === name)
}

function convertTopLevelRef(ref: WorkflowStepRef, publicToFlat: readonly number[]): WorkflowStepRef {
    if (typeof ref === "string") return ref
    const flatIndex = publicToFlat[ref - 1]
    return flatIndex === undefined ? ref : flatIndex + 1
}

function convertBranchRef(ref: WorkflowStepRef, branchStartIndex: number, branchStepCount: number): WorkflowStepRef {
    if (typeof ref === "string") return ref
    const localIndex = ref - 1
    return localIndex >= 0 && localIndex < branchStepCount ? branchStartIndex + localIndex + 1 : ref
}

function resolvePublicTaskRef(steps: readonly WorkflowToolStep[], gateIndex: number, target: WorkflowStepRef): number {
    if (typeof target === "number") {
        const idx = target - 1
        return idx >= 0 && idx < gateIndex && steps[idx]?.kind === "task" ? idx : -1
    }
    return steps.findIndex((step, index) => index < gateIndex && step.kind === "task" && step.id === target)
}

function resolvePublicGateTargetIndex(steps: readonly WorkflowToolStep[], gateIndex: number): number {
    const gate = steps[gateIndex]
    if (gate?.kind !== "gate") return -1
    if (gate.target_step !== undefined) return resolvePublicTaskRef(steps, gateIndex, gate.target_step)
    for (let index = gateIndex - 1; index >= 0; index -= 1) {
        if (steps[index]?.kind === "task") return index
    }
    return -1
}

function resolvePublicGotoRef(steps: readonly WorkflowToolStep[], gateIndex: number, ref: WorkflowStepRef): number {
    if (typeof ref === "number") {
        const idx = ref - 1
        return idx >= 0 && idx < steps.length && idx !== gateIndex ? idx : -1
    }
    return steps.findIndex((step, index) => index !== gateIndex && step.id === ref)
}

function lowerLinearStep(
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

function lowerWorkflowSteps(steps: readonly WorkflowToolStep[]): readonly LoweredWorkflowStep[] {
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

function validateDuplicateStepIds(steps: readonly WorkflowToolStep[]): string | null {
    const ids = new Map<string, number>()

    for (let publicIndex = 0; publicIndex < steps.length; publicIndex += 1) {
        const step = steps[publicIndex]
        if (step === undefined) continue
        const displayStep = publicIndex + 1
        const duplicate = validateStepId(ids, step.id, displayStep)
        if (duplicate !== null) return duplicate
        if (step.kind !== "fanout") continue
        for (const branch of step.branches ?? []) {
            for (let branchStepIndex = 0; branchStepIndex < branch.steps.length; branchStepIndex += 1) {
                const branchStep = branch.steps[branchStepIndex]
                if (branchStep === undefined) continue
                const branchDuplicate = validateStepId(ids, branchStep.id, displayStep)
                if (branchDuplicate !== null) return branchDuplicate
            }
        }
    }

    return null
}

function validateStepId(ids: Map<string, number>, id: string | undefined, displayStep: number): string | null {
    if (id === undefined) return null
    const previous = ids.get(id)
    if (previous !== undefined) return `Error: duplicate step id "${id}" at steps ${previous} and ${displayStep}`
    ids.set(id, displayStep)
    return null
}

function validatePublicWorkflowShape(steps: readonly WorkflowToolStep[]): string | null {
    const duplicateStepId = validateDuplicateStepIds(steps)
    if (duplicateStepId !== null) return duplicateStepId

    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]
        if (step === undefined) continue
        switch (step.kind) {
            case "task":
            case "gate":
                break
            case "join":
                if (steps[index - 1]?.kind !== "fanout") {
                    return `Error: join step ${index + 1} has no matching fanout step`
                }
                break
            case "fanout": {
                if (steps[index + 1]?.kind !== "join") {
                    return `Error: fanout step ${index + 1} must be followed by a join step`
                }
                if (!isFanoutToolStep(step)) break
                const branchError = validateFanoutBranches(step, index + 1)
                if (branchError !== null) return branchError
                const policyError = validateFanoutJoinPolicy(step, index + 1)
                if (policyError !== null) return policyError
                break
            }
            default:
                assertNever(step.kind)
        }
    }

    return null
}

/** Pre-expansion shape check for matrix/foreach fanout syntax sugar. */
function validateMatrixForeachShapeInSteps(steps: readonly WorkflowToolStep[]): string | null {
    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]
        if (step === undefined || step.kind !== "fanout") continue
        const err = validateMatrixForeachShape(step, index + 1)
        if (err !== null) return err
    }
    return null
}

function validateMatrixForeachShape(step: WorkflowToolStep, displayStep: number): string | null {
    const hasMatrix = step.matrix !== undefined
    const hasForeach = step.foreach !== undefined
    const hasBranches = (step.branches ?? []).length > 0
    if (hasMatrix && hasForeach) return `Error: fanout step ${displayStep} must not set both matrix and foreach`
    if ((hasMatrix || hasForeach) && hasBranches) return `Error: fanout step ${displayStep} must not set both matrix/foreach and branches`
    if (hasMatrix || hasForeach) {
        if ((step.steps ?? []).length === 0) return `Error: fanout step ${displayStep} with matrix/foreach requires template \`steps\``
    }
    return null
}

function validateFanoutJoinPolicy(step: WorkflowFanoutToolStep, displayStep: number): string | null {
    const policy = step.join_policy
    if (policy === undefined) return null
    const branchIds = (step.branches ?? []).map(branch => branch.id)
    switch (policy) {
        case "all":
        case "any_success":
        case "reduce":
            break
        case "quorum": {
            if (step.quorum === undefined) return `Error: fanout step ${displayStep} join_policy='quorum' requires \`quorum\``
            if (!(step.quorum > 0 && step.quorum <= 1)) return `Error: fanout step ${displayStep} quorum must be > 0 and <= 1`
            break
        }
        case "required_branches": {
            if (step.required_branches === undefined || step.required_branches.length === 0) {
                return `Error: fanout step ${displayStep} join_policy='required_branches' requires \`required_branches\``
            }
            for (const requiredId of step.required_branches) {
                if (!branchIds.includes(requiredId)) {
                    return `Error: fanout step ${displayStep} required_branches references unknown branch "${requiredId}"`
                }
            }
            break
        }
        default:
            return `Error: fanout step ${displayStep} unknown join_policy "${String(policy)}"`
    }
    if (policy === "reduce" && step.reducer_member === undefined) {
        return `Error: fanout step ${displayStep} join_policy='reduce' requires \`reducer_member\``
    }
    return null
}

 function validateFanoutBranches(step: WorkflowFanoutToolStep, displayStep: number): string | null {
    const branches = step.branches ?? []
    if (branches.length === 0) return `Error: fanout step ${displayStep} requires at least one branch`
    const maxErrored = step.max_errored ?? 0
    const maxAllowed = branches.length - 1
    if (!Number.isInteger(maxErrored) || maxErrored < 0 || maxErrored > maxAllowed) {
        return `Error: fanout step ${displayStep} max_errored must be an integer from 0 to ${maxAllowed}`
    }

    const branchIds = new Set<string>()
    const branchByMember = new Map<string, string>()
    for (const branch of branches) {
        if (branchIds.has(branch.id)) return `Error: duplicate fanout branch id "${branch.id}" at fanout step ${displayStep}`
        branchIds.add(branch.id)
        if (branch.steps.length === 0) return `Error: fanout step ${displayStep} branch "${branch.id}" must contain at least one step`

        const branchError = validateBranchSteps(branch, displayStep, branchByMember)
        if (branchError !== null) return branchError
    }

    return null
}

function registerFanoutBranchActor(
    branchByMember: Map<string, string>,
    member: string | undefined,
    fanoutDisplayStep: number,
    branchId: string,
): string | null {
    if (member === undefined) return null
    const existingBranch = branchByMember.get(member)
    if (existingBranch !== undefined && existingBranch !== branchId) {
        return `Error: fanout step ${fanoutDisplayStep} uses member "${member}" in concurrent branches "${existingBranch}" and "${branchId}"`
    }
    branchByMember.set(member, branchId)
    return null
}

function validateBranchTimeoutPolicy(step: WorkflowToolStep, fanoutDisplayStep: number, branchId: string, displayStep: number): string | null {
    if (step.on_timeout === "retry" || step.on_timeout === "skip") {
        return `Error: fanout step ${fanoutDisplayStep} branch "${branchId}" step ${displayStep} must not set on_timeout='retry' or on_timeout='skip'`
    }
    if (step.max_timeout_retries !== undefined) {
        return `Error: fanout step ${fanoutDisplayStep} branch "${branchId}" step ${displayStep} must not set max_timeout_retries`
    }
    return null
}

function validateBranchSteps(
    branch: WorkflowFanoutBranch,
    fanoutDisplayStep: number,
    branchByMember: Map<string, string>,
): string | null {
    for (let index = 0; index < branch.steps.length; index += 1) {
        const step = branch.steps[index]
        if (step === undefined) continue
        const displayStep = index + 1
        switch (step.kind) {
            case "fanout":
                return `Error: fanout step ${fanoutDisplayStep} branch "${branch.id}" must not contain recursive fanout`
            case "join":
                return `Error: fanout step ${fanoutDisplayStep} branch "${branch.id}" must not contain join`
            case "task":
                if (step.approval_before === true || step.approval_after === true) {
                    return `Error: fanout step ${fanoutDisplayStep} branch "${branch.id}" step ${displayStep} must not set approval_before/approval_after`
                }
                {
                    const timeoutError = validateBranchTimeoutPolicy(step, fanoutDisplayStep, branch.id, displayStep)
                    if (timeoutError !== null) return timeoutError
                }
                {
                    const actorError = registerFanoutBranchActor(branchByMember, step.member, fanoutDisplayStep, branch.id)
                    if (actorError !== null) return actorError
                }
                break
            case "gate": {
                if (step.approval_before === true || step.approval_after === true) {
                    return `Error: fanout step ${fanoutDisplayStep} branch "${branch.id}" step ${displayStep} must not set approval_before/approval_after`
                }
                const timeoutError = validateBranchTimeoutPolicy(step, fanoutDisplayStep, branch.id, displayStep)
                if (timeoutError !== null) return timeoutError
                const actorError = registerFanoutBranchActor(branchByMember, step.verifier, fanoutDisplayStep, branch.id)
                if (actorError !== null) return actorError
                const targetError = validateBranchGateTargets(branch.steps, index, fanoutDisplayStep, branch.id)
                if (targetError !== null) return targetError
                const gotoError = validateBranchGateGotos(branch.steps, index, fanoutDisplayStep, branch.id)
                if (gotoError !== null) return gotoError
                break
            }
            default:
                assertNever(step.kind)
        }
    }

    return null
}

function validateBranchGateTargets(
    steps: readonly WorkflowToolStep[],
    gateIndex: number,
    fanoutDisplayStep: number,
    branchId: string,
): string | null {
    const gate = steps[gateIndex]
    if (gate?.kind !== "gate") return null
    const location = `fanout step ${fanoutDisplayStep} branch "${branchId}" step ${gateIndex + 1} (gate)`
    if (gate.target_step !== undefined && gate.targets !== undefined) {
        return `Error: ${location} must not set both target_step and targets`
    }
    if (gate.targets !== undefined) {
        for (let index = 0; index < gate.targets.length; index += 1) {
            const targetRef = gate.targets[index]
            if (targetRef === undefined || resolvePublicTaskRef(steps, gateIndex, targetRef) < 0) {
                return `Error: ${location} targets[${index}] "${String(targetRef)}" must reference a previous task step in the same branch`
            }
        }
        return null
    }
    const targetIndex = resolvePublicGateTargetIndex(steps, gateIndex)
    if (targetIndex >= 0) return null
    const targetRef = gate.target_step
    if (targetRef === undefined) {
        return `Error: ${location} has no preceding task step to verify in the same branch`
    }
    return `Error: ${location} target_step "${String(targetRef)}" must reference a previous task step in the same branch`
}

function validateBranchGateGotos(
    steps: readonly WorkflowToolStep[],
    gateIndex: number,
    fanoutDisplayStep: number,
    branchId: string,
): string | null {
    const gate = steps[gateIndex]
    if (gate?.kind !== "gate") return null
    for (const [field, ref] of [
        ["on_pass_goto", gate.on_pass_goto],
        ["on_fail_goto", gate.on_fail_goto],
        ["on_invalid_goto", gate.on_invalid_goto],
    ] as const) {
        if (ref === undefined) continue
        if (resolvePublicGotoRef(steps, gateIndex, ref) < 0) {
            return `Error: fanout step ${fanoutDisplayStep} branch "${branchId}" step ${gateIndex + 1} (gate) ${field} "${String(ref)}" must not cross fanout boundaries`
        }
    }
    return null
}

function stepLocation(step: LoweredWorkflowStep, displayStep: number, includeKind: boolean): string {
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

function targetStepErrorLabel(step: LoweredWorkflowStep, targetIndex: number): string {
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

function resolveAndValidateGateTargets(
    steps: readonly LoweredWorkflowStep[],
    gate: LoweredWorkflowLinearStep,
    gateIndex: number,
    displayStep: number,
): { readonly indices: readonly number[] } | { readonly error: string } {
    const location = stepLocation(gate, displayStep, true)
    const targetIndices: number[] = []
    if (gate.targets !== undefined) {
        for (let index = 0; index < gate.targets.length; index += 1) {
            const targetRef = gate.targets[index]
            if (targetRef === undefined) {
                return { error: `Error: ${location} targets[${index}] "undefined" must reference a previous task step` }
            }
            if (resolvesToMarkerStep(steps, gateIndex, targetRef)) {
                return { error: `Error: ${location} targets[${index}] "${String(targetRef)}" must not reference a fanout/join marker step` }
            }
            const targetIndex = resolveGateTargetRef(steps, gateIndex, targetRef)
            if (targetIndex < 0) {
                return { error: `Error: ${location} targets[${index}] "${String(targetRef)}" must reference a previous task step${typeof targetRef === "string" ? " by id" : ""}` }
            }
            if (!targetIndices.includes(targetIndex)) targetIndices.push(targetIndex)
        }
        targetIndices.sort((a, b) => a - b)
        return { indices: targetIndices }
    }

    const targetRef = gate.target_step
    if (targetRef !== undefined && resolvesToMarkerStep(steps, gateIndex, targetRef)) {
        return { error: `Error: ${location} target_step "${String(targetRef)}" must not reference a fanout/join marker step` }
    }
    const targetIndex = resolveGateTargetIndex(steps, gateIndex)
    if (targetIndex < 0) {
        if (targetRef === undefined) {
            return { error: `Error: ${location} has no preceding task step to verify` }
        }
        return { error: `Error: ${location} target_step "${String(targetRef)}" must reference a previous task step${typeof targetRef === "string" ? " by id" : ""}` }
    }
    targetIndices.push(targetIndex)
    return { indices: targetIndices }
}

function validateTaskInputs(steps: readonly LoweredWorkflowStep[], task: LoweredWorkflowLinearStep, index: number, displayStep: number): string | null {
    if (task.kind !== "task" || task.inputs === undefined) return null
    const location = stepLocation(task, displayStep, true)
    const inputIndices = resolveWorkflowInputIndices(steps, index) ?? []
    for (let inputPosition = 0; inputPosition < task.inputs.length; inputPosition += 1) {
        const inputIndex = inputIndices[inputPosition]
        if (inputIndex === undefined || inputIndex < 0 || !canConsumeWorkflowInput(steps, index, inputIndex)) {
            return `Error: ${location} inputs[${inputPosition}] must reference a previous task or join step in the same workflow scope`
        }
    }
    return null
}

/**
 * Graph validator: structural + semantic checks over the declared step list.
 * Centralizes the linear-engine invariants (unique ids, target resolution,
 * no self-verification, cross-kind field separation, retry caps required).
 * Returns a user-facing `Error: ...` string or null when the graph is valid.
 */
function validateWorkflowGraph(args: ResolvedWorkflowToolArgs, team: Team): string | null {
    if (args.steps.length === 0) {
        return "Error: steps must contain at least one step"
    }
    if (args.steps[0]?.kind !== "task") {
        return "Error: step 1 must be a task; a gate has no preceding task step to verify"
    }
    const publicShapeError = validatePublicWorkflowShape(args.steps)
    if (publicShapeError !== null) return publicShapeError
    const loweredSteps = lowerWorkflowSteps(args.steps)
    for (let i = 0; i < loweredSteps.length; i++) {
        const s = loweredSteps[i]
        if (s === undefined) continue
        const displayStep = i + 1
        switch (s.kind) {
            case "task": {
                const location = stepLocation(s, displayStep, true)
                if (s.verifier !== undefined || s.criteria !== undefined || s.target_step !== undefined || s.targets !== undefined || s.on_fail !== undefined || s.max_retries !== undefined || s.on_invalid !== undefined || s.max_invalid_retries !== undefined || s.where !== undefined) {
                    return `Error: ${location} must not set gate fields`
                }
                if (!s.member) return `Error: ${location} requires \`member\``
                if (!s.task) return `Error: ${location} requires \`task\``
                const inputsError = validateTaskInputs(loweredSteps, s, i, displayStep)
                if (inputsError !== null) return inputsError
                if (s.max_output_bytes !== undefined && (!Number.isInteger(s.max_output_bytes) || s.max_output_bytes <= 0)) {
                    return `Error: ${location} max_output_bytes must be a positive integer`
                }
                if (s.timeout_ms !== undefined && (!Number.isInteger(s.timeout_ms) || s.timeout_ms < 1000)) {
                    return `Error: ${location} timeout_ms must be an integer >= 1000`
                }
                if (s.on_timeout === "retry" && s.max_timeout_retries === undefined) {
                    return `Error: ${location} with on_timeout='retry' requires \`max_timeout_retries\``
                }
                if (!isTeamMember(team, s.member)) {
                    return `Error: unknown member "${s.member}" in ${stepLocation(s, displayStep, false)}`
                }
                break
            }
            case "gate": {
                const location = stepLocation(s, displayStep, true)
                if (s.member !== undefined || s.task !== undefined) {
                    return `Error: ${location} must not set task fields`
                }
                if (s.inputs !== undefined || s.expose_output !== undefined) {
                    return `Error: ${location} must not set task data-flow fields`
                }
                if (s.max_output_bytes !== undefined) {
                    return `Error: ${location} must not set max_output_bytes (task steps only)`
                }
                if (s.timeout_ms !== undefined && (!Number.isInteger(s.timeout_ms) || s.timeout_ms < 1000)) {
                    return `Error: ${location} timeout_ms must be an integer >= 1000`
                }
                if (s.on_timeout === "retry" && s.max_timeout_retries === undefined) {
                    return `Error: ${location} with on_timeout='retry' requires \`max_timeout_retries\``
                }
                if (!s.verifier) return `Error: ${location} requires \`verifier\``
                if (!s.criteria) return `Error: ${location} requires \`criteria\``
                if (s.target_step !== undefined && s.targets !== undefined) {
                    return `Error: ${location} must not set both target_step and targets`
                }
                if (s.on_fail === "retry" && s.max_retries === undefined) {
                    return `Error: ${location} with on_fail='retry' requires \`max_retries\``
                }
                if (s.on_invalid === "retry_verifier" && s.max_invalid_retries === undefined) {
                    return `Error: ${location} with on_invalid='retry_verifier' requires \`max_invalid_retries\``
                }
                if (s.max_jumps !== undefined && (s.max_jumps < 0 || s.max_jumps > 10)) {
                    return `Error: ${location} max_jumps must be between 0 and 10`
                }
                if (s.max_jumps !== undefined && s.on_pass_goto === undefined && s.on_fail_goto === undefined && s.on_invalid_goto === undefined) {
                    return `Error: ${location} max_jumps requires on_pass_goto/on_fail_goto/on_invalid_goto (no goto to bound)`
                }
                if (s.where !== undefined) {
                    if (s.on_pass_goto === undefined && s.on_fail_goto === undefined) {
                        return `Error: ${location} where requires on_pass_goto or on_fail_goto`
                    }
                    const parsed = parseWorkflowCondition(s.where)
                    if ("error" in parsed) return `Error: ${location} ${parsed.error}`
                }
                for (const [field, ref] of [
                    ["on_pass_goto", s.on_pass_goto],
                    ["on_fail_goto", s.on_fail_goto],
                    ["on_invalid_goto", s.on_invalid_goto],
                ] as const) {
                    if (ref === undefined) continue
                    const gotoIdx = resolveGotoIndex(loweredSteps, i, ref)
                    if (gotoIdx < 0) {
                        return `Error: ${location} ${field} "${String(ref)}" must reference an existing step${typeof ref === "string" ? " by id" : ""} and must not self-jump`
                    }
                    if (s.on_invalid === "escalate" && field === "on_invalid_goto") {
                        return `Error: ${location} on_invalid_goto is incompatible with on_invalid='escalate' (escalate uses approve/reject)`
                    }
                }
                if (s.approval_after === true && (s.on_pass_goto !== undefined || s.on_fail_goto !== undefined || s.on_invalid_goto !== undefined)) {
                    return `Error: ${location} approval_after is incompatible with on_pass_goto/on_fail_goto/on_invalid_goto (team_approve calls advance, which cannot honor a goto jump)`
                }
                const targetIndices = resolveAndValidateGateTargets(loweredSteps, s, i, displayStep)
                if ("error" in targetIndices) return targetIndices.error
                for (const targetIndex of targetIndices.indices) {
                    const target = loweredSteps[targetIndex]
                    if (target?.kind !== "task" || !target.member) return `Error: step ${targetIndex + 1} (task) requires \`member\``
                    if (s.verifier === target.member) {
                        return `Error: ${location} verifier "${s.verifier}" must differ from ${targetStepErrorLabel(target, targetIndex)} member (no self-verification)`
                    }
                }
                if (targetIndices.indices.length === 0) {
                    if (s.targets === undefined) {
                        return `Error: ${location} has no preceding task step to verify`
                    }
                    return `Error: ${location} targets must reference at least one previous task step`
                }
                if (!isTeamMember(team, s.verifier)) {
                    return `Error: unknown member "${s.verifier}" in ${location} verifier`
                }
                break
            }
            case "fanout": {
                if (s.fanout.joinPolicy === "reduce" && s.fanout.reducerMember !== undefined && !isTeamMember(team, s.fanout.reducerMember)) {
                    return `Error: fanout step ${displayStep} reducer_member "${s.fanout.reducerMember}" is not a team member`
                }
                break
            }
            case "join":
                break
            default:
                assertNever(s)
        }
    }
    const signoffErr = validateSignoff(args, team)
    if (signoffErr) return signoffErr
    return null
}

function validateWorkflowArgs(args: ResolvedWorkflowToolArgs, team: Team): string | null {
    return validateWorkflowGraph(args, team)
}

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

function whereLabel(where: WorkflowWhere | undefined): string {
    if (where === undefined) return ""
    const parsed = parseWorkflowCondition(where)
    return "condition" in parsed ? ` when ${formatWorkflowCondition(parsed.condition)}` : ""
}

function formatWorkflowDryRun(args: ResolvedWorkflowToolArgs): string {
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
                const ctrlTag = controls.length > 0 ? `  [${controls.join(", ")}]` : ""
                const target = stepTargetLabel(loweredSteps, i)
                const retry = step.on_fail === "retry" ? `; on_fail=retry max_retries=${step.max_retries}` : ""
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
                lines.push(`${i + 1}. [join]${idTag} waits for branches: ${branchIds.join(", ")}; ${controls.join("; ")}`)
                break
            }
            default:
                assertNever(step)
        }
    }
    return lines.join("\n")
}

function branchDryRunPrefix(step: LoweredWorkflowLinearStep, activeBranchId: string | undefined): { readonly lines: readonly string[]; readonly activeBranchId: string | undefined } {
    const branchId = step.branchContext?.branchId
    if (branchId === undefined) return { lines: [], activeBranchId: undefined }
    if (branchId === activeBranchId) return { lines: [], activeBranchId }
    return { lines: [`  branch ${branchId}:`], activeBranchId: branchId }
}

function hasInlineSteps(args: WorkflowToolArgs): boolean {
    return args.steps !== undefined
}

function validateWorkflowSource(args: WorkflowToolArgs): string | null {
    if (hasInlineSteps(args) === (args.workflow_file !== undefined)) {
        return "Error: team_workflow must set exactly one of steps or workflow_file"
    }
    if (args.steps !== undefined && args.steps.length === 0) return "Error: steps must contain at least one step"
    return null
}

async function resolveWorkflowArgs(ctx: PluginContext, args: WorkflowToolArgs): Promise<ResolvedWorkflowToolArgs | string> {
    const sourceError = validateWorkflowSource(args)
    if (sourceError) return sourceError
    if (args.steps !== undefined) {
        const shapeError = validateMatrixForeachShapeInSteps(args.steps)
        if (shapeError !== null) return shapeError
        return { ...args, steps: expandMatrixForeachFanout(args.steps) }
    }
    if (args.workflow_file === undefined) return "Error: team_workflow must set exactly one of steps or workflow_file"
    const loaded = await loadWorkflowFile(ctx.directory, args.workflow_file, args.vars ?? {})
    if ("error" in loaded) return loaded.error
    const shapeError = validateMatrixForeachShapeInSteps(loaded.steps)
    if (shapeError !== null) return shapeError
    return { ...args, steps: expandMatrixForeachFanout(loaded.steps) }
}

/**
 * Expand matrix/foreach fanout syntax sugar into concrete branches before
 * validation and lowering. matrix produces the cartesian product of its value
 * arrays; foreach is single-dimension. Both substitute ${var} in every string
 * field of the branch's steps. A fanout that already has `branches` must not
 * set matrix/foreach. Expansion preserves step order and is idempotent.
 */
export function expandMatrixForeachFanout(steps: readonly WorkflowToolStep[]): WorkflowToolStep[] {
    return steps.map(step => {
        if (step.kind !== "fanout") return step
        const matrix = step.matrix
        const foreach = step.foreach
        if (matrix === undefined && foreach === undefined) return step
        if (step.branches !== undefined) return step // explicit branches wins; validator rejects the combo
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
        ...(typeof step.verifier === "string" ? { verifier: substituteVars(step.verifier, vars) } : {}),
    }
}

function substituteVars(text: string, vars: Record<string, string>): string {
    return text.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name: string) => vars[name] ?? match)
}

function sanitizeBranchId(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 64) || "branch"
}

function gotoRefLabel(steps: readonly LoweredWorkflowStep[], gateIndex: number, ref: WorkflowStepRef): string {
    const idx = resolveGotoIndex(steps, gateIndex, ref)
    const id = idx >= 0 ? steps[idx]?.id : undefined
    return id ? `step ${idx + 1} (${id})` : idx >= 0 ? `step ${idx + 1}` : "?"
}

function toWorkflowStep(step: LoweredWorkflowStep, steps: readonly LoweredWorkflowStep[], index: number): WorkflowStep {
    switch (step.kind) {
        case "task":
            return {
                kind: "task",
                id: step.id,
                member: step.member,
                task: step.task,
                inputs: resolveWorkflowInputIndices(steps, index),
                exposeOutput: step.expose_output,
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
                criteria: step.criteria,
                targetStepIndex: primaryTargetIndex(targetIndices),
                targetStepIndices: step.targets !== undefined ? targetIndices : undefined,
                onFail: step.on_fail ?? "fail",
                maxRetries: step.max_retries,
                attempts: 0,
                onInvalid: step.on_invalid ?? "fail",
                maxInvalidRetries: step.max_invalid_retries,
                invalidAttempts: 0,
                onPassGoto: resolveGotoIndex(steps, index, step.on_pass_goto),
                onFailGoto: resolveGotoIndex(steps, index, step.on_fail_goto),
                onInvalidGoto: resolveGotoIndex(steps, index, step.on_invalid_goto),
                where: where !== undefined && "condition" in where ? where.condition : undefined,
                approvalBefore: step.approval_before,
                approvalAfter: step.approval_after,
                maxJumps: step.max_jumps,
                jumpCount: 0,
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

export function teamWorkflowTool(ctx: PluginContext): ToolDefinition {
    const workflowStepRefSchema = tool.schema.union([tool.schema.number().int().min(1), tool.schema.string().min(1)])
    const workflowStepSchemaFields = {
        id: tool.schema.string().min(1).max(64).optional().describe("optional stable step identifier; gates may reference a task step by this id via target_step or targets"),
        member: tool.schema.string().min(1).optional().describe("task steps: the actor member name"),
        task: tool.schema.string().min(1).max(8192).optional().describe("task steps: the task text"),
        verifier: tool.schema.string().min(1).optional().describe("gate steps: the verifier member name (must differ from the target task member)"),
        criteria: tool.schema.string().min(1).max(8192).optional().describe("gate steps: verification criteria"),
        target_step: workflowStepRefSchema.optional().describe("gate steps: one target task step to verify, using a 1-based number or step id; branch gate references are branch-local. Mutually exclusive with targets."),
        targets: tool.schema.array(workflowStepRefSchema).min(1).optional().describe("gate steps: multiple prior task steps to verify together. Mutually exclusive with target_step."),
        inputs: tool.schema.array(workflowStepRefSchema).min(1).optional().describe("task steps: explicit upstream task/join steps to include, using 1-based numbers or step ids. Overrides implicit upstream selection."),
        expose_output: tool.schema.boolean().optional().describe("task steps: when false, suppress this task output from implicit downstream upstream context. Explicit inputs may still reference it."),
        on_fail: tool.schema.enum(["retry", "fail"]).optional().describe("gate steps: FAIL control. 'fail' (default) fails the run; 'retry' re-dispatches the target task up to max_retries."),
        max_retries: tool.schema.number().int().min(0).max(5).optional().describe("gate steps: FAIL retry cap when on_fail='retry'. Default 0."),
        on_invalid: tool.schema.enum(["fail", "retry_verifier", "escalate"]).optional().describe("gate steps: INVALID control. 'fail' (default) terminates producer-neutral as workflow_invalid; 'retry_verifier' re-dispatches this gate's verifier up to max_invalid_retries; 'escalate' pauses for human approval (approve=advance, reject=workflow_invalid)."),
        max_invalid_retries: tool.schema.number().int().min(0).max(5).optional().describe("gate steps: retry_verifier cap when on_invalid='retry_verifier'. Default 0. Required when on_invalid='retry_verifier'."),
        on_pass_goto: workflowStepRefSchema.optional().describe("gate steps: step to jump to after PASS (1-based number or step id) instead of advancing linearly. Branch gotos are branch-local."),
        on_fail_goto: workflowStepRefSchema.optional().describe("gate steps: step to jump to at a FAIL terminal point (on_fail=fail, or retry exhausted) instead of failing the run."),
        on_invalid_goto: workflowStepRefSchema.optional().describe("gate steps: step to jump to at an INVALID terminal point (on_invalid=fail, or retry_verifier exhausted). Incompatible with on_invalid='escalate'."),
        where: tool.schema.object({
            score_gte: tool.schema.number().optional(),
            score_lt: tool.schema.number().optional(),
            confidence_gte: tool.schema.number().optional(),
            has_issue_severity: tool.schema.enum(["low", "medium", "high", "critical"]).optional(),
        }).optional().describe("gate steps: optional threshold condition gating on_pass_goto/on_fail_goto. Exactly one condition key is allowed."),
        approval_before: tool.schema.boolean().optional().describe("task/gate steps: pause for team_approve before dispatching this step. Disallowed inside fanout branches."),
        approval_after: tool.schema.boolean().optional().describe("task/gate steps: pause for team_approve after this step completes, before advancing. Disallowed inside fanout branches."),
        max_output_bytes: tool.schema.number().int().min(1).optional().describe("task steps: cap the captured output snapshot to N UTF-8 bytes (head+tail preserved). Gate steps may not set this."),
        timeout_ms: tool.schema.number().int().min(1000).optional().describe("task/gate steps: wall-clock deadline in milliseconds from dispatch time."),
        on_timeout: tool.schema.enum(["fail", "retry", "skip"]).optional().describe("task/gate steps: timeout control. 'fail' (default) fails the workflow; 'retry' re-dispatches up to max_timeout_retries; 'skip' marks the step skipped and advances."),
        max_timeout_retries: tool.schema.number().int().min(0).max(5).optional().describe("task/gate steps: timeout retry cap when on_timeout='retry'. Required when on_timeout='retry'."),
        max_jumps: tool.schema.number().int().min(0).max(10).optional().describe("gate steps: per-gate cap on verdict-driven jumps. Default 3. Terminates as workflow_failed:jump_limit when exceeded."),
        join_policy: tool.schema.enum(["all", "quorum", "any_success", "required_branches", "reduce"]).optional().describe("fanout steps: join semantics. Default (unset) uses max_errored tolerance. 'all' requires every branch to succeed; 'quorum' requires quorum fraction of survivors; 'any_success' joins once any branch succeeds; 'required_branches' requires the listed branches to succeed; 'reduce' requires all then dispatches reducer_member to aggregate."),
        quorum: tool.schema.number().min(0).max(1).optional().describe("fanout steps: survivor fraction required by join_policy='quorum' (0 < quorum <= 1)."),
        required_branches: tool.schema.array(tool.schema.string().min(1)).min(1).optional().describe("fanout steps: branch ids that must succeed under join_policy='required_branches'."),
        reducer_member: tool.schema.string().min(1).optional().describe("fanout steps: member who aggregates branch outputs at join under join_policy='reduce'."),
        matrix: tool.schema.record(tool.schema.string(), tool.schema.array(tool.schema.string().min(1))).optional().describe("fanout steps: expand into the cartesian product of named value arrays, substituting ${name} in each branch step's text fields. Mutually exclusive with branches/foreach."),
        foreach: tool.schema.array(tool.schema.string().min(1)).optional().describe("fanout steps: single-dimension value list; one branch per value, substituting ${as} in each branch step. Mutually exclusive with branches/matrix."),
        as: tool.schema.string().min(1).optional().describe("fanout steps: variable name bound to the current foreach value (default 'item')."),
    }
    const workflowBranchStepSchema = tool.schema.object({
        kind: tool.schema.enum(["task", "gate", "fanout", "join"]),
        ...workflowStepSchemaFields,
        branches: tool.schema.array(tool.schema.object({
            id: tool.schema.string().min(1).max(64),
            steps: tool.schema.array(tool.schema.object({
                kind: tool.schema.enum(["task", "gate", "fanout", "join"]),
                ...workflowStepSchemaFields,
            })).min(1),
        })).optional(),
        max_errored: tool.schema.number().int().min(0).optional(),
    })
    const workflowStepSchema = tool.schema.object({
        kind: tool.schema.enum(["task", "gate", "fanout", "join"]),
        ...workflowStepSchemaFields,
        branches: tool.schema.array(tool.schema.object({
            id: tool.schema.string().min(1).max(64),
            steps: tool.schema.array(workflowBranchStepSchema).min(1),
        })).optional().describe("fanout steps: branch objects with stable ids and branch-local task/gate steps"),
        max_errored: tool.schema.number().int().min(0).optional().describe("fanout steps: maximum errored branches tolerated; must leave at least one surviving branch"),
    })
    return tool({
        description:
            "Run a deterministic, declaratively-composed workflow. Each step is either a `task` (one member produces output) or a `gate` (a verifier renders a PASS/FAIL/INVALID verdict over one or more prior task outputs). The engine drives transitions, retry, INVALID handling, and verdict-gated jumps while keeping intermediate results out of the leader's context.",
        args: {
            team_id: tool.schema.string().min(1),
            steps: tool.schema
                .array(workflowStepSchema)
                .min(1)
                .optional()
                .describe("ordered workflow steps; fanout must be immediately followed by a join marker"),
            workflow_file: tool.schema.string().min(1).optional().describe("relative path to a JSON workflow file under the workspace; mutually exclusive with steps"),
            vars: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe("template variables for workflow_file string values, referenced as ${name}"),
            dry_run: tool.schema.boolean().optional().describe("Validate and render the 1-based workflow step ledger without starting orchestration"),
            ...signoffSchemaFields,
            ...humanApprovalSchemaFields,
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller?.isMaster) return "Error: team_workflow is master-only"
            const resolvedArgs = await resolveWorkflowArgs(ctx, args)
            if (typeof resolvedArgs === "string") return resolvedArgs
            if (args.dry_run) {
                const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)
                const gate = activationError(team.teamName, team.activatedAt)
                if (gate) return gate
                const validationError = validateWorkflowArgs(resolvedArgs, team)
                if (validationError) return validationError
                return formatWorkflowDryRun(resolvedArgs)
            }
            return startOrchestration(
                args.team_id, context, ctx, "team_workflow",
                // validate
                (team) => {
                    return validateWorkflowArgs(resolvedArgs, team)
                },
                // buildTask
                async (team) => {
                    const loweredSteps = lowerWorkflowSteps(resolvedArgs.steps)
                    const steps: WorkflowStep[] = loweredSteps.map((s, index) => toWorkflowStep(s, loweredSteps, index))
                    const wfTask: WorkflowTask = {
                        type: "workflow",
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        stages: [],
                        steps,
                        ...(steps.some(step => step.kind === "fanout") ? { activeStepIndices: [0] } : {}),
                        ...humanApprovalTaskFields(args),
                        ...signoffTaskFields(args),
                    }
                    return wfTask
                },
                // dispatch: step 0 (validation guarantees it is a task).
                async (team, task) => {
                    if (task.type !== "workflow") return
                    const step = task.steps?.[0]
                    if (!step || step.kind !== "task" || !step.member || !step.task) throw new Error("workflow initial step is invalid")
                    // Per-step approval_before on the very first step: pause
                    // before the initial dispatch (advanceWorkflowStep cannot
                    // run here because activeTask was just committed; the pause
                    // resume path goes through team_approve -> advanceWorkflowStep
                    // which finds step 0 still incomplete and dispatches it).
                    if (await maybePauseBeforeWorkflowStep(ctx, team, 0)) return
                    const first = team.members.find(m => m.name === step.member && !m.isMaster)
                    if (!first?.sessionId || first.status === "errored") throw new Error(`workflow initial member "${step.member}" has no live session`)
                    await dispatchToMember(ctx, first, step.task, first.worktreePath ?? ctx.directory, team)
                    const now = Date.now()
                    step.startedAt ??= now
                    step.dispatchedAt = now
                },
                // successMessage
                () => `team_workflow started on "${args.team_id}" with ${lowerWorkflowSteps(resolvedArgs.steps).length} step(s).`,
            )
        },
    })
}

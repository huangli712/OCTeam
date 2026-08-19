/**
 * Workflow graph validation: structural + semantic checks over the declared
 * step list. Centralizes linear-engine invariants (unique ids, target resolution,
 * no self-verification, cross-kind field separation, retry caps required).
 *
 * Imports lowering and reference resolution from lower.ts.
 */

import type { MemberState } from "../../core/types.js"
import { parseWorkflowCondition } from "../../orchestration/workflow/gate.js"
import { loadWorkflowFile, validateWorkflowSteps, WORKFLOW_MAX_TOTAL_STEPS } from "../../orchestration/workflow/loader.js"
import { defaultBounds, validateSignoff } from "../support.js"
import { AsyncMutex } from "../../state/locks.js"
import type { Team } from "../../state/store.js"
import type { PluginContext } from "../../core/context.js"
import type {
    WorkflowFanoutBranch,
    WorkflowFanoutToolStep,
    WorkflowToolStep,
    WorkflowToolArgs,
    ResolvedWorkflowToolArgs,
} from "../../core/types/workflow.js"
import {
    assertNever,
    canConsumeWorkflowInput,
    lowerWorkflowSteps,
    resolvesToMarkerStep,
    resolveGateTargetIndex,
    resolveGateTargetRef,
    resolveGotoIndex,
    resolvePublicGateTargetIndex,
    resolvePublicGotoRef,
    resolvePublicTaskRef,
    resolveWorkflowInputIndices,
    stepLocation,
    targetStepErrorLabel,
    type LoweredWorkflowFanoutStep,
    type LoweredWorkflowLinearStep,
    type LoweredWorkflowStep,
} from "./lower.js"
import { expandMatrixForeachFanout } from "./lower.js"

/** Check whether \`name\` is a member of the given team. */
function isTeamMember(team: Team, name: string): boolean {
    return team.members.some(member => member.name === name && !member.isMaster)
}

/** Narrow a \`WorkflowToolStep\` to \`WorkflowFanoutToolStep\` when its kind is \`"fanout"\`. */
function isFanoutToolStep(step: WorkflowToolStep): step is WorkflowFanoutToolStep {
    return step.kind === "fanout"
}

// --- duplicate id validation ---

/** Check for duplicate step ids across public steps and fanout branches. */
export function validateDuplicateStepIds(steps: readonly WorkflowToolStep[]): string | null {
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

/** Check whether \`id\` is already in \`ids\`; return a duplicate error message or null. */
function validateStepId(ids: Map<string, number>, id: string | undefined, displayStep: number): string | null {
    if (id === undefined) return null
    const previous = ids.get(id)
    if (previous !== undefined) return `Error: duplicate step id "${id}" at steps ${previous} and ${displayStep}`
    ids.set(id, displayStep)
    return null
}

/** Field names allowed on EVERY workflow step kind regardless of its `kind`. */
const COMMON_STEP_FIELDS = [
    "kind", "id", "inputs", "expose_output", "approval_before", "approval_after",
    "max_output_bytes", "timeout_ms", "on_timeout", "max_timeout_retries",
] as const

/** Field names allowed only on a specific step kind (its exclusive fields). */
const STEP_KIND_FIELDS: Record<WorkflowToolStep["kind"], readonly string[]> = {
    task: ["member", "fallback_member", "task", "retry_on", "max_task_retries"],
    gate: [
        "verifier", "fallback_verifier", "verifiers", "ensemble_policy", "ensemble_quorum",
        "criteria", "target_step", "targets", "on_fail", "max_retries", "on_invalid",
        "on_malformed", "max_malformed_retries", "max_invalid_retries", "on_pass_goto",
        "on_fail_goto", "on_invalid_goto", "where", "max_jumps", "loop",
    ],
    fanout: [
        "branches", "max_errored", "join_policy", "quorum", "required_branches",
        "reducer_member", "use_survivors", "matrix", "foreach", "as", "steps",
    ],
    join: ["join_policy", "quorum", "required_branches", "reducer_member", "use_survivors"],
}

/** Reject a field that belongs to another step kind; the error names the
 * owning kind when the field is known, else flags it as unknown for this kind. */
function validateStepKindFields(step: WorkflowToolStep, location: string): string | null {
    const allowed = new Set<string>([...COMMON_STEP_FIELDS, ...STEP_KIND_FIELDS[step.kind]])
    const unexpected = Object.keys(step).find(field => !allowed.has(field))
    if (unexpected === undefined) return null
    const owner = Object.entries(STEP_KIND_FIELDS).find(
        ([kind, fields]) => kind !== step.kind && fields.includes(unexpected),
    )?.[0]
    return owner === undefined
        ? `Error: ${location} kind "${step.kind}" must not set field "${unexpected}"`
        : `Error: ${location} kind "${step.kind}" must not set ${owner} fields (found "${unexpected}")`
}

// --- public shape validation ---

/** Validate the structural shape of public workflow steps (fanout/join pairing, branch rules). */
export function validatePublicWorkflowShape(steps: readonly WorkflowToolStep[]): string | null {
    const duplicateStepId = validateDuplicateStepIds(steps)
    if (duplicateStepId !== null) return duplicateStepId
    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]
        if (step === undefined) continue
        const fieldError = validateStepKindFields(step, `step ${index + 1}`)
        if (fieldError !== null) return fieldError
        switch (step.kind) {
            case "task":
            case "gate":
                break
            case "join":
                if (steps[index - 1]?.kind !== "fanout") {
                    return `Error: join step ${index + 1} has no matching fanout step`
                }
                // Join-policy fields belong on the companion fanout and are
                // rejected on join markers.
                if ("join_policy" in step || "quorum" in step || "required_branches" in step
                    || "reducer_member" in step || "use_survivors" in step) {
                    return `Error: join step ${index + 1} has join-policy fields. These belong on the companion fanout step.`
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
                assertNever(step)
        }
    }
    return null
}

// --- matrix/foreach shape ---

/** Validate matrix/foreach constraints on fanout steps in the public step array. */
export function validateMatrixForeachShapeInSteps(steps: readonly WorkflowToolStep[]): string | null {
    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]
        if (step === undefined || step.kind !== "fanout") continue
        const err = validateMatrixForeachShape(step, index + 1)
        if (err !== null) return err
    }
    return null
}

/** Validate that a single fanout step does not combine matrix, foreach, and branches. */
function validateMatrixForeachShape(step: WorkflowFanoutToolStep, displayStep: number): string | null {
    const runtimeStep = step as unknown as Record<string, unknown>
    if (runtimeStep.matrix !== undefined) {
        if (typeof runtimeStep.matrix !== "object" || runtimeStep.matrix === null || Array.isArray(runtimeStep.matrix)) {
            return `Error: fanout step ${displayStep} matrix must be an object of string arrays`
        }
        for (const [key, value] of Object.entries(runtimeStep.matrix)) {
            if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
                return `Error: fanout step ${displayStep} matrix.${key} must be a string array`
            }
        }
    }
    if (runtimeStep.foreach !== undefined
        && (!Array.isArray(runtimeStep.foreach) || !runtimeStep.foreach.every(item => typeof item === "string"))) {
        return `Error: fanout step ${displayStep} foreach must be a string array`
    }
    if (runtimeStep.as !== undefined && typeof runtimeStep.as !== "string") {
        return `Error: fanout step ${displayStep} as must be a string`
    }
    const hasMatrix = step.matrix !== undefined
    const hasForeach = step.foreach !== undefined
    const hasBranches = (step.branches ?? []).length > 0
    if (hasMatrix && hasForeach) {
        return `Error: fanout step ${displayStep} must not set both matrix and foreach`
    }
    if ((hasMatrix || hasForeach) && hasBranches) {
        return `Error: fanout step ${displayStep} must not set both matrix/foreach and branches`
    }
    if (hasMatrix || hasForeach) {
        if ((step.steps ?? []).length === 0) {
            return `Error: fanout step ${displayStep} with matrix/foreach requires template \`steps\``
        }
        // Validate post-expansion step count to bound fanout. The total is the
        // matrix product or foreach length multiplied by steps per branch.
        const templateSteps = step.steps?.length ?? 0
        const matrixValues = step.matrix ? Object.values(step.matrix) : []
        const foreachValues = step.foreach ?? []
        const expansionCount = hasMatrix
            ? matrixValues.reduce((acc, vals) => acc * vals.length, 1)
            : foreachValues.length
        const totalSteps = expansionCount * templateSteps
        const MAX_EXPANDED_STEPS = 256
        if (totalSteps > MAX_EXPANDED_STEPS) {
            return `Error: fanout step ${displayStep} expands to ${totalSteps} steps (${expansionCount} branches × ${templateSteps} per branch), exceeding the ${MAX_EXPANDED_STEPS} limit`
        }
    }
    return null
}

// --- fanout validation ---

/** Validate join_policy on a fanout step: known policy, quorum/required_branches/reducer_member consistency. */
function validateFanoutJoinPolicy(step: WorkflowFanoutToolStep, displayStep: number): string | null {
    const policy = step.join_policy
    if (policy === undefined) {
        // Policy-specific fields require an explicit join_policy because they
        // have no effect under the default tolerance policy.
        if (step.required_branches !== undefined || step.quorum !== undefined || step.reducer_member !== undefined) {
            return `Error: fanout step ${displayStep} has join_policy-specific fields (required_branches/quorum/reducer_member) but no join_policy is set. Set join_policy explicitly.`
        }
        return null
    }
    const branchIds = (step.branches ?? []).map(branch => branch.id)
    switch (policy) {
        case "all":
        case "any_success":
        case "reduce":
        case "select":
            break
        case "quorum": {
            if (step.quorum === undefined) {
                return `Error: fanout step ${displayStep} join_policy='quorum' requires \`quorum\``
            }
            if (typeof step.quorum !== "number" || !Number.isFinite(step.quorum)
                || !(step.quorum > 0 && step.quorum <= 1)) {
                return `Error: fanout step ${displayStep} quorum must be a number > 0 and <= 1`
            }
            break
        }
        case "required_branches": {
            // Guard required_branches before reading its length because workflow
            // files may contain malformed values.
            if (!Array.isArray(step.required_branches) || step.required_branches.length === 0) {
                return `Error: fanout step ${displayStep}`
                    + ` join_policy='required_branches' requires an array \`required_branches\``
            }
            for (const requiredId of step.required_branches) {
                if (!branchIds.includes(requiredId)) {
                    return (`Error: fanout step ${displayStep} required_branches references unknown`
                        + ` branch "${requiredId}"`)
                }
            }
            break
        }
        default:
            return `Error: fanout step ${displayStep} unknown join_policy "${String(policy)}"`
    }
    if ((policy === "reduce" || policy === "select") && step.reducer_member === undefined) {
        return `Error: fanout step ${displayStep} join_policy='${policy}' requires \`reducer_member\``
    }
    // Reject fields irrelevant to the selected policy so a workflow cannot set,
    // e.g., quorum on join_policy='all' where it silently has no effect. quorum
    // is only for 'quorum'; required_branches only for 'required_branches';
    // reducer_member only for 'reduce'/'select'.
    if (policy !== "quorum" && step.quorum !== undefined) {
        return `Error: fanout step ${displayStep} join_policy='${policy}' must not set \`quorum\` (only join_policy='quorum')`
    }
    if (policy !== "required_branches" && step.required_branches !== undefined) {
        return `Error: fanout step ${displayStep} join_policy='${policy}' must not set \`required_branches\` (only join_policy='required_branches')`
    }
    if (policy !== "reduce" && policy !== "select" && step.reducer_member !== undefined) {
        return `Error: fanout step ${displayStep} join_policy='${policy}' must not set \`reducer_member\` (only join_policy='reduce'/'select')`
    }
    return null
}

/** Validate fanout branch list: at least one branch, unique IDs, non-empty steps, no crossing constraints. */
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
        if (branchIds.has(branch.id)) {
            return `Error: duplicate fanout branch id "${branch.id}" at fanout step ${displayStep}`
        }
        branchIds.add(branch.id)
        if (branch.steps.length === 0) {
            return `Error: fanout step ${displayStep} branch "${branch.id}" must contain at least one step`
        }
        const branchError = validateBranchSteps(branch, displayStep, branchByMember)
        if (branchError !== null) return branchError
    }
    return null
}

/** Track which branch a team member has been assigned to; error on concurrent assignment. */
function registerFanoutBranchActor(
    branchByMember: Map<string, string>,
    member: string | undefined,
    fanoutDisplayStep: number,
    branchId: string,
): string | null {
    if (member === undefined) return null
    const existingBranch = branchByMember.get(member)
    if (existingBranch !== undefined && existingBranch !== branchId) {
        return (`Error: fanout step ${fanoutDisplayStep} uses member "${member}"`
            + ` in concurrent branches "${existingBranch}" and "${branchId}"`)
    }
    branchByMember.set(member, branchId)
    return null
}

/** Validate that branch task/gate steps do not set prohibited timeout policies. */
function validateBranchTimeoutPolicy(
    step: WorkflowToolStep,
    fanoutDisplayStep: number,
    branchId: string,
    displayStep: number,
): string | null {
    if (step.on_timeout === "retry" || step.on_timeout === "skip") {
        return (`Error: fanout step ${fanoutDisplayStep} branch "${branchId}" step ${displayStep}`
            + ` must not set on_timeout='retry' or on_timeout='skip'`)
    }
    if (step.max_timeout_retries !== undefined) {
        return (`Error: fanout step ${fanoutDisplayStep} branch "${branchId}"`
            + ` step ${displayStep} must not set max_timeout_retries`)
    }
    return null
}

/** Validate every step inside a fanout branch: no recursive fanout, no join, no approval, valid actors/targets/gotos. */
function validateBranchSteps(
    branch: WorkflowFanoutBranch,
    fanoutDisplayStep: number,
    branchByMember: Map<string, string>,
): string | null {
    for (let index = 0; index < branch.steps.length; index += 1) {
        const step = branch.steps[index]
        if (step === undefined) continue
        const displayStep = index + 1
        const fieldError = validateStepKindFields(
            step,
            `fanout step ${fanoutDisplayStep} branch "${branch.id}" step ${displayStep}`,
        )
        if (fieldError !== null) return fieldError
        switch (step.kind) {
            case "fanout":
                return `Error: fanout step ${fanoutDisplayStep} branch "${branch.id}" must not contain recursive fanout`
            case "join":
                return `Error: fanout step ${fanoutDisplayStep} branch "${branch.id}" must not contain join`
            case "task":
                if (step.approval_before === true || step.approval_after === true) {
                    return (`Error: fanout step ${fanoutDisplayStep} branch "${branch.id}"`
                        + ` step ${displayStep} must not set approval_before/approval_after`)
                }
                {
                    const timeoutError = validateBranchTimeoutPolicy(step, fanoutDisplayStep, branch.id, displayStep)
                    if (timeoutError !== null) return timeoutError
                }
                {
                    const actorError = registerFanoutBranchActor(
                        branchByMember, step.member,
                        fanoutDisplayStep, branch.id,
                    )
                    if (actorError !== null) return actorError
                }
                {
                    const actorError = registerFanoutBranchActor(
                        branchByMember, step.fallback_member,
                        fanoutDisplayStep, branch.id,
                    )
                    if (actorError !== null) return actorError
                }
                break
            case "gate": {
                if (step.approval_before === true || step.approval_after === true) {
                    return (`Error: fanout step ${fanoutDisplayStep} branch "${branch.id}"`
                        + ` step ${displayStep} must not set approval_before/approval_after`)
                }
                const timeoutError = validateBranchTimeoutPolicy(step, fanoutDisplayStep, branch.id, displayStep)
                if (timeoutError !== null) return timeoutError
                const actorError = registerFanoutBranchActor(
                    branchByMember, step.verifier,
                    fanoutDisplayStep, branch.id,
                )
                if (actorError !== null) return actorError
                const fallbackActorError = registerFanoutBranchActor(
                    branchByMember, step.fallback_verifier,
                    fanoutDisplayStep, branch.id,
                )
                if (fallbackActorError !== null) return fallbackActorError
                // Register every ensemble verifier so the branch-concurrency
                // check catches a verifier that also acts in a sibling branch.
                if (step.verifiers !== undefined) {
                    for (const ensVerifier of step.verifiers) {
                        const ensError = registerFanoutBranchActor(
                            branchByMember, ensVerifier,
                            fanoutDisplayStep, branch.id,
                        )
                        if (ensError !== null) return ensError
                    }
                }
                const targetError = validateBranchGateTargets(branch.steps, index, fanoutDisplayStep, branch.id)
                if (targetError !== null) return targetError
                const gotoError = validateBranchGateGotos(branch.steps, index, fanoutDisplayStep, branch.id)
                if (gotoError !== null) return gotoError
                break
            }
            default:
                assertNever(step)
        }
    }
    return null
}

/** Validate gate target_step/targets within a fanout branch: references must stay inside the branch. */
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
                return (`Error: ${location} targets[${index}] "${String(targetRef)}"`
                    + ` must reference a previous task step in the same branch`)
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
    return (`Error: ${location} target_step "${String(targetRef)}"`
        + ` must reference a previous task step in the same branch`)
}

/** Validate gate goto fields within a fanout branch: all goto targets must stay inside the branch. */
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
            return (`Error: fanout step ${fanoutDisplayStep} branch "${branchId}" step ${gateIndex + 1} (gate) ${field}`
                + ` "${String(ref)}" must not cross fanout boundaries`)
        }
    }
    return null
}

// --- gate target resolution+validation (lowered) ---

/** Resolve and validate a gate's targets, returning either resolved indices or an error. */
export function resolveAndValidateGateTargets(
    steps: readonly LoweredWorkflowStep[],
    gate: LoweredWorkflowLinearStep,
    gateIndex: number,
    displayStep: number,
): { readonly indices: readonly number[] } | { readonly error: string } {
    const location = stepLocation(gate, displayStep, true)
    if (gate.kind !== "gate") return { error: `Error: ${location} is not a gate step` }
    const targetIndices: number[] = []
    if (gate.targets !== undefined) {
        for (let index = 0; index < gate.targets.length; index += 1) {
            const targetRef = gate.targets[index]
            if (targetRef === undefined) {
                return { error: `Error: ${location} targets[${index}] "undefined" must reference a previous task step` }
            }
            if (resolvesToMarkerStep(steps, gateIndex, targetRef)) {
                return ({ error: `Error: ${location} targets[${index}] "${String(targetRef)}"`
                    + ` must not reference a fanout marker step` })
            }
            const targetIndex = resolveGateTargetRef(steps, gateIndex, targetRef)
            if (targetIndex < 0) {
                return ({ error: `Error: ${location} targets[${index}] "${String(targetRef)}"`
                    + ` must reference a previous task step${typeof targetRef === "string" ? " by id" : ""}` })
            }
            if (!targetIndices.includes(targetIndex)) targetIndices.push(targetIndex)
        }
        targetIndices.sort((a, b) => a - b)
        return { indices: targetIndices }
    }
    const targetRef = gate.target_step
    if (targetRef !== undefined && resolvesToMarkerStep(steps, gateIndex, targetRef)) {
        return ({ error: `Error: ${location} target_step "${String(targetRef)}"`
            + ` must not reference a fanout/join marker step` })
    }
    const targetIndex = resolveGateTargetIndex(steps, gateIndex)
    if (targetIndex < 0) {
        if (targetRef === undefined) {
            return { error: `Error: ${location} has no preceding task step to verify` }
        }
        return ({ error: `Error: ${location} target_step "${String(targetRef)}"`
            + ` must reference a previous task step${typeof targetRef === "string" ? " by id" : ""}` })
    }
    targetIndices.push(targetIndex)
    return { indices: targetIndices }
}

/** Validate that a task step's \`inputs\` reference previous task or join steps within scope. */
function validateTaskInputs(
    steps: readonly LoweredWorkflowStep[],
    task: LoweredWorkflowLinearStep,
    index: number,
    displayStep: number,
): string | null {
    if (task.kind !== "task" || task.inputs === undefined) return null
    const location = stepLocation(task, displayStep, true)
    const inputIndices = resolveWorkflowInputIndices(steps, index) ?? []
    for (let inputPosition = 0; inputPosition < task.inputs.length; inputPosition += 1) {
        const inputIndex = inputIndices[inputPosition]
        if (inputIndex === undefined || inputIndex < 0 || !canConsumeWorkflowInput(steps, index, inputIndex)) {
            return (`Error: ${location} inputs[${inputPosition}] must reference a previous task`
                + ` or join step in the same workflow scope`)
        }
    }
    return null
}

/** Maximum retry count accepted from workflow input. */
const MAX_RETRY_COUNT = 5
/** Validate that a retry-count field is an integer in [0, MAX_RETRY_COUNT]. Returns null when absent or valid, an error string otherwise. */
function validateRetryCountField(
    value: number | undefined,
    fieldName: string,
    location: string,
): string | null {
    if (value === undefined) return null
    if (!Number.isInteger(value) || value < 0 || value > MAX_RETRY_COUNT) {
        return `Error: ${location} ${fieldName} must be an integer from 0 to ${MAX_RETRY_COUNT}`
    }
    return null
}

/** Full semantic validation of a lowered task step: rejects gate fields, validates retry/cap consistency, checks team membership. */
function validateLoweredTaskStep(
    steps: readonly LoweredWorkflowStep[],
    task: LoweredWorkflowLinearStep,
    index: number,
    displayStep: number,
    team: Team,
): string | null {
    if (task.kind !== "task") return null
    const location = stepLocation(task, displayStep, true)
    // Cross-kind field check: validate that a task step does NOT have gate-only fields.
    // Gate-only field names — if any is defined on a task step, it is a user error.
    // Kept in sync with WorkflowGateToolStep in core/types/workflow.ts.
    const GATE_ONLY_FIELDS = [
        "verifier", "fallback_verifier", "criteria", "target_step",
        "targets", "on_fail", "max_retries", "on_invalid",
        "max_invalid_retries", "where", "verifiers", "ensemble_policy",
        "ensemble_quorum", "on_malformed", "max_malformed_retries",
        "on_pass_goto", "on_fail_goto", "on_invalid_goto",
        "max_jumps", "loop",
    ] as const satisfies readonly string[]
    const f = task as Record<string, unknown>
    if (GATE_ONLY_FIELDS.some(field => f[field] !== undefined)) {
        return `Error: ${location} must not set gate fields`
    }
    if (f.on_timeout !== undefined
        && f.on_timeout !== "fail" && f.on_timeout !== "retry" && f.on_timeout !== "skip") {
        return `Error: ${location} on_timeout must be fail, retry, or skip`
    }
    if (!task.member) return `Error: ${location} requires \`member\``
    if (!task.task) return `Error: ${location} requires \`task\``
    const inputsError = validateTaskInputs(steps, task, index, displayStep)
    if (inputsError !== null) return inputsError
    if (task.retry_on !== undefined) {
        // Require retry_on to be a non-null object before reading its fields
        // because workflow input may contain malformed values.
        if (typeof task.retry_on !== "object" || task.retry_on === null || Array.isArray(task.retry_on)) {
            return `Error: ${location} retry_on must be an object`
        }
        const condCount = [
            task.retry_on.empty,
            task.retry_on.output_contains,
            task.retry_on.output_not_contains,
            task.retry_on.regex,
        ].filter(v => v !== undefined).length
        if (condCount === 0) {
            return (`Error: ${location} retry_on must set exactly one of empty, output_contains,`
                + ` output_not_contains, or regex`)
        }
        if (condCount > 1) return `Error: ${location} retry_on must set exactly one condition (found ${condCount})`
        // Type-check each condition before compiling regexes or using string
        // methods. Reject empty:false because it is not an active condition.
        if (task.retry_on.empty !== undefined && task.retry_on.empty !== true) {
            return `Error: ${location} retry_on.empty must be true if present`
        }
        if (task.retry_on.output_contains !== undefined && typeof task.retry_on.output_contains !== "string") {
            return `Error: ${location} retry_on.output_contains must be a string`
        }
        if (task.retry_on.output_not_contains !== undefined && typeof task.retry_on.output_not_contains !== "string") {
            return `Error: ${location} retry_on.output_not_contains must be a string`
        }
        if (task.retry_on.regex !== undefined && typeof task.retry_on.regex !== "string") {
            return `Error: ${location} retry_on.regex must be a string`
        }
        if (task.max_task_retries === undefined) return `Error: ${location} with retry_on requires \`max_task_retries\``
    }
        // Bound max_task_retries so workflow input cannot request excessive retries.
        const maxTaskRetriesErr = validateRetryCountField(task.max_task_retries, "max_task_retries", location)
        if (maxTaskRetriesErr !== null) return maxTaskRetriesErr
        if (task.max_task_retries !== undefined && task.retry_on === undefined) {
            return `Error: ${location} max_task_retries requires \`retry_on\``
        }
        // Pre-compile regex at validation time to catch invalid patterns
        // before the run starts.
        if (task.retry_on?.regex !== undefined) {
            try {
                new RegExp(task.retry_on.regex)
            } catch (err) {
                return `Error: ${location} retry_on.regex is invalid: ${err instanceof Error ? err.message : String(err)}`
            }
        }
    if (task.max_output_bytes !== undefined
        && (!Number.isInteger(task.max_output_bytes) || task.max_output_bytes <= 0)) {
        return `Error: ${location} max_output_bytes must be a positive integer`
    }
    if (task.timeout_ms !== undefined && (!Number.isInteger(task.timeout_ms) || task.timeout_ms < 1000)) {
        return `Error: ${location} timeout_ms must be an integer >= 1000`
    }
    if (task.on_timeout === "retry" && task.max_timeout_retries === undefined) {
        return `Error: ${location} with on_timeout='retry' requires \`max_timeout_retries\``
    }
    // Apply the bounded integer check to max_timeout_retries.
    const maxTimeoutRetriesErr = validateRetryCountField(task.max_timeout_retries, "max_timeout_retries", location)
    if (maxTimeoutRetriesErr !== null) return maxTimeoutRetriesErr
    if (!isTeamMember(team, task.member)) {
        return `Error: unknown member "${task.member}" in ${stepLocation(task, displayStep, false)}`
    }
    if (task.fallback_member !== undefined && !isTeamMember(team, task.fallback_member)) {
        return `Error: ${location} fallback_member "${task.fallback_member}" is not a team member`
    }
    if (task.fallback_member !== undefined && task.fallback_member === task.member) {
        return `Error: ${location} fallback_member must differ from member`
    }
    return null
}

/** Full semantic validation of a lowered gate step: rejects task fields, validates 
 * verifier/ensemble/goto/loop/where constraints, checks team membership. */
function validateLoweredGateStep(
    steps: readonly LoweredWorkflowStep[],
    gate: LoweredWorkflowLinearStep,
    index: number,
    displayStep: number,
    team: Team,
): string | null {
    if (gate.kind !== "gate") return null
    const location = stepLocation(gate, displayStep, true)
    // Cross-kind field check: validate that a gate step does NOT have task-only fields.
    // Task-only field names — kept in sync with WorkflowTaskToolStep.
    const TASK_ONLY_FIELDS = [
        "member", "fallback_member", "task", "retry_on", "max_task_retries",
    ] as const satisfies readonly string[]
    const f = gate as Record<string, unknown>
    if (TASK_ONLY_FIELDS.some(field => f[field] !== undefined)) {
        const hasRetryFields = f.retry_on !== undefined || f.max_task_retries !== undefined
        return `Error: ${location} must not set ${hasRetryFields ? "task retry" : "task"} fields`
    }
    if (f.on_fail !== undefined && f.on_fail !== "retry" && f.on_fail !== "fail" && f.on_fail !== "skip") {
        return `Error: ${location} on_fail must be retry, fail, or skip`
    }
    if (f.on_invalid !== undefined
        && f.on_invalid !== "fail" && f.on_invalid !== "retry_verifier" && f.on_invalid !== "escalate") {
        return `Error: ${location} on_invalid must be fail, retry_verifier, or escalate`
    }
    if (f.on_malformed !== undefined
        && f.on_malformed !== "fail" && f.on_malformed !== "retry_verifier"
        && f.on_malformed !== "skip" && f.on_malformed !== "escalate") {
        return `Error: ${location} on_malformed must be fail, retry_verifier, skip, or escalate`
    }
    if (f.on_timeout !== undefined
        && f.on_timeout !== "fail" && f.on_timeout !== "retry" && f.on_timeout !== "skip") {
        return `Error: ${location} on_timeout must be fail, retry, or skip`
    }
    if (f.ensemble_policy !== undefined
        && f.ensemble_policy !== "majority" && f.ensemble_policy !== "quorum"
        && f.ensemble_policy !== "unanimous") {
        return `Error: ${location} ensemble_policy must be majority, quorum, or unanimous`
    }
    if (gate.inputs !== undefined || gate.expose_output !== undefined) {
        return `Error: ${location} must not set task data-flow fields`
    }
    if (gate.max_output_bytes !== undefined) {
        return `Error: ${location} must not set max_output_bytes (task steps only)`
    }
    if (gate.timeout_ms !== undefined && (!Number.isInteger(gate.timeout_ms) || gate.timeout_ms < 1000)) {
        return `Error: ${location} timeout_ms must be an integer >= 1000`
    }
    if (gate.on_timeout === "retry" && gate.max_timeout_retries === undefined) {
        return `Error: ${location} with on_timeout='retry' requires \`max_timeout_retries\``
    }
    // Apply bounded integer checks to all gate retry-count fields.
    for (const [fieldName, value] of [
        ["max_retries", gate.max_retries],
        ["max_invalid_retries", gate.max_invalid_retries],
        ["max_malformed_retries", gate.max_malformed_retries],
        ["max_timeout_retries", gate.max_timeout_retries],
    ] as const) {
        const err = validateRetryCountField(value, fieldName, location)
        if (err !== null) return err
    }
    if (!gate.verifier && !gate.verifiers) return `Error: ${location} requires \`verifier\` or \`verifiers\``
    if (!gate.criteria) return `Error: ${location} requires \`criteria\``
    if (gate.target_step !== undefined && gate.targets !== undefined) {
        return `Error: ${location} must not set both target_step and targets`
    }
    if (gate.on_fail === "retry" && gate.max_retries === undefined) {
        return `Error: ${location} with on_fail='retry' requires \`max_retries\``
    }
    if (gate.on_fail === "skip" && gate.on_fail_goto !== undefined) {
        return `Error: ${location} on_fail_goto is incompatible with on_fail='skip'`
    }
    if (gate.on_invalid === "retry_verifier" && gate.max_invalid_retries === undefined) {
        return `Error: ${location} with on_invalid='retry_verifier' requires \`max_invalid_retries\``
    }
    if (gate.on_malformed === "retry_verifier" && gate.max_malformed_retries === undefined) {
        return `Error: ${location} with on_malformed='retry_verifier' requires \`max_malformed_retries\``
    }
    if (gate.max_jumps !== undefined && (gate.max_jumps < 0 || gate.max_jumps > 10)) {
        return `Error: ${location} max_jumps must be between 0 and 10`
    }
    if (gate.max_jumps !== undefined && gate.on_pass_goto === undefined
        && gate.on_fail_goto === undefined && gate.on_invalid_goto === undefined) {
        return `Error: ${location} max_jumps requires on_pass_goto/on_fail_goto/on_invalid_goto (no goto to bound)`
    }
    if (gate.loop !== undefined) {
        // Validate loop shape and bounds before runtime to prevent invalid or
        // unbounded retries.
        if (typeof gate.loop !== "object" || gate.loop === null || Array.isArray(gate.loop)) {
            return `Error: ${location} loop must be an object`
        }
        const loopMax = (gate.loop as { max_iterations?: unknown }).max_iterations
        if (!Number.isInteger(loopMax) || (loopMax as number) < 1 || (loopMax as number) > 20) {
            return `Error: ${location} loop.max_iterations must be an integer from 1 to 20`
        }
        const loopOnExhaust = (gate.loop as { on_exhaust?: unknown }).on_exhaust
        if (loopOnExhaust !== undefined && loopOnExhaust !== "fail" && loopOnExhaust !== "continue") {
            return `Error: ${location} loop.on_exhaust must be 'fail' or 'continue'`
        }
        if (gate.on_fail_goto === undefined) {
            return `Error: ${location} loop requires \`on_fail_goto\` (no backward jump target)`
        }
        if (gate.on_fail === "retry") {
            return `Error: ${location} loop is incompatible with on_fail='retry' (use on_fail='fail' with on_fail_goto)`
        }
        if (gate.on_fail === "skip") return `Error: ${location} loop is incompatible with on_fail='skip'`
    }
    if (gate.where !== undefined) {
        if (gate.on_pass_goto === undefined && gate.on_fail_goto === undefined) {
            return `Error: ${location} where requires on_pass_goto or on_fail_goto`
        }
        const parsed = parseWorkflowCondition(gate.where)
        if ("error" in parsed) return `Error: ${location} ${parsed.error}`
    }
    for (const [field, ref] of [
        ["on_pass_goto", gate.on_pass_goto],
        ["on_fail_goto", gate.on_fail_goto],
        ["on_invalid_goto", gate.on_invalid_goto],
    ] as const) {
        if (ref === undefined) continue
        // Goto refs must not target fanout markers, which cannot be runtime
        // jump destinations.
        if (resolvesToMarkerStep(steps, index, ref)) {
            return (`Error: ${location} ${field} "${String(ref)}" must not reference a fanout marker step`)
        }
        const gotoIdx = resolveGotoIndex(steps, index, ref)
        if (gotoIdx < 0) {
            return (`Error: ${location} ${field} "${String(ref)}" must reference an existing step`
                + `${typeof ref === "string" ? " by id" : ""} and must not self-jump`)
        }
        // Goto targets must be task or gate steps because runtime jump handling
        // rejects join and fanout steps.
        const targetStep = steps[gotoIdx]
        if (targetStep && targetStep.kind !== "task" && targetStep.kind !== "gate") {
            return `Error: ${location} ${field} "${String(ref)}" must reference a task or gate step, not ${targetStep.kind}`
        }
        // Top-level gates cannot jump into fanout branches; gotos must stay
        // within their workflow scope.
        const gateStep = steps[index]
        if (targetStep && gateStep?.kind === "gate" && gateStep.branch === undefined && targetStep.branch !== undefined) {
            return `Error: ${location} ${field} "${String(ref)}" references a branch-internal step from a top-level gate — gotos cannot cross branch boundaries`
        }
        if (gate.on_invalid === "escalate" && field === "on_invalid_goto") {
            return (`Error: ${location} on_invalid_goto is incompatible with on_invalid='escalate'`
                + ` (escalate uses approve/reject)`)
        }
    }
    if (gate.approval_after === true
        && (gate.on_pass_goto !== undefined || gate.on_fail_goto !== undefined
            || gate.on_invalid_goto !== undefined)) {
        return (`Error: ${location} approval_after is incompatible with on_pass_goto/on_fail_goto`
            + `/on_invalid_goto (team_approve calls advance, which cannot honor a goto jump)`)
    }
    const targetIndices = resolveAndValidateGateTargets(steps, gate, index, displayStep)
    if ("error" in targetIndices) return targetIndices.error
    for (const targetIndex of targetIndices.indices) {
        const target = steps[targetIndex]
        // join steps carry joinedOutput (no member/actor); skip member and
        // self-verification checks — they only apply to task steps.
        if (target?.kind === "join") {
            // A gate verifying a join cannot retry: the retry path re-dispatches
            // the target as a task, but a join has no actor. Reject at config time.
            if (gate.on_fail === "retry") {
                return `Error: ${location} on_fail='retry' is incompatible with a join target (join has no actor to re-dispatch). Use on_fail='fail' or on_fail='skip' instead.`
            }
            continue
        }
        if (target?.kind !== "task" || !target.member) {
            return `Error: step ${targetIndex + 1} (task) requires \`member\``
        }
        const targetActors = [
            { field: "member", name: target.member },
            { field: "fallback_member", name: target.fallback_member },
        ]
        const verifierActors = [
            { field: "verifier", name: gate.verifier },
            { field: "fallback_verifier", name: gate.fallback_verifier },
        ]
        for (const verifierActor of verifierActors) {
            if (verifierActor.name === undefined) continue
            const matchingTarget = targetActors.find(targetActor => targetActor.name === verifierActor.name)
            if (matchingTarget !== undefined) {
                return (`Error: ${location} ${verifierActor.field} "${verifierActor.name}" must differ from`
                    + ` ${targetStepErrorLabel(target, targetIndex)} ${matchingTarget.field} (no self-verification)`)
            }
        }
    }
    if (targetIndices.indices.length === 0) {
        if (gate.targets === undefined) {
            return `Error: ${location} has no preceding task or join step to verify`
        }
        return `Error: ${location} targets must reference at least one previous task or join step`
    }
    if (gate.verifier !== undefined && !isTeamMember(team, gate.verifier)) {
        return `Error: unknown member "${gate.verifier}" in ${location} verifier`
    }
    if (gate.fallback_verifier !== undefined && !isTeamMember(team, gate.fallback_verifier)) {
        return `Error: ${location} fallback_verifier "${gate.fallback_verifier}" is not a team member`
    }
    if (gate.fallback_verifier !== undefined && gate.fallback_verifier === gate.verifier) {
        return `Error: ${location} fallback_verifier must differ from verifier`
    }
    if (gate.verifiers !== undefined) {
        // Verify verifiers is an array before iterating because workflow files
        // may contain malformed values.
        if (!Array.isArray(gate.verifiers)) {
            return `Error: ${location} verifiers must be an array of strings`
        }
        if (gate.verifiers.length < 2) {
            return `Error: ${location} verifiers must have at least 2 entries for an ensemble`
        }
        if (gate.verifier !== undefined) return `Error: ${location} verifiers is mutually exclusive with verifier`
        if (gate.fallback_verifier !== undefined) {
            return `Error: ${location} verifiers is mutually exclusive with fallback_verifier`
        }
        if (gate.ensemble_policy === undefined) return `Error: ${location} with verifiers requires \`ensemble_policy\``
        if (gate.ensemble_policy === "quorum" && gate.ensemble_quorum === undefined) {
            return `Error: ${location} with ensemble_policy='quorum' requires \`ensemble_quorum\``
        }
        for (const vName of gate.verifiers) {
            if (!isTeamMember(team, vName)) return `Error: ${location} verifiers entry "${vName}" is not a team member`
            for (const targetIndex of targetIndices.indices) {
                const target = steps[targetIndex]
                if (target?.kind === "task" && (target.member === vName || target.fallback_member === vName)) {
                    return (`Error: ${location} verifiers entry "${vName}" must differ from`
                        + ` ${targetStepErrorLabel(target, targetIndex)} member (no self-verification)`)
                }
            }
        }
        // Deduplicate check: a member listed twice would have its vote counted
        // twice under majority/quorum/unanimous aggregation.
        const dedup = new Set<string>()
        for (const vName of gate.verifiers) {
            if (dedup.has(vName)) {
                return `Error: ${location} verifiers contains duplicate "${vName}"`
            }
            dedup.add(vName)
        }
    }
    if (gate.ensemble_policy !== undefined && gate.verifiers === undefined) {
        return `Error: ${location} ensemble_policy requires \`verifiers\``
    }
    if (gate.ensemble_quorum !== undefined && gate.ensemble_policy !== "quorum") {
        return `Error: ${location} ensemble_quorum requires ensemble_policy='quorum'`
    }
    if (gate.ensemble_quorum !== undefined
        && (typeof gate.ensemble_quorum !== "number" || !Number.isFinite(gate.ensemble_quorum)
            || gate.ensemble_quorum <= 0 || gate.ensemble_quorum > 1)) {
        return (`Error: ${location} ensemble_quorum must be a number > 0 and <= 1`)
    }
    return null
}

/** Validate a lowered fanout step: verify reducer_member is a team member when applicable. */
function validateLoweredFanoutStep(step: LoweredWorkflowFanoutStep, displayStep: number, team: Team): string | null {
    if ((step.fanout.joinPolicy === "reduce" || step.fanout.joinPolicy === "select")
        && step.fanout.reducerMember !== undefined
        && !isTeamMember(team, step.fanout.reducerMember)) {
        return `Error: fanout step ${displayStep} reducer_member "${step.fanout.reducerMember}" is not a team member`
    }
    return null
}

// --- graph validator ---

/** Full structural and semantic validation of the lowered workflow graph against a team. */
export function validateWorkflowGraph(args: ResolvedWorkflowToolArgs, team: Team): string | null {
    if (args.steps.length === 0) {
        return "Error: steps must contain at least one step"
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
                const taskError = validateLoweredTaskStep(loweredSteps, s, i, displayStep, team)
                if (taskError !== null) return taskError
                break
            }
            case "gate": {
                const gateError = validateLoweredGateStep(loweredSteps, s, i, displayStep, team)
                if (gateError !== null) return gateError
                break
            }
            case "fanout": {
                const fanoutError = validateLoweredFanoutStep(s, displayStep, team)
                if (fanoutError !== null) return fanoutError
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

/** Validate resolved workflow args against a team (delegates to validateWorkflowGraph). */
export function validateWorkflowArgs(args: ResolvedWorkflowToolArgs, team: Team): string | null {
    return validateWorkflowGraph(args, team)
}

/** Validate workflow steps against a member name list (used by planner). */
export function validateWorkflowStepsAgainstMembers(
    steps: readonly WorkflowToolStep[],
    memberNames: readonly string[],
    teamName: string,
): string | null {
    const shapeError = validateMatrixForeachShapeInSteps(steps)
    if (shapeError !== null) return shapeError
    const members: MemberState[] = memberNames.map(name => ({
        name,
        status: "idle" as const,
        initialized: true,
        turnCount: 0,
    }))
    const team: Team = {
        version: 1,
        teamRunId: `synthetic-${teamName}`,
        teamName,
        status: "live",
        leadSessionId: "synthetic",
        members,
        bounds: defaultBounds(),
        createdAt: Date.now(),
        mutex: new AsyncMutex(),
        directory: "",
    }
    const expanded = safeExpandMatrixForeach(steps)
    if (typeof expanded === "string") return expanded
    const resolvedArgs: ResolvedWorkflowToolArgs = {
        team_id: teamName,
        steps: expanded,
    }
    return validateWorkflowArgs(resolvedArgs, team)
}

// --- source validation + arg resolution ---

/** Validate that exactly one of steps or workflow_file is set. */
export function validateWorkflowSource(args: WorkflowToolArgs): string | null {
    if (hasInlineSteps(args) === (args.workflow_file !== undefined)) {
        return "Error: team_workflow must set exactly one of steps or workflow_file"
    }
    if (args.steps !== undefined && args.steps.length === 0) return "Error: steps must contain at least one step"
    return null
}

/** Check whether args include inline steps (vs. a workflow_file). */
export function hasInlineSteps(args: WorkflowToolArgs): boolean {
    return args.steps !== undefined
}

/** Expand matrix and foreach fanouts, returning a user-facing error for branch-limit failures. */
function safeExpandMatrixForeach(steps: readonly WorkflowToolStep[]): WorkflowToolStep[] | string {
    try {
        return expandMatrixForeachFanout(steps)
    } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
}

/** Resolve workflow args: load loader if needed, expand matrix/foreach, validate source. */
export async function resolveWorkflowArgs(
    ctx: PluginContext, args: WorkflowToolArgs,
): Promise<ResolvedWorkflowToolArgs | string> {
    const sourceError = validateWorkflowSource(args)
    if (sourceError) return sourceError
    if (args.steps !== undefined) {
        const shapeError = validateMatrixForeachShapeInSteps(args.steps)
        if (shapeError !== null) return shapeError
        const validated = validateWorkflowSteps(args.steps)
        if ("error" in validated) return validated.error
        const expanded = safeExpandMatrixForeach(validated.steps)
        if (typeof expanded === "string") return expanded
        // Enforce the global step cap after expansion.
        if (expanded.length > WORKFLOW_MAX_TOTAL_STEPS) {
            return `Error: workflow expands to ${expanded.length} steps, exceeding the ${WORKFLOW_MAX_TOTAL_STEPS} limit`
        }
        return { ...args, steps: expanded }
    }
    if (!args.workflow_file) {
        return "Error: either steps or workflow_file is required"
    }
    const loaded = await loadWorkflowFile(ctx.directory, args.workflow_file, args.vars ?? {})
    if ("error" in loaded) return loaded.error
    const shapeError = validateMatrixForeachShapeInSteps(loaded.steps)
    if (shapeError !== null) return shapeError
    const expanded = safeExpandMatrixForeach(loaded.steps)
    if (typeof expanded === "string") return expanded
    return { ...args, steps: expanded }
}

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
import type { WorkflowStep, WorkflowTask } from "../core/types.js"
import { formatWorkflowCondition, parseWorkflowCondition } from "../core/workflow-conditions.js"
import { activationError } from "../core/utils.js"
import { dispatchToMember } from "../orchestration/dispatch.js"
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
    score_gte?: number
    score_lt?: number
    confidence_gte?: number
    has_issue_severity?: "low" | "medium" | "high" | "critical"
}

export type WorkflowToolStep = {
    kind: "task" | "gate"
    id?: string
    member?: string
    task?: string
    verifier?: string
    criteria?: string
    target_step?: number | string
    targets?: Array<number | string>
    on_fail?: "retry" | "fail"
    max_retries?: number
    on_invalid?: "fail" | "retry_verifier" | "escalate"
    max_invalid_retries?: number
    on_pass_goto?: number | string
    on_fail_goto?: number | string
    on_invalid_goto?: number | string
    where?: WorkflowWhere
    max_jumps?: number
}

type WorkflowToolArgs = {
    team_id: string
    steps?: WorkflowToolStep[]
    workflow_file?: string
    vars?: Record<string, string>
    dry_run?: boolean
    signoff_policy?: "none" | "decider" | "peer-quorum"
    signoff_decider?: string
}

type ResolvedWorkflowToolArgs = WorkflowToolArgs & { steps: WorkflowToolStep[] }

/**
 * Resolve a gate target reference (number 1-based or string step id).
 * Returns -1 when the target cannot be resolved or points forward/to a gate.
 */
function resolveGateTargetRef(steps: WorkflowToolStep[], gateIndex: number, target: number | string): number {
    if (typeof target === "number") {
        const idx = target - 1
        return idx >= 0 && idx < gateIndex && steps[idx]?.kind === "task" ? idx : -1
    }
    const idx = steps.findIndex((s, i) => i < gateIndex && s.kind === "task" && s.id === target)
    return idx
}

/** Resolve the primary single target, or nearest preceding task when omitted. */
function resolveGateTargetIndex(steps: WorkflowToolStep[], gateIndex: number): number {
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
function resolveGateTargetIndices(steps: WorkflowToolStep[], gateIndex: number): number[] {
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

function primaryTargetIndex(indices: number[]): number | undefined {
    return indices.length === 0 ? undefined : indices[0]
}

/**
 * Resolve a verdict-driven goto target (1-based number or step id) to a 0-based
 * step index. Unlike gate target_step, a goto may reference ANY step (task or
 * gate) except the gate itself. Returns -1 when unresolvable.
 */
function resolveGotoIndex(steps: WorkflowToolStep[], gateIndex: number, ref: number | string | undefined): number {
    if (ref === undefined) return -1
    if (typeof ref === "number") {
        const idx = ref - 1
        return idx >= 0 && idx < steps.length && idx !== gateIndex ? idx : -1
    }
    const idx = steps.findIndex((s, i) => i !== gateIndex && s.id === ref)
    return idx
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
    // Unique step ids (when declared).
    const ids = new Map<string, number>()
    for (let i = 0; i < args.steps.length; i++) {
        const s = args.steps[i]
        if (s.id === undefined) continue
        const prev = ids.get(s.id)
        if (prev !== undefined) {
            return `Error: duplicate step id "${s.id}" at steps ${prev + 1} and ${i + 1}`
        }
        ids.set(s.id, i)
    }
    for (let i = 0; i < args.steps.length; i++) {
        const s = args.steps[i]
        const displayStep = i + 1
        if (s.kind === "task") {
            if (s.verifier !== undefined || s.criteria !== undefined || s.target_step !== undefined || s.targets !== undefined || s.on_fail !== undefined || s.max_retries !== undefined || s.on_invalid !== undefined || s.max_invalid_retries !== undefined || s.where !== undefined) {
                return `Error: step ${displayStep} (task) must not set gate fields`
            }
            if (!s.member) return `Error: step ${displayStep} (task) requires \`member\``
            if (!s.task) return `Error: step ${displayStep} (task) requires \`task\``
            if (!team.members.some(m => m.name === s.member)) {
                return `Error: unknown member "${s.member}" in step ${displayStep}`
            }
            continue
        }

        if (s.member !== undefined || s.task !== undefined) {
            return `Error: step ${displayStep} (gate) must not set task fields`
        }
        if (!s.verifier) return `Error: step ${displayStep} (gate) requires \`verifier\``
        if (!s.criteria) return `Error: step ${displayStep} (gate) requires \`criteria\``
        if (s.target_step !== undefined && s.targets !== undefined) {
            return `Error: step ${displayStep} (gate) must not set both target_step and targets`
        }
        if (s.on_fail === "retry" && s.max_retries === undefined) {
            return `Error: step ${displayStep} (gate) with on_fail='retry' requires \`max_retries\``
        }
        if (s.on_invalid === "retry_verifier" && s.max_invalid_retries === undefined) {
            return `Error: step ${displayStep} (gate) with on_invalid='retry_verifier' requires \`max_invalid_retries\``
        }
        if (s.max_jumps !== undefined && (s.max_jumps < 0 || s.max_jumps > 10)) {
            return `Error: step ${displayStep} (gate) max_jumps must be between 0 and 10`
        }
        if (s.where !== undefined) {
            if (s.on_pass_goto === undefined && s.on_fail_goto === undefined) {
                return `Error: step ${displayStep} (gate) where requires on_pass_goto or on_fail_goto`
            }
            const parsed = parseWorkflowCondition(s.where)
            if ("error" in parsed) return `Error: step ${displayStep} (gate) ${parsed.error}`
        }
        // Conditional-jump goto targets must resolve and must not self-jump.
        for (const [field, ref] of [
            ["on_pass_goto", s.on_pass_goto],
            ["on_fail_goto", s.on_fail_goto],
            ["on_invalid_goto", s.on_invalid_goto],
        ] as const) {
            if (ref === undefined) continue
            const gotoIdx = resolveGotoIndex(args.steps, i, ref)
            if (gotoIdx < 0) {
                return `Error: step ${displayStep} (gate) ${field} "${String(ref)}" must reference an existing step${typeof ref === "string" ? " by id" : ""} and must not self-jump`
            }
            if (s.on_invalid === "escalate" && field === "on_invalid_goto") {
                return `Error: step ${displayStep} (gate) on_invalid_goto is incompatible with on_invalid='escalate' (escalate uses approve/reject)`
            }
        }
        const targetIndices: number[] = []
        if (s.targets !== undefined) {
            for (let j = 0; j < s.targets.length; j++) {
                const targetRef = s.targets[j]
                const idx = targetRef === undefined ? -1 : resolveGateTargetRef(args.steps, i, targetRef)
                if (idx < 0) {
                    return `Error: step ${displayStep} (gate) targets[${j}] "${String(targetRef)}" must reference a previous task step${typeof targetRef === "string" ? " by id" : ""}`
                }
                if (!targetIndices.includes(idx)) targetIndices.push(idx)
            }
            targetIndices.sort((a, b) => a - b)
        } else {
            const targetIndex = resolveGateTargetIndex(args.steps, i)
            if (targetIndex < 0) {
                const t = s.target_step
                if (t === undefined) {
                    return `Error: step ${displayStep} (gate) has no preceding task step to verify`
                }
                return `Error: step ${displayStep} (gate) target_step "${String(t)}" must reference a previous task step${typeof t === "string" ? " by id" : ""}`
            }
            targetIndices.push(targetIndex)
        }
        for (const targetIndex of targetIndices) {
            const target = args.steps[targetIndex]
            if (!target?.member) return `Error: step ${targetIndex + 1} (task) requires \`member\``
            if (s.verifier === target.member) {
                return `Error: step ${displayStep} (gate) verifier "${s.verifier}" must differ from target step ${targetIndex + 1} member (no self-verification)`
            }
        }
        if (targetIndices.length === 0) {
            if (s.targets === undefined) {
                return `Error: step ${displayStep} (gate) has no preceding task step to verify`
            }
            return `Error: step ${displayStep} (gate) targets must reference at least one previous task step`
        }
        if (!team.members.some(m => m.name === s.verifier)) {
            return `Error: unknown member "${s.verifier}" in step ${displayStep} (gate verifier)`
        }
    }
    const signoffErr = validateSignoff(args, team)
    if (signoffErr) return signoffErr
    return null
}

function validateWorkflowArgs(args: ResolvedWorkflowToolArgs, team: Team): string | null {
    return validateWorkflowGraph(args, team)
}

function stepTargetLabel(args: ResolvedWorkflowToolArgs, gateIndex: number): string {
    const targetIndices = resolveGateTargetIndices(args.steps, gateIndex)
    if (targetIndices.length === 0) return "?"
    const labels = targetIndices.map(targetIndex => {
        const targetId = args.steps[targetIndex]?.id
        return targetId ? `${targetIndex + 1} (${targetId})` : `${targetIndex + 1}`
    })
    const first = labels[0]
    if (first === undefined) return "?"
    return labels.length === 1 ? `step ${first}` : `steps ${labels.join(", ")}`
}

function whereLabel(where: WorkflowWhere | undefined): string {
    if (where === undefined) return ""
    const parsed = parseWorkflowCondition(where)
    return "condition" in parsed ? ` when ${formatWorkflowCondition(parsed.condition)}` : ""
}

function formatWorkflowDryRun(args: ResolvedWorkflowToolArgs): string {
    const lines = [`Workflow dry run for "${args.team_id}" (${args.steps.length} step(s)):`]
    for (let i = 0; i < args.steps.length; i++) {
        const step = args.steps[i]
        const idTag = step.id ? ` (${step.id})` : ""
        if (step.kind === "task") {
            lines.push(`${i + 1}. [task]${idTag} ${step.member ?? "?"}: ${step.task ?? ""}`)
        } else {
            const target = stepTargetLabel(args, i)
            const retry = step.on_fail === "retry" ? `; on_fail=retry max_retries=${step.max_retries}` : ""
            const invalid = step.on_invalid && step.on_invalid !== "fail"
                ? `; on_invalid=${step.on_invalid}${step.on_invalid === "retry_verifier" ? ` max_invalid_retries=${step.max_invalid_retries}` : ""}`
                : ""
            const jumps: string[] = []
            const where = whereLabel(step.where)
            if (step.on_pass_goto !== undefined) jumps.push(`on_pass->${gotoRefLabel(args.steps, i, step.on_pass_goto)}${where}`)
            if (step.on_fail_goto !== undefined) jumps.push(`on_fail->${gotoRefLabel(args.steps, i, step.on_fail_goto)}${where}`)
            if (step.on_invalid_goto !== undefined) jumps.push(`on_invalid->${gotoRefLabel(args.steps, i, step.on_invalid_goto)}`)
            const jumpTag = jumps.length > 0 ? `; ${jumps.join(" ")} (max_jumps=${step.max_jumps ?? 3})` : ""
            lines.push(`${i + 1}. [gate]${idTag} ${step.verifier ?? "?"} verifies ${target}: ${step.criteria ?? ""}${retry}${invalid}${jumpTag}`)
        }
    }
    return lines.join("\n")
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
    if (args.steps !== undefined) return { ...args, steps: args.steps }
    if (args.workflow_file === undefined) return "Error: team_workflow must set exactly one of steps or workflow_file"
    const loaded = await loadWorkflowFile(ctx.directory, args.workflow_file, args.vars ?? {})
    if ("error" in loaded) return loaded.error
    return { ...args, steps: loaded.steps }
}

function gotoRefLabel(steps: WorkflowToolStep[], gateIndex: number, ref: number | string): string {
    const idx = resolveGotoIndex(steps, gateIndex, ref)
    const id = idx >= 0 ? steps[idx]?.id : undefined
    return id ? `step ${idx + 1} (${id})` : idx >= 0 ? `step ${idx + 1}` : "?"
}

export function teamWorkflowTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Run a deterministic, declaratively-composed workflow. Each step is either a `task` (one member produces output) or a `gate` (a verifier renders a PASS/FAIL/INVALID verdict over one or more prior task outputs). The engine drives transitions, retry, INVALID handling, and verdict-gated jumps while keeping intermediate results out of the leader's context.",
        args: {
            team_id: tool.schema.string().min(1),
            steps: tool.schema
                .array(
                    tool.schema.object({
                        kind: tool.schema.enum(["task", "gate"]),
                        id: tool.schema.string().min(1).max(64).optional().describe("optional stable step identifier; gates may reference a task step by this id via target_step or targets"),
                        // task step
                        member: tool.schema.string().min(1).optional().describe("task steps: the actor member name"),
                        task: tool.schema.string().min(1).max(8192).optional().describe("task steps: the task text"),
                        // gate step
                        verifier: tool.schema.string().min(1).optional().describe("gate steps: the verifier member name (must differ from the target task member)"),
                        criteria: tool.schema.string().min(1).max(8192).optional().describe("gate steps: verification criteria"),
                        target_step: tool.schema.union([tool.schema.number().int().min(1), tool.schema.string().min(1)]).optional().describe("gate steps: one target task step to verify — a 1-based number or a step id string; omitted means nearest preceding task. Mutually exclusive with targets."),
                        targets: tool.schema.array(tool.schema.union([tool.schema.number().int().min(1), tool.schema.string().min(1)])).min(1).optional().describe("gate steps: multiple prior task steps to verify together — 1-based numbers or step id strings. Mutually exclusive with target_step."),
                        on_fail: tool.schema.enum(["retry", "fail"]).optional().describe("gate steps: FAIL control. 'fail' (default) fails the run; 'retry' re-dispatches the target task up to max_retries."),
                        max_retries: tool.schema.number().int().min(0).max(5).optional().describe("gate steps: FAIL retry cap when on_fail='retry'. Default 0."),
                        on_invalid: tool.schema.enum(["fail", "retry_verifier", "escalate"]).optional().describe("gate steps: INVALID control. 'fail' (default) terminates producer-neutral as workflow_invalid; 'retry_verifier' re-dispatches this gate's verifier up to max_invalid_retries; 'escalate' pauses for human approval (approve=advance, reject=workflow_invalid)."),
                        max_invalid_retries: tool.schema.number().int().min(0).max(5).optional().describe("gate steps: retry_verifier cap when on_invalid='retry_verifier'. Default 0. Required when on_invalid='retry_verifier'."),
                        on_pass_goto: tool.schema.union([tool.schema.number().int().min(1), tool.schema.string().min(1)]).optional().describe("gate steps: step to jump to after PASS (1-based number or step id) instead of advancing linearly. Enables skip / redo paths."),
                        on_fail_goto: tool.schema.union([tool.schema.number().int().min(1), tool.schema.string().min(1)]).optional().describe("gate steps: step to jump to at a FAIL terminal point (on_fail=fail, or retry exhausted) instead of failing the run."),
                        on_invalid_goto: tool.schema.union([tool.schema.number().int().min(1), tool.schema.string().min(1)]).optional().describe("gate steps: step to jump to at an INVALID terminal point (on_invalid=fail, or retry_verifier exhausted). Incompatible with on_invalid='escalate'."),
                        where: tool.schema.object({
                            score_gte: tool.schema.number().optional(),
                            score_lt: tool.schema.number().optional(),
                            confidence_gte: tool.schema.number().optional(),
                            has_issue_severity: tool.schema.enum(["low", "medium", "high", "critical"]).optional(),
                        }).optional().describe("gate steps: optional threshold condition gating on_pass_goto/on_fail_goto. Exactly one condition key is allowed."),
                        max_jumps: tool.schema.number().int().min(0).max(10).optional().describe("gate steps: per-gate cap on verdict-driven jumps. Default 3. Terminates as workflow_failed:jump_limit when exceeded."),
                    }),
                )
                .min(1)
                .optional()
                .describe("ordered workflow steps; the first step must be a `task` (a gate verifies a preceding task)"),
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
                    const steps: WorkflowStep[] = resolvedArgs.steps.map((s, index) => {
                        const targetIndices = s.kind === "gate" ? resolveGateTargetIndices(resolvedArgs.steps, index) : []
                        const where = s.kind === "gate" && s.where !== undefined ? parseWorkflowCondition(s.where) : undefined
                        return {
                            kind: s.kind,
                            id: s.id,
                            member: s.kind === "task" ? s.member : undefined,
                            task: s.kind === "task" ? s.task : undefined,
                            verifier: s.kind === "gate" ? s.verifier : undefined,
                            criteria: s.kind === "gate" ? s.criteria : undefined,
                            targetStepIndex: s.kind === "gate" ? primaryTargetIndex(targetIndices) : undefined,
                            targetStepIndices: s.kind === "gate" && s.targets !== undefined ? targetIndices : undefined,
                            onFail: s.kind === "gate" ? (s.on_fail ?? "fail") : undefined,
                            maxRetries: s.kind === "gate" ? s.max_retries : undefined,
                            attempts: 0,
                            onInvalid: s.kind === "gate" ? (s.on_invalid ?? "fail") : undefined,
                            maxInvalidRetries: s.kind === "gate" ? s.max_invalid_retries : undefined,
                            invalidAttempts: 0,
                            onPassGoto: s.kind === "gate" ? resolveGotoIndex(resolvedArgs.steps, index, s.on_pass_goto) : undefined,
                            onFailGoto: s.kind === "gate" ? resolveGotoIndex(resolvedArgs.steps, index, s.on_fail_goto) : undefined,
                            onInvalidGoto: s.kind === "gate" ? resolveGotoIndex(resolvedArgs.steps, index, s.on_invalid_goto) : undefined,
                            where: where !== undefined && "condition" in where ? where.condition : undefined,
                            maxJumps: s.kind === "gate" ? s.max_jumps : undefined,
                            jumpCount: 0,
                            completed: false,
                        }
                    })
                    const wfTask: WorkflowTask = {
                        type: "workflow",
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        stages: [],
                        steps,
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
                    const first = team.members.find(m => m.name === step.member && !m.isMaster)
                    if (!first?.sessionId || first.status === "errored") throw new Error(`workflow initial member "${step.member}" has no live session`)
                    await dispatchToMember(ctx, first, step.task, first.worktreePath ?? ctx.directory, team)
                },
                // successMessage
                () => `team_workflow started on "${args.team_id}" with ${resolvedArgs.steps.length} step(s).`,
            )
        },
    })
}

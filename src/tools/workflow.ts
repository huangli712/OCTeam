/**
 * team_workflow tool -- deterministic, declaratively-composed linear step
 * engine (GAP-2). Each step is either a `task` (one member produces output) or
 * a `gate` (a verifier renders a PASS/FAIL verdict over the preceding task's
 * output). The engine -- not the master LLM -- drives every step transition,
 * keeping intermediate results out of master context. MVP: linear advancement
 * with gate-driven retry; no fanout/route/loop step kinds.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import type { WorkflowStep, WorkflowTask } from "../core/types.js"
import { activationError } from "../core/utils.js"
import { dispatchToMember } from "../orchestration/dispatch.js"
import { resolveCallerInTeam } from "../state/resolve.js"
import { loadTeamState, type Team } from "../state/store.js"
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

type WorkflowToolStep = {
    kind: "task" | "gate"
    member?: string
    task?: string
    verifier?: string
    criteria?: string
    target_step?: number
    on_fail?: "retry" | "fail"
    max_retries?: number
}

type WorkflowToolArgs = {
    team_id: string
    steps: WorkflowToolStep[]
    dry_run?: boolean
    signoff_policy?: "none" | "decider" | "peer-quorum"
    signoff_decider?: string
}

function nearestTaskStepIndex(steps: WorkflowToolStep[], beforeIndex: number): number {
    for (let i = beforeIndex - 1; i >= 0; i--) {
        if (steps[i]?.kind === "task") return i
    }
    return -1
}

function resolveGateTargetIndex(steps: WorkflowToolStep[], gateIndex: number): number {
    const gate = steps[gateIndex]
    if (gate?.kind === "gate" && gate.target_step !== undefined) return gate.target_step - 1
    return nearestTaskStepIndex(steps, gateIndex)
}

function validateWorkflowArgs(args: WorkflowToolArgs, team: Team): string | null {
    if (args.steps.length === 0) {
        return "Error: steps must contain at least one step"
    }
    if (args.steps[0]?.kind !== "task") {
        return "Error: step 1 must be a task; a gate has no preceding task step to verify"
    }
    for (let i = 0; i < args.steps.length; i++) {
        const s = args.steps[i]
        const displayStep = i + 1
        if (s.kind === "task") {
            if (s.verifier !== undefined || s.criteria !== undefined || s.target_step !== undefined || s.on_fail !== undefined || s.max_retries !== undefined) {
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
        if (s.on_fail === "retry" && s.max_retries === undefined) {
            return `Error: step ${displayStep} (gate) with on_fail='retry' requires \`max_retries\``
        }
        const targetIndex = resolveGateTargetIndex(args.steps, i)
        if (targetIndex < 0 || targetIndex >= i) {
            return `Error: step ${displayStep} (gate) target_step must reference a previous task step`
        }
        const target = args.steps[targetIndex]
        if (target?.kind !== "task") {
            return `Error: step ${displayStep} (gate) target_step must reference a task step`
        }
        if (!target.member) return `Error: step ${targetIndex + 1} (task) requires \`member\``
        if (s.verifier === target.member) {
            return `Error: step ${displayStep} (gate) verifier "${s.verifier}" must differ from target step ${targetIndex + 1} member (no self-verification)`
        }
        if (!team.members.some(m => m.name === s.verifier)) {
            return `Error: unknown member "${s.verifier}" in step ${displayStep} (gate verifier)`
        }
    }
    const signoffErr = validateSignoff(args, team)
    if (signoffErr) return signoffErr
    return null
}

function formatWorkflowDryRun(args: WorkflowToolArgs): string {
    const lines = [`Workflow dry run for "${args.team_id}" (${args.steps.length} step(s)):`]
    for (let i = 0; i < args.steps.length; i++) {
        const step = args.steps[i]
        if (step.kind === "task") {
            lines.push(`${i + 1}. [task] ${step.member ?? "?"}: ${step.task ?? ""}`)
        } else {
            const target = resolveGateTargetIndex(args.steps, i)
            const retry = step.on_fail === "retry" ? `; on_fail=retry max_retries=${step.max_retries}` : ""
            lines.push(`${i + 1}. [gate] ${step.verifier ?? "?"} verifies step ${target + 1}: ${step.criteria ?? ""}${retry}`)
        }
    }
    return lines.join("\n")
}

export function teamWorkflowTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Run a deterministic, declaratively-composed linear workflow. Each step is either a `task` (one member produces output) or a `gate` (a verifier renders a PASS/FAIL verdict over the preceding task's output). The engine drives every step transition; intermediate results stay out of the leader's context. Gate FAIL with on_fail='retry' re-dispatches the preceding task up to max_retries, else fails the run. MVP: linear + gate retry only.",
        args: {
            team_id: tool.schema.string().min(1),
            steps: tool.schema
                .array(
                    tool.schema.object({
                        kind: tool.schema.enum(["task", "gate"]),
                        // task step
                        member: tool.schema.string().min(1).optional().describe("task steps: the actor member name"),
                        task: tool.schema.string().min(1).max(8192).optional().describe("task steps: the task text"),
                        // gate step
                        verifier: tool.schema.string().min(1).optional().describe("gate steps: the verifier member name (must differ from the preceding task member)"),
                        criteria: tool.schema.string().min(1).max(8192).optional().describe("gate steps: verification criteria"),
                        target_step: tool.schema.number().int().min(1).optional().describe("gate steps: 1-based previous task step to verify; omitted means nearest preceding task"),
                        on_fail: tool.schema.enum(["retry", "fail"]).optional().describe("gate steps: FAIL control. 'fail' (default) fails the run; 'retry' re-dispatches the preceding task up to max_retries."),
                        max_retries: tool.schema.number().int().min(0).max(5).optional().describe("gate steps: FAIL retry cap when on_fail='retry'. Default 0."),
                    }),
                )
                .min(1)
                .describe("ordered workflow steps; the first step must be a `task` (a gate verifies a preceding task)"),
            dry_run: tool.schema.boolean().optional().describe("Validate and render the 1-based workflow step ledger without starting orchestration"),
            ...signoffSchemaFields,
            ...humanApprovalSchemaFields,
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            if (args.dry_run) {
                const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
                if (!caller?.isMaster) return "Error: team_workflow is master-only"
                const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)
                const gate = activationError(team.teamName, team.activatedAt)
                if (gate) return gate
                const validationError = validateWorkflowArgs(args, team)
                if (validationError) return validationError
                return formatWorkflowDryRun(args)
            }
            return startOrchestration(
                args.team_id, context, ctx, "team_workflow",
                // validate
                (team) => {
                    return validateWorkflowArgs(args, team)
                },
                // buildTask
                async (team) => {
                    const steps: WorkflowStep[] = args.steps.map((s, index) => ({
                        kind: s.kind,
                        member: s.kind === "task" ? s.member : undefined,
                        task: s.kind === "task" ? s.task : undefined,
                        verifier: s.kind === "gate" ? s.verifier : undefined,
                        criteria: s.kind === "gate" ? s.criteria : undefined,
                        targetStepIndex: s.kind === "gate" ? resolveGateTargetIndex(args.steps, index) : undefined,
                        onFail: s.kind === "gate" ? (s.on_fail ?? "fail") : undefined,
                        maxRetries: s.kind === "gate" ? s.max_retries : undefined,
                        attempts: 0,
                        completed: false,
                    }))
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
                () => `team_workflow started on "${args.team_id}" with ${args.steps.length} step(s).`,
            )
        },
    })
}

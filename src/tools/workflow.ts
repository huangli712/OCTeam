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
import { dispatchToMember } from "../orchestration/dispatch.js"
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
                        on_fail: tool.schema.enum(["retry", "fail"]).optional().describe("gate steps: FAIL control. 'fail' (default) fails the run; 'retry' re-dispatches the preceding task up to max_retries."),
                        max_retries: tool.schema.number().int().min(0).max(5).optional().describe("gate steps: FAIL retry cap when on_fail='retry'. Default 0."),
                    }),
                )
                .min(1)
                .describe("ordered workflow steps; the first step must be a `task` (a gate verifies a preceding task)"),
            ...signoffSchemaFields,
            ...humanApprovalSchemaFields,
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_workflow",
                // validate
                (team) => {
                    if (args.steps.length === 0) {
                        return "Error: steps must contain at least one step"
                    }
                    for (let i = 0; i < args.steps.length; i++) {
                        const s = args.steps[i]
                        if (s.kind === "task") {
                            if (!s.member) return `Error: step ${i} (task) requires \`member\``
                            if (!s.task) return `Error: step ${i} (task) requires \`task\``
                            if (!team.members.some(m => m.name === s.member)) {
                                return `Error: unknown member "${s.member}" in step ${i}`
                            }
                        } else {
                            // gate step
                            if (!s.verifier) return `Error: step ${i} (gate) requires \`verifier\``
                            if (!s.criteria) return `Error: step ${i} (gate) requires \`criteria\``
                            // A gate verifies a preceding task's output; a gate-first
                            // workflow has nothing to verify.
                            const hasPrecedingTask = args.steps.slice(0, i).some(x => x.kind === "task")
                            if (!hasPrecedingTask) {
                                return `Error: step ${i} (gate) has no preceding task step to verify`
                            }
                            // No self-verification: the gate's verifier must differ from
                            // the nearest preceding task's member (mirrors tollgate).
                            let precedingTaskMember: string | undefined
                            for (let j = i - 1; j >= 0; j--) {
                                if (args.steps[j].kind === "task") {
                                    precedingTaskMember = args.steps[j].member
                                    break
                                }
                            }
                            if (precedingTaskMember && s.verifier === precedingTaskMember) {
                                return `Error: step ${i} (gate) verifier "${s.verifier}" must differ from the preceding task member (no self-verification)`
                            }
                            if (!team.members.some(m => m.name === s.verifier)) {
                                return `Error: unknown member "${s.verifier}" in step ${i} (gate verifier)`
                            }
                        }
                    }
                    const signoffErr = validateSignoff(args, team)
                    if (signoffErr) return signoffErr
                    return null
                },
                // buildTask
                async (team) => {
                    const steps: WorkflowStep[] = args.steps.map(s => ({
                        kind: s.kind,
                        member: s.kind === "task" ? s.member : undefined,
                        task: s.kind === "task" ? s.task : undefined,
                        verifier: s.kind === "gate" ? s.verifier : undefined,
                        criteria: s.kind === "gate" ? s.criteria : undefined,
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
                    if (!step || step.kind !== "task" || !step.member || !step.task) return
                    const first = team.members.find(m => m.name === step.member && !m.isMaster)
                    if (!first) return
                    await dispatchToMember(ctx, first, step.task, first.worktreePath ?? ctx.directory, team)
                },
                // successMessage
                () => `team_workflow started on "${args.team_id}" with ${args.steps.length} step(s).`,
            )
        },
    })
}

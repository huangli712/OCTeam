/**
 * team_pipeline tool -- linear handoff stage N -> stage N+1.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import type { Stage } from "../core/types.js"
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

export function teamPipelineTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Run a linear pipeline: stage N's output is prefixed onto stage N+1's task. Each stage runs on its named member, in order. The final output is summarized to the leader.",
        args: {
            team_id: tool.schema.string().min(1),
            stages: tool.schema
                .array(
                    tool.schema.object({
                        member: tool.schema.string().min(1),
                        task: tool.schema.string().min(1).max(8192),
                    }),
                )
                .min(1),
            ...signoffSchemaFields,
            ...humanApprovalSchemaFields,
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_pipeline",
                // validate
                (team) => {
                    const stageMembers = args.stages.map(s => s.member)
                    if (new Set(stageMembers).size !== stageMembers.length) {
                        return "Error: pipeline stages must have unique member names"
                    }
                    const signoffErr = validateSignoff(args, team)
                    if (signoffErr) return signoffErr
                    // Validate members exist.
                    for (const name of stageMembers) {
                        if (!team.members.some(m => m.name === name)) {
                            return `Error: unknown member "${name}" in stages`
                        }
                    }
                    return null
                },
                // buildTask
                async (team) => {
                    const stages: Stage[] = args.stages.map(s => ({
                        member: s.member,
                        task: s.task,
                        completed: false,
                    }))
                    return {
                        type: "pipeline",
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        stages,
                        ...humanApprovalTaskFields(args),
                        ...signoffTaskFields(args),
                    }
                },
                // dispatch: stage 0.
                async (team, task) => {
                    const first = team.members.find(m => m.name === task.stages[0].member)!
                    await dispatchToMember(ctx, first, task.stages[0].task, first.worktreePath ?? ctx.directory, team)
                },
                // successMessage
                () => `team_pipeline started on "${args.team_id}" with ${args.stages.length} stage(s).`,
            )
        },
    })
}

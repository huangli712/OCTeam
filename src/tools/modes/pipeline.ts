/**
 * team_pipeline tool -- linear handoff stage N -> stage N+1.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import type { Stage } from "../../core/types.js"
import { dispatchToMember } from "../../orchestration/control/dispatch.js"
import {
    DEFAULT_TIMEOUT_MS,
    baseTaskFields,
    humanApprovalTaskFields,
    signoffTaskFields,
    startOrchestration,
} from "../../orchestration/lifecycle/startup.js"
import { commonOrchestrationFields, humanApprovalSchemaFields, signoffSchemaFields } from "../schema.js"
import { validateSignoff } from "../support.js"

/** Run a linear pipeline where each stage passes its output to the next. */
export function teamPipelineTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Run a linear pipeline: stage N's output is prefixed onto stage N+1's task. "
            + "Each stage runs on its named member, in order. The final output is summarized to the leader.",
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
            ...commonOrchestrationFields,
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
                        if (!team.members.some(m => m.name === name && !m.isMaster)) {
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
                    const firstStage = task.stages[0]
                    if (!firstStage) return
                    const first = team.members.find(m => m.name === firstStage.member)
                    if (first) {
                        await dispatchToMember(ctx, first, firstStage.task, first.worktreePath ?? ctx.directory, team)
                    }
                },
                // successMessage
                () => `team_pipeline started on "${args.team_id}" with ${args.stages.length} stage(s).`,
            )
        },
    })
}

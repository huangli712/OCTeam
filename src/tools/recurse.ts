/**
 * team_recurse tool -- hierarchical recursive decomposition. A root task is
 * decomposed into subtasks (which may themselves decompose up to max_depth);
 * sub-task results aggregate back up until the root is solved.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { dispatchToMember } from "../orchestration/control/dispatch.js"
import { createTask, listAllTasks } from "../state/tasks.js"
import { buildRecursePrompt } from "../orchestration/modes/recurse.js"
import {
    DEFAULT_RECURSE_DEPTH,
    DEFAULT_RECURSE_SUBTASKS,
    DEFAULT_TIMEOUT_MS,
    baseTaskFields,
    humanApprovalTaskFields,
    signoffTaskFields,
    startOrchestration,
} from "../orchestration/lifecycle/start-orchestration.js"
import { humanApprovalSchemaFields, signoffSchemaFields } from "./shared-schema.js"
import { assertMember, validateSignoff } from "./support.js"

/** Hierarchical recursive decomposition of a root task into subtasks. */
export function teamRecurseTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Hierarchical recursive decomposition: a root task is decomposed into subtasks (which may themselves decompose up to max_depth), sub-task results are aggregated back up, until the root is solved. Uses the shared task list and blockedBy DAG for layered aggregation.",
        args: {
            team_id: tool.schema.string().min(1),
            task: tool.schema.string().min(1).max(8192).describe("the root task / goal to recursively decompose and solve"),
            decomposer: tool.schema.string().min(1).describe("member name first dispatched with the root task (NOT \"master\"); decomposition is open to all members"),
            max_depth: tool.schema.number().int().min(1).max(8).optional().describe("recursion depth upper bound (default 3). Tasks at this depth cannot decompose further."),
            max_subtasks: tool.schema.number().int().min(1).max(20).optional().describe("per-decomposition subtask upper bound (default 5)"),
            ...signoffSchemaFields,
            ...humanApprovalSchemaFields,
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
            max_errored_members: tool.schema.number().int().min(0).optional().describe("tolerate up to N terminally-errored members and still deliver survivors' work. Default 0 (any member error fails the run). Recurse uses a shared task pool like delegate, so failure isolation applies to independent subtask execution."),
        },
        async execute(args, context) {
            let rootTaskId = ""
            return startOrchestration(
                args.team_id, context, ctx, "team_recurse",
                // validate
                (team) => {
                    if (args.decomposer === "master") {
                        return "Error: decomposer must be a member name, not \"master\""
                    }
                    const decomposerErr = assertMember(team, args.decomposer, "decomposer")
                    if (decomposerErr) return decomposerErr
                    const signoffErr = validateSignoff(args, team)
                    if (signoffErr) return signoffErr
                    return null
                },
                // buildTask: seed the root task BEFORE committing activeTask
                // so a mid-create failure leaves the team idle.
                async (team) => {
                    // Enforce maxTasks: seeding the root task via createTask
                    // bypasses team_task_create's cap check, so guard here.
                    const liveTasks = (await listAllTasks(team.directory)).filter(
                        t => t.status !== "deleted",
                    ).length
                    if (liveTasks >= team.bounds.maxTasks) {
                        return { error: `Error: team task limit reached (${team.bounds.maxTasks}). Complete or delete tasks before creating more.` }
                    }
                    const subject = args.task.length <= 480 ? args.task : args.task.slice(0, 477) + "..."
                    const root = await createTask(team.directory, {
                        subject,
                        description: args.task,
                        depth: 0,
                    })
                    rootTaskId = root.id
                    return {
                        type: "recurse",
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        stages: [],
                        task: args.task,
                        decomposerMember: args.decomposer,
                        maxDepth: args.max_depth ?? DEFAULT_RECURSE_DEPTH,
                        maxSubtasks: args.max_subtasks ?? DEFAULT_RECURSE_SUBTASKS,
                        rootTaskId: root.id,
                        maxErroredMembers: args.max_errored_members,
                        ...humanApprovalTaskFields(args),
                        ...signoffTaskFields(args),
                    }
                },
                // dispatch: ONLY the decomposer with the recursive contract;
                // other members pull claimable tasks via the tail's re-prompt.
                async (team) => {
                    const decomposer = team.members.find(m => m.name === args.decomposer && !m.isMaster)
                    if (decomposer) {
                        await dispatchToMember(ctx, decomposer, buildRecursePrompt(), decomposer.worktreePath ?? ctx.directory, team)
                    }
                },
                // successMessage
                () => `team_recurse started on "${args.team_id}" (decomposer: ${args.decomposer}, root task: ${rootTaskId}).`,
            )
        },
    })
}

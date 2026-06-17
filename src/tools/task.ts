/**
 * Shared task-list tools: team_task_create/list/update/get (design §4.7).
 * Used by collaborative modes (parallel-collaborative, delegate) for
 * pull-based coordination. team_task_update with status "claimed" acquires the
 * persistent claim lock atomically (claimTask).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../context.js"
import { resolveTeamMember } from "../utils.js"
import {
    TaskAlreadyClaimedError,
    claimTask,
    createTask,
    getTask,
    listAllTasks,
    updateTask,
} from "../tasks.js"
import type { TaskStatus } from "../tasks.js"

export function teamTaskCreateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "Create a task in the shared team task list. Tasks can declare blockedBy dependencies (other task IDs).",
        args: {
            team_id: tool.schema.string().min(1),
            subject: tool.schema.string().min(1).max(500),
            description: tool.schema.string().min(1).max(8192),
            blocked_by: tool.schema.array(tool.schema.string()).optional(),
        },
        async execute(args) {
            let dir: string
            try {
                dir = await teamDirFor(ctx, args.team_id)
            } catch {
                return `Error: team "${args.team_id}" not found`
            }
            const task = await createTask(dir, {
                subject: args.subject,
                description: args.description,
                blockedBy: args.blocked_by,
            })
            return `Task created: ${task.id} [${task.subject}]`
        },
    })
}

export function teamTaskListTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "List tasks in the shared team task list. Optional filters: status, owner.",
        args: {
            team_id: tool.schema.string().min(1),
            status: tool.schema
                .enum(["pending", "claimed", "in_progress", "completed", "deleted"])
                .optional(),
            owner: tool.schema.string().optional(),
        },
        async execute(args) {
            const dir = await teamDirFor(ctx, args.team_id)
            let tasks = await listAllTasks(dir)
            if (args.status) tasks = tasks.filter(t => t.status === (args.status as TaskStatus))
            if (args.owner) tasks = tasks.filter(t => t.owner === args.owner)
            if (tasks.length === 0) return "No tasks."
            return tasks
                .map(
                    t =>
                        `- [${t.status}] ${t.id} ${t.subject}${t.owner ? ` @${t.owner}` : ""}${t.blockedBy.length ? ` (blocked by ${t.blockedBy.length})` : ""}`,
                )
                .join("\n")
        },
    })
}

export function teamTaskUpdateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Update a task. Setting status to \"claimed\" atomically acquires the claim lock (fails if another member holds it). The caller becomes the task owner on claim.",
        args: {
            team_id: tool.schema.string().min(1),
            task_id: tool.schema.string().min(1),
            status: tool.schema.enum(["claimed", "in_progress", "completed", "deleted"]),
        },
        async execute(args, context) {
            const dir = await teamDirFor(ctx, args.team_id)
            const caller = await resolveTeamMember(ctx.storageRoot, context.sessionID)
            const owner = caller?.name ?? "unknown"
            if (args.status === "claimed") {
                try {
                    const task = await claimTask(dir, args.task_id, owner)
                    return `Claimed task ${task.id} [${task.subject}].`
                } catch (err) {
                    if (err instanceof TaskAlreadyClaimedError) {
                        return `Error: task ${args.task_id} already claimed or not claimable.`
                    }
                    throw err
                }
            }
            const task = await updateTask(dir, args.task_id, {
                status: args.status as TaskStatus,
            })
            return `Task ${task.id} updated to ${args.status}.`
        },
    })
}

export function teamTaskGetTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "Get full details of a single task.",
        args: {
            team_id: tool.schema.string().min(1),
            task_id: tool.schema.string().min(1),
        },
        async execute(args) {
            const dir = await teamDirFor(ctx, args.team_id)
            const task = await getTask(dir, args.task_id)
            if (!task) return `Error: task ${args.task_id} not found`
            return [
                `Task ${task.id}`,
                `Subject: ${task.subject}`,
                `Status: ${task.status}${task.owner ? ` (@${task.owner})` : ""}`,
                `Description: ${task.description}`,
                task.blockedBy.length ? `Blocked by: ${task.blockedBy.join(", ")}` : "",
            ]
                .filter(Boolean)
                .join("\n")
        },
    })
}

/** Resolve a team_id to its on-disk directory (validates the team exists). */
async function teamDirFor(ctx: PluginContext, teamId: string): Promise<string> {
    const { loadTeamState } = await import("../state/store.js")
    const team = await loadTeamState(ctx.storageRoot, teamId)
    return team.directory
}

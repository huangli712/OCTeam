/**
 * Shared task-list tools: team_task_create/list/update/get (design §4.7).
 * Used by collaborative modes (parallel-collaborative, delegate) for
 * pull-based coordination. team_task_update with status "claimed" acquires the
 * persistent claim lock atomically (claimTask).
 *
 * Every tool is team-scoped: the caller must be a member (or master) of
 * args.team_id, enforced via resolveCallerInTeam. Non-claim status updates
 * additionally require task ownership (or master) so a member cannot mutate
 * another member's claimed task.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../context.js"
import { resolveCallerInTeam } from "../utils.js"
import { loadTeamState } from "../state/store.js"
import {
    TASK_ID_PATTERN,
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
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller) return "Error: caller is not a member of this team"
            // P2 (§8.1): cap live (non-deleted) tasks per team to bound disk use
            // and prevent a member from flooding the shared tasklist (DoS).
            const team = await loadTeamState(ctx.storageRoot, args.team_id)
            const liveTasks = (await listAllTasks(caller.directory)).filter(
                t => t.status !== "deleted",
            ).length
            if (liveTasks >= team.bounds.maxTasks) {
                return `Error: team task limit reached (${team.bounds.maxTasks}). Complete or delete tasks before creating more.`
            }
            const task = await createTask(caller.directory, {
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
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller) return "Error: caller is not a member of this team"
            let tasks = await listAllTasks(caller.directory)
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
            "Update a task. Setting status to \"claimed\" atomically acquires the claim lock (fails if another member holds it). The caller becomes the task owner on claim. Other status changes require the caller to be the task owner or master.",
        args: {
            team_id: tool.schema.string().min(1),
            task_id: tool.schema.string().regex(TASK_ID_PATTERN, "must be a task UUID"),
            status: tool.schema.enum(["claimed", "in_progress", "completed", "deleted"]),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller) return "Error: caller is not a member of this team"
            const dir = caller.directory
            if (args.status === "claimed") {
                try {
                    const task = await claimTask(dir, args.task_id, caller.name)
                    return `Claimed task ${task.id} [${task.subject}].`
                } catch (err) {
                    if (err instanceof TaskAlreadyClaimedError) {
                        return `Error: task ${args.task_id} already claimed or not claimable.`
                    }
                    throw err
                }
            }
            // Non-claim updates: only the current owner (or master) may change a
            // task's status, so one member cannot overwrite another's claimed work.
            const existing = await getTask(dir, args.task_id)
            if (!existing) return `Error: task ${args.task_id} not found`
            if (!caller.isMaster && existing.owner !== caller.name) {
                return `Error: only the task owner (@${existing.owner ?? "unassigned"}) or master can update task ${args.task_id}.`
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
            task_id: tool.schema.string().regex(TASK_ID_PATTERN, "must be a task UUID"),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller) return "Error: caller is not a member of this team"
            const task = await getTask(caller.directory, args.task_id)
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

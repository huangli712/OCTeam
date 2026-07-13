/**
 * Shared task-list tools: team_task_create/list/update/get.
 * Used by cooperative modes (parallel-cooperative, delegate) for
 * pull-based coordination. team_task_update with status "claimed" acquires the
 * persistent claim lock atomically (claimTask).
 *
 * Every tool is team-scoped: the caller must be a member (or master) of
 * args.team_id, enforced via resolveCallerInTeam. Non-claim status updates
 * additionally require task ownership (or master) so a member cannot mutate
 * another member's claimed task.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { resolveCallerInTeam } from "../state/resolve.js"
import { loadTeamState } from "../state/store.js"
import {
    TASK_ID_PATTERN,
    MemberHoldsActiveTaskError,
    TaskAlreadyClaimedError,
    TaskOwnershipError,
    claimTask,
    createTask,
    getTask,
    listAllTasks,
    updateTask,
} from "../state/tasks.js"
import type { TaskStatus } from "../state/tasks.js"

/** Create a new task on the team's shared task list. */
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
            let team
            try {
                team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)
            } catch {
                return `Error: team "${args.team_id}" not found`
            }
            // Recurse mode guard: subtasks are created AUTOMATICALLY by the
            // orchestrator from the decomposer's <decompose> block. A member
            // calling team_task_create manually produces duplicate tasks that
            // siblings then claim and work in parallel with the real ones,
            // doubling token spend and confusing aggregation. Reject at the
            // source so the LLM cannot create duplicates even when its scene
            // prompt is ignored. The decomposer never needs team_task_create.
            if (team.activeTask?.type === "recurse") {
                return (
                    `Error: team_task_create is disabled in recurse mode. Subtasks are created `
                    + `automatically by the orchestrator from the decomposer's <decompose> block. `
                    + `Emit a <decompose>{"subtasks":[...]}</decompose> block instead — the orchestrator `
                    + `parses it, creates the subtasks, and re-queues the root as their aggregator.`
                )
            }
            // Validate blocked_by entries: each must be a well-formed task ID
            // (UUID) referencing an existing non-deleted task. A bogus blocker
            // (typo) would make the task permanently unclaimable in delegate
            // mode (delegate.ts:62 never resolves a non-existent blocker to
            // "completed"), wedging the team in a deadlock.
            if (args.blocked_by && args.blocked_by.length > 0) {
                const existing = await listAllTasks(caller.directory)
                const existingIds = new Set(
                    existing.filter(t => t.status !== "deleted").map(t => t.id),
                )
                for (const id of args.blocked_by) {
                    if (!TASK_ID_PATTERN.test(id)) {
                        return `Error: blocked_by entry "${id}" is not a valid task ID.`
                    }
                    if (!existingIds.has(id)) {
                        return `Error: blocked_by entry "${id}" does not match an existing task.`
                    }
                }
            }
            // Wrap the count-check + create in team.mutex so concurrent
            // team_task_create calls cannot both read the same live-task count
            // and both bypass maxTasks. Without this, the check-then-act race
            // lets two callers both pass the limit and both create.
            let task
            let limitError = false
            await team.mutex.runExclusive(async () => {
                const liveTasks = (await listAllTasks(caller.directory)).filter(
                    t => t.status !== "deleted",
                ).length
                if (liveTasks >= team.bounds.maxTasks) {
                    limitError = true
                    return
                }
                task = await createTask(caller.directory, {
                    subject: args.subject,
                    description: args.description,
                    blockedBy: args.blocked_by,
                })
            })
            if (limitError) {
                return `Error: team task limit reached (${team.bounds.maxTasks}). Complete or delete tasks before creating more.`
            }
            return `Task created: ${task!.id} [${task!.subject}]`
        },
    })
}

/** List tasks from the team's shared task list with optional filters. */
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

/** Update a task's status or metadata on the shared task list. */
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
                    if (err instanceof MemberHoldsActiveTaskError) {
                        return `Error: ${err.message}`
                    }
                    throw err
                }
            }
            // Non-claim updates: owner check is TOCTOU-safe inside updateTask's
            // lock (expectedOwner). Master bypasses the owner check.
            const existing = await getTask(dir, args.task_id)
            if (!existing) return `Error: task ${args.task_id} not found`
            // Recurse-mode guard (symmetric to team_task_create's guard):
            // completion is owned by the orchestrator. A member calling
            // team_task_update(status="completed") manually races the
            // orchestrator's own finalize (recurse.ts leaf branch), which also
            // writes the result field. The member's call carries no result,
            // so if it lands after the orchestrator's finalize it leaves the
            // task completed-but-resultless. Reject so the orchestrator stays
            // the single writer of terminal status in recurse mode. Only fires
            // for status="completed"; other statuses (in_progress/deleted) are
            // unaffected. loadTeamState is only called on this path (not the
            // claim path), so the guard adds zero overhead to hot operations.
            if (args.status === "completed") {
                let team
                try {
                    team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)
                } catch {
                    // team not found — no activeTask to guard, proceed
                }
                if (team?.activeTask?.type === "recurse") {
                    return (
                        `Error: in recurse mode, task completion is owned by the orchestrator. `
                        + `Do NOT call team_task_update(status="completed") — the orchestrator `
                        + `finalizes your task automatically when you go idle, including writing `
                        + `your output as the result. Just solve the task and go idle.`
                    )
                }
            }
            try {
                const task = await updateTask(
                    dir,
                    args.task_id,
                    { status: args.status as TaskStatus },
                    caller.isMaster ? {} : { expectedOwner: caller.name },
                )
                return `Task ${task.id} updated to ${args.status}.`
            } catch (err) {
                if (err instanceof TaskOwnershipError) {
                    return `Error: only the task owner (@${existing.owner ?? "unassigned"}) or master can update task ${args.task_id}.`
                }
                throw err
            }
        },
    })
}

/** Get a single task's details by its ID. */
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
                task.depth ? `Depth: ${task.depth}` : "",
                `Description: ${task.description}`,
                task.blockedBy.length ? `Blocked by: ${task.blockedBy.join(", ")}` : "",
                task.result ? `Result: ${task.result}` : "",
            ]
                .filter(Boolean)
                .join("\n")
        },
    })
}

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
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"

import type { PluginContext } from "../../core/context.js"
import { resolveCallerInTeam } from "../../state/resolve.js"
import { loadTeamState } from "../../state/store.js"
import {
    TASK_ID_PATTERN,
    MemberHoldsActiveTaskError,
    TaskAlreadyClaimedError,
    TaskBlockedByError,
    TaskOwnershipError,
    claimTask,
    createTask,
    getTask,
    listAllTasks,
    updateTask,
} from "../../state/tasks.js"
import type { Task } from "../../core/types/task.js"
import type { TaskStatus } from "../../core/types.js"
import type { ResolvedMember } from "../../state/resolve.js"

/**
 * Reject shared-task access from a member in a parallel isolated run. Isolated
 * members must not read or mutate the shared task list — doing so forms a side
 * channel that defeats isolation. Returns an error string to surface, or null
 * when access is allowed. Fails closed: an unreadable state file rejects too.
 */
async function rejectIfIsolated(
    ctx: PluginContext,
    caller: ResolvedMember,
    teamId: string,
): Promise<string | null> {
    try {
        const team = await loadTeamState(caller.storageRoot, teamId, caller.leadSessionId)
        const at = team.activeTask
        if (at?.type === "parallel" && !at.tasks) {
            return `Error: shared task access is disabled in parallel isolated mode. Isolated members cannot share a task list.`
        }
        return null
    } catch (err) {
        if (isEnoent(err)) return `Error: team "${teamId}" not found`
        logSwallowed(ctx, "loadTeamState failed during isolated-mode check", err, { team: teamId })
        return `Error: cannot verify team state for isolated-mode check. Underlying error: ${err instanceof Error ? err.message : String(err)}`
    }
}

/** Create a new task on the team's shared task list. */
export function teamTaskCreateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Create a task in the shared team task list. Tasks can declare blockedBy "
            + "dependencies (other task IDs).",
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
                team = await loadTeamState(caller.storageRoot, args.team_id, caller.leadSessionId)
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
            }
            // H60: recurse mode guard moved INSIDE team.mutex (below) so a
            // concurrent startOrchestration cannot flip activeTask to recurse
            // between this check and the create. Pre-fix code checked at line
            // 65 outside the lock, allowing a race where recurse starts mid-
            // create and the member's manually-created task duplicates the
            // orchestrator's automatic subtask.
            // Wrap the count-check + blocked_by-check + create in team.mutex so
            // concurrent team_task_create / team_task_delete calls cannot race.
            let task: Task | undefined
            let limitError = false
            let blockedByError: string | undefined
            await team.mutex.runExclusive(async () => {
                // HIGH: tombstone guard — refuse writes after team_delete.
                if (team.deleted) {
                    blockedByError = "Error: team has been deleted"
                    return
                }
                // H60: re-check recurse mode INSIDE the mutex.
                if (team.activeTask?.type === "recurse") {
                    blockedByError = (
                        `Error: team_task_create is disabled in recurse mode. Subtasks are created `
                        + `automatically by the orchestrator from the decomposer's <decompose> block.`
                    )
                    return
                }
                // H8: parallel isolated mode prohibits task creation.
                // Isolated members must not communicate via shared task list.
                // isolated = no per-member tasks assigned (cooperative has `tasks`).
                const at = team.activeTask
                if (at?.type === "parallel" && !at.tasks) {
                    blockedByError = (
                        `Error: team_task_create is disabled in parallel isolated mode. `
                        + `Isolated members cannot share a task list.`
                    )
                    return
                }
                const allTasks = await listAllTasks(caller.directory)
                // blocked_by validation (moved inside mutex for TOCTOU safety).
                if (args.blocked_by && args.blocked_by.length > 0) {
                    const existingIds = new Set(
                        allTasks.filter(t => t.status !== "deleted").map(t => t.id),
                    )
                    for (const id of args.blocked_by) {
                        if (!TASK_ID_PATTERN.test(id)) {
                            blockedByError = `Error: blocked_by entry "${id}" is not a valid task ID.`
                            return
                        }
                        if (!existingIds.has(id)) {
                            blockedByError = `Error: blocked_by entry "${id}" does not match an existing task.`
                            return
                        }
                    }
                }
                const liveTasks = allTasks.filter(
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
            if (blockedByError) return blockedByError
            if (limitError) {
                return (
                    `Error: team task limit reached (${team.bounds.maxTasks}). `
                    + "Complete or delete tasks before creating more."
                )
            }
            if (!task) {
                return "Error: failed to create task (internal error)"
            }
            return `Task created: ${task.id} [${task.subject}]`
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
            const isolatedError = await rejectIfIsolated(ctx, caller, args.team_id)
            if (isolatedError) return isolatedError
            let tasks = await listAllTasks(caller.directory)
            if (args.status) tasks = tasks.filter(t => t.status === (args.status as TaskStatus))
            if (args.owner) tasks = tasks.filter(t => t.owner === args.owner)
            if (tasks.length === 0) return "No tasks."
            return tasks
                .map(
                    t =>
                        `- [${t.status}] ${t.id} ${t.subject}`
                        + `${t.owner ? ` @${t.owner}` : ""}`
                        + `${t.blockedBy.length ? ` (blocked by ${t.blockedBy.length})` : ""}`,
                )
                .join("\n")
        },
    })
}

/** Update a task's status or metadata on the shared task list. */
export function teamTaskUpdateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Update a task. Setting status to \"claimed\" atomically acquires the claim lock "
            + "(fails if another member holds it). The caller becomes the task owner on claim. "
            + "Other status changes require the caller to be the task owner or master.",
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
                // M29 fix: isolated mode (parallel without per-member tasks) also
                // prohibits claiming shared tasks, not just creating them.
                // Pre-fix code let isolated members claim existing tasks, forming
                // a side channel for reading shared task content.
                try {
                    const team = await loadTeamState(caller.storageRoot, args.team_id, caller.leadSessionId)
                    const at = team.activeTask
                    if (at?.type === "parallel" && !at.tasks) {
                        return `Error: team_task_claim is disabled in parallel isolated mode. Isolated members cannot share a task list.`
                    }
                } catch (err) {
                    // Fail closed: ENOENT means the team's state file is missing,
                    // so we cannot verify isolated-mode. Rejecting (rather than
                    // proceeding) prevents an isolated member from claiming a
                    // shared task via a missing-state side channel.
                    if (isEnoent(err)) {
                        return `Error: team "${args.team_id}" not found`
                    }
                    return `Error: cannot verify team state for isolated-mode check. Task claim rejected. Underlying error: ${err instanceof Error ? err.message : String(err)}`
                }
                try {
                    const task = await claimTask(dir, args.task_id, caller.name)
                    return `Claimed task ${task.id} [${task.subject}].`
                } catch (err) {
                    if (err instanceof TaskAlreadyClaimedError) {
                        return `Error: task ${args.task_id} already claimed or not claimable.`
                    }
                    if (err instanceof TaskBlockedByError) {
                        return `Error: ${err.message}`
                    }
                    if (err instanceof MemberHoldsActiveTaskError) {
                        return `Error: ${err.message}`
                    }
                    throw err
                }
            }
            // Non-claim updates also prohibited in parallel isolated mode: an
            // isolated member must not mutate the shared task list. The claim
            // path above enforces this for status="claimed"; enforce it here for
            // in_progress/completed/deleted before any shared-task mutation.
            const isolatedError = await rejectIfIsolated(ctx, caller, args.team_id)
            if (isolatedError) return isolatedError
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
                    team = await loadTeamState(caller.storageRoot, args.team_id, caller.leadSessionId)
                } catch (err) {
                    // Fail closed on every load error. ENOENT (state file
                    // missing) must not be treated as "no active run": that
                    // would let a member bypass the recurse single-writer guard
                    // and write a resultless completed task. Other errors
                    // (EACCES, EIO, corruption) fail closed for the same reason.
                    if (isEnoent(err)) {
                        return `Error: team "${args.team_id}" not found`
                    }
                    logSwallowed(ctx, "loadTeamState failed during recurse single-writer check; rejecting completion", err, { team: args.team_id })
                    return `Error: cannot verify team state for recurse single-writer check. Task completion rejected to avoid bypassing orchestrator ownership. Underlying error: ${err instanceof Error ? err.message : String(err)}`
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
                    return (
                        `Error: only the task owner (@${existing.owner ?? "unassigned"}) `
                        + `or master can update task ${args.task_id}.`
                    )
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
            const isolatedError = await rejectIfIsolated(ctx, caller, args.team_id)
            if (isolatedError) return isolatedError
            // HIGH #22: tombstone guard for non-claim updates.
            try {
                const team = await loadTeamState(caller.storageRoot, args.team_id, caller.leadSessionId)
                if (team.deleted) return "Error: team has been deleted"
            } catch { /* ENOENT handled below */ }
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

/**
 * Delegate and recurse handlers. Both modes drive a shared task pool: members
 * claim tasks, work them, and idle. runDelegateStyleTail owns the termination
 * engine shared by both — all-complete delivers, all-idle-with-claimable fails
 * as deadlock, otherwise the just-idled member is RATE-LIMITED re-prompted
 * toward remaining claimable tasks. Recorse adds a decomposition branch on top
 * (parse <decompose>, spawn subtasks, re-queue the parent as their aggregator).
 */

import type { PluginContext } from "../core/context.js"
import { type Team, clearActiveTask } from "../state/store.js"
import type { MemberState } from "../core/types.js"
import { createTask, listAllTasks, updateTask } from "../state/tasks.js"
import { dispatchToMember } from "./dispatch.js"
import { deliverSummaryToLeader } from "./summary.js"
import { recordEvent } from "./events.js"
import { parseDecompose } from "./decisions.js"
import { maybeTriggerSignoff } from "./signoff.js"

const NOTIFY_COOLDOWN_MS = 10_000

/**
 * Shared delegate-style termination tail: scan the task list, deliver on
 * all-complete, fail on deadlock, else rate-limit re-prompt the idling member
 * toward claimable tasks. Used by both delegate (label "delegate") and recurse
 * (label "recurse"); the reason prefix and re-prompt text differ by caller.
 */
async function runDelegateStyleTail(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
    label: string,
    buildReprompt: (claimableCount: number) => string,
): Promise<void> {
    const tasks = await listAllTasks(team.directory)
    const incomplete = tasks.filter(t => t.status !== "completed" && t.status !== "deleted")

    if (incomplete.length === 0) {
        if (await maybeTriggerSignoff(ctx, team)) {
            return  // signoff in progress
        }
        await deliverSummaryToLeader(ctx, team, `${label}_complete`)
        clearActiveTask(team)
        team.status = "idle"
        return
    }

    // Claimable tasks: pending AND all blockers completed.
    const claimable = incomplete.filter(
        t =>
            t.status === "pending"
            && t.blockedBy.every(id => tasks.find(x => x.id === id)?.status === "completed"),
    )

    // Deadlock: no claimable tasks and all members idle.
    if (claimable.length === 0) {
        // errored counts as terminal (like idle) so an errored member cannot wedge
        // the deadlock check — its claimed tasks are reaped by the sweep and a
        // survivor reclaims them.
        const allIdle = team.members.every(m => m.status === "idle" || m.status === "errored" || !m.sessionId)
        if (allIdle) {
            await deliverSummaryToLeader(ctx, team, `${label}_deadlock`)
            clearActiveTask(team)
            team.status = "failed"
            return
        }
        return // some members still running, wait
    }

    // Re-prompt this member — RATE-LIMITED to avoid claim-race busy-loop.
    const now = Date.now()
    if (member.lastNotifiedAt && now - member.lastNotifiedAt < NOTIFY_COOLDOWN_MS) {
        return
    }
    const running = team.members.filter(m => m.status === "running" && !m.isMaster).length
    if (claimable.length <= running) {
        return // enough members already heading for the available tasks
    }
    if (!member.sessionId) return
    member.lastNotifiedAt = now
    await dispatchToMember(ctx, member, buildReprompt(claimable.length), member.worktreePath ?? ctx.directory, team)
}

export async function handleDelegateIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    await runDelegateStyleTail(ctx, team, member, "delegate", n =>
        `[Team Orchestrator] You have completed your task. ${n} task(s) available. `
        + `Use team_task_list to check, team_task_update to claim, execute, then team_send_message `
        + `to report to master. Repeat until no tasks remain.`)
}

/**
 * Build the recursive-decomposition contract prompt: claim a task, then either
 * solve it directly or emit a <decompose> block; aggregate completed sub-tasks
 * instead of re-decomposing. Members must NOT call team_task_update completed —
 * the orchestrator finalizes their task on idle (eliminates finalize races).
 */
export function buildRecursePrompt(): string {
    return (
        `[Recursive task] Claim an available task (team_task_update status="claimed"), then read it (team_task_get).\n`
        + `Then EITHER:\n`
        + ` • Solve it directly — produce the full result as your final message; OR\n`
        + ` • If too large to solve in one step, emit exactly one:\n`
        + `   <decompose>{"subtasks":[{"subject":"...","description":"..."}]}</decompose>  (Chinese <分解> accepted)\n`
        + `If the task you claimed has completed sub-tasks (shown under "Blocked by"), DO NOT decompose —\n`
        + `read each sub-task's result via team_task_get and synthesize them into this task's result.\n`
        + `Do NOT call team_task_update completed — the orchestrator finalizes your task when you go idle.`
    )
}

/**
 * Hierarchical recursive decomposition (recurse mode). When a member idles,
 * the orchestrator inspects that member's claimed task and either:
 *   • branch — splits it into subtasks (depth+1) and re-queues the task as a
 *     pending aggregator blocked by those subtasks (re-claim aggregation); or
 *   • leaf — finalizes the task as completed with the member's output as result.
 * Aggregators (blockedBy non-empty), depth/width-capped tasks, and no-tag
 * responses are always leaves — preventing infinite recursion/oscillation.
 * The tail reuses delegate's task-pool termination engine.
 */
export async function handleRecurseIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "recurse") return

    // Inspect the member's claimed/in-progress task and finalize it.
    const tasks = await listAllTasks(team.directory)
    const T = tasks.find(
        t => t.owner === member.name && (t.status === "claimed" || t.status === "in_progress"),
    )
    if (T) {
        const output = task.responses[member.name] ?? ""
        const depth = T.depth ?? 0
        const dec = parseDecompose(output)
        const maxDepth = task.maxDepth ?? 3
        const maxSubtasks = task.maxSubtasks ?? 5
        const canDecompose =
            !dec.parseFailed
            && dec.subtasks.length > 0
            && depth < maxDepth
            && T.blockedBy.length === 0
            && dec.subtasks.length <= maxSubtasks
            && tasks.length + dec.subtasks.length <= team.bounds.maxTasks
        if (canDecompose) {
            // Branch: create subtasks (depth+1), re-queue T as their aggregator.
            const ids: string[] = []
            for (const s of dec.subtasks) {
                const child = await createTask(team.directory, {
                    subject: s.subject,
                    description: s.description,
                    depth: depth + 1,
                })
                ids.push(child.id)
            }
            await updateTask(team.directory, T.id, {
                status: "pending",
                owner: undefined,
                blockedBy: ids,
            })
            recordEvent(team, {
                timestamp: Date.now(),
                kind: "decomposed",
                member: member.name,
                detail: `${T.subject} -> ${ids.length} @d${depth + 1}`,
            })
        } else {
            // Leaf (or capped/aggregator): finalize with the member's output,
            // or a placeholder when the member produced nothing (so an aggregating
            // parent reads a recognizable sub-result, not an empty string).
            const result = output.length > 0 ? output : "(no output provided)"
            await updateTask(team.directory, T.id, { status: "completed", result })
        }
    }

    // Shared delegate-style tail: all-complete / deadlock / re-prompt.
    await runDelegateStyleTail(ctx, team, member, "recurse", () => buildRecursePrompt())
}

/**
 * Recurse handler -- hierarchical recursive decomposition. Builds on delegate's
 * task-pool termination engine (runDelegateStyleTail, imported from delegate.ts).
 * When a member idles, the orchestrator inspects that member's claimed task and
 * either branches (splits into subtasks, re-queues parent as aggregator) or
 * finalizes it as a leaf.
 */

import type { PluginContext } from "../core/context.js"
import { type Team } from "../state/store.js"
import type { MemberState } from "../core/types.js"
import { createTask, listAllTasks, updateTask } from "../state/tasks.js"
import { recordEvent } from "./events.js"
import { parseDecompose } from "./decisions.js"
import { runDelegateStyleTail } from "./delegate.js"

/**
 * Build the recursive-decomposition contract prompt: claim a task, then either
 * solve it directly or emit a <decompose> block; aggregate completed sub-tasks
 * instead of re-decomposing. Members must NOT call team_task_update completed --
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
 *   • branch -- splits it into subtasks (depth+1) and re-queues the task as a
 *     pending aggregator blocked by those subtasks (re-claim aggregation); or
 *   • leaf -- finalizes the task as completed with the member's output as result.
 * Aggregators (blockedBy non-empty), depth/width-capped tasks, and no-tag
 * responses are always leaves -- preventing infinite recursion/oscillation.
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
    } else if (member.name === task.decomposerMember && task.rootTaskId) {
        // Aggregation fallback: after decomposing, the root task is re-queued
        // as pending/unowned/blockedBy. Once all subtasks complete it becomes
        // claimable and runDelegateStyleTail re-prompts the decomposer. But
        // the decomposer typically emits the aggregation report WITHOUT
        // re-claiming the root (the prompt says "the orchestrator finalizes
        // on idle"), so the T-lookup above stays empty and the root never
        // flips to completed -> indefinite re-prompt loop. When the
        // decomposer idles holding no task but the root is pending with all
        // blockers completed and the decomposer produced non-empty output,
        // finalize the root here with that output. This is safe: the root
        // is the single aggregation point, and updateTask's expectedStatus
        // guard prevents a double-finalize if two events race.
        const root = tasks.find(t => t.id === task.rootTaskId)
        const output = task.responses[member.name] ?? ""
        if (
            root
            && root.status === "pending"
            && root.blockedBy.length > 0
            && root.blockedBy.every(id => tasks.find(x => x.id === id)?.status === "completed")
            && output.length > 0
        ) {
            await updateTask(team.directory, root.id, { status: "completed", result: output })
            recordEvent(team, {
                timestamp: Date.now(),
                kind: "aggregated",
                member: member.name,
                detail: root.subject.slice(0, 60),
            })
        }
    }

    // Shared delegate-style tail: all-complete / deadlock / re-prompt.
    await runDelegateStyleTail(ctx, team, member, "recurse", () => buildRecursePrompt())
}

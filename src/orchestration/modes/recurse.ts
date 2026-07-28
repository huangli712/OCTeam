/**
 * Recurse handler -- hierarchical recursive decomposition. Builds on delegate's
 * task-pool termination engine (runDelegateStyleTail, imported from delegate.ts).
 * When a member idles, the orchestrator inspects that member's claimed task and
 * either branches (splits into subtasks, re-queues parent as aggregator) or
 * finalizes it as a leaf.
 *
 * STATE MACHINE:
 *   decompose → subtask_dispatch → [branch | finalize_leaf] → aggregate → [root_complete | stalled]
 *   - Decomposer decomposes → create subtasks, re-queue parent as aggregator
 *   - Decomposer finalizes → mark leaf complete (no children)
 *   - Root task completed → deliver (idle: recurse_root_complete)
 *   - Aggregation stalled (dispatch cap exceeded) → deliver (failed: recurse_aggregation_stalled)
 */

import type { PluginContext } from "../../core/context.js"
import { type Team, saveTeamState } from "../../state/store.js"
import type { ApprovalRequest, MemberState } from "../../core/types.js"
import { createTask, getTask, listAllTasks, updateTask } from "../../state/tasks.js"
import { recordEvent } from "../records/events.js"
import { parseDecompose } from "../protocol/decisions.js"
import { runDelegateStyleTail, NOTIFY_COOLDOWN_MS } from "./delegate.js"
import { DEFAULT_RECURSE_DEPTH, DEFAULT_RECURSE_SUBTASKS } from "./defaults.js"
import { finishRun } from "../control/completion.js"
import { dispatchToMember } from "../control/dispatch.js"
import { logSwallowed } from "../../core/log.js"
import { maybeRequestApproval } from "../control/approval.js"
import { findMember } from "../../tools/support.js"

/** Cap on root re-dispatch attempts before declaring the run stalled. */
const MAX_AGGREGATION_DISPATCHES = 3

/**
 * Build the recursive-decomposition contract prompt: claim a task, then either
 * solve it directly or emit a <decompose> block; aggregate completed sub-tasks
 * instead of re-decomposing. Members must NOT call team_task_update completed --
 * the orchestrator finalizes their task on idle (eliminates finalize races).
 */
export function buildRecursePrompt(): string {
    return (
        `[Recursive task]\n`
        + `You MUST claim a task FIRST (team_task_update status="claimed"), then read it (team_task_get).\n`
        + `Until you claim a task, any <decompose> block you emit is IGNORED — the orchestrator\n`
        + `only inspects output from members who currently hold a claimed/in_progress task.\n`
        + `Then EITHER:\n`
        + ` • Solve it directly — produce the full result as your final message; OR\n`
        + ` • If too large to solve in one step, emit exactly one:\n`
        + `   <decompose>{"subtasks":[{"subject":"...","description":"..."}]}</decompose>  (Chinese <分解> accepted)\n`
        + `If the task you claimed has completed sub-tasks (shown under "Blocked by"), DO NOT decompose —\n`
        + `read each sub-task's result via team_task_get and synthesize them into this task's result.\n\n`
        + `NEVER call team_task_create — subtasks come ONLY from your <decompose> block, which the\n`
        + `orchestrator parses and creates automatically. Manual team_task_create produces duplicate\n`
        + `tasks, wastes tokens, and is rejected at the tool layer.\n\n`
        + `Do NOT call team_task_update completed — the orchestrator finalizes your task when you go idle.`
    )
}

/**
 * Aggregation-phase dispatch prompt for the decomposer. Stronger than the
 * generic buildRecursePrompt(): names the completed sub-tasks, forbids
 * waiting on teammate messages or re-decomposing, and prescribes the exact
 * claim-root -> read -> synthesize -> idle sequence. Output FORMAT (markers
 * like D4_FINAL) stays scene-defined — this prompt reinforces BEHAVIOR only.
 */
function buildAggregationPrompt(rootSubject: string, childCount: number): string {
    return (
        `[Aggregation Phase]\n` 
        + `All ${childCount} sub-tasks of the root task "${rootSubject}" are now COMPLETED.\n`
        + `Your next action (no alternatives):\n`
        + `  1. team_task_update(status="claimed") on the ROOT task to acquire it.\n`
        + `  2. team_task_get each sub-task to read its result.\n`
        + `  3. Synthesize the sub-task results into the final answer.\n`
        + `  4. Then idle.\n`
        + `The sub-task results are FINAL — do NOT request more information from\n`
        + `teammates via team_send_message. Do NOT re-decompose.\n`
        + `Claim root → read results → synthesize → idle.`
    )
}

/** Resolve the member by name and re-enter the delegate-style tail (used after HITL approval/rejection). */
async function runRecurseTailFromApproval(ctx: PluginContext, team: Team, memberName: string | undefined): Promise<void> {
    const member = team.members.find(m => m.name === memberName)
    if (!member) return
    await runDelegateStyleTail(ctx, team, member, "recurse", () => buildRecursePrompt())
}

/** Approve a recurse decomposition: create the proposed subtasks and re-queue the parent as an aggregator. */
export async function approveRecurseDecompose(
    ctx: PluginContext,
    team: Team,
    request: ApprovalRequest,
): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "recurse" || !request.taskId || !request.subtasks) return
    const parent = await getTask(team.directory, request.taskId)
    if (!parent) return
    const childDepth = (parent.depth ?? 0) + 1
    const ids: string[] = []
    // M-9: wrap child creation + parent blockedBy update in a transactional
    // try/catch. Pre-fix code only cleaned up orphaned children on create
    // failure (line 106-113) but NOT on parent update failure (line 115).
    // If updateTask(parent, blockedBy) threw, the children existed as
    // claimable tasks but the parent was never linked — delegate mode would
    // pick them up and they'd be aggregated into nothing, consuming tokens.
    let parentUpdated = false
    try {
        for (const subtask of request.subtasks) {
            const child = await createTask(team.directory, {
                subject: subtask.subject,
                description: subtask.description,
                depth: childDepth,
            })
            ids.push(child.id)
        }
        await updateTask(team.directory, parent.id, {
            status: "pending",
            owner: undefined,
            blockedBy: ids,
        })
        parentUpdated = true
    } catch (err) {
        // M-9: clean up ALL created children regardless of which step failed.
        // Pre-fix only cleaned on create failure; parent-update failure left
        // orphans. Also log the cleanup so operators can diagnose.
        for (const id of ids) {
            await updateTask(team.directory, id, { status: "deleted" }).catch(cleanupErr => {
                logSwallowed(ctx, "recurse decompose: failed to delete orphaned child task", cleanupErr, { taskId: id })
            })
        }
        throw err
    }
    if (!parentUpdated) return // TS narrowing — parentUpdated is always true here
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "decomposed",
        member: request.member,
        detail: `${parent.subject} -> ${ids.length} @d${childDepth}`,
    })
    await runRecurseTailFromApproval(ctx, team, request.member)
}

/** Reject a recurse decomposition: finalize the parent task as completed and re-dispatch the member. */
export async function rejectRecurseDecompose(
    ctx: PluginContext,
    team: Team,
    request: ApprovalRequest,
): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "recurse" || !request.taskId) return
    const parent = await getTask(team.directory, request.taskId)
    if (!parent) return
    if (parent.id === task.rootTaskId) {
        task.aggregationDispatchCount = 0
    }
    const output = request.member ? (task.responses[request.member] ?? "") : ""
    const result = output.length > 0 ? output : "(no output provided)"
    await updateTask(team.directory, parent.id, { status: "completed", result })
    await runRecurseTailFromApproval(ctx, team, request.member)
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
    // H-27: an errored member must NOT have its claimed task finalized as
    // completed. Pre-fix code processed the errored member's stale output
    // as if it were a legitimate result, marking the task done even though
    // the member crashed/errored mid-work. Release the task back to pending
    // so another member can pick it up.
    if (T && member.status === "errored") {
        await updateTask(team.directory, T.id, {
            status: "pending",
            owner: undefined,
            claimedAt: undefined,
        })
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "errored",
            member: member.name,
            detail: `recurse: released claimed task ${T.id} from errored member`,
        })
        return
    }
    if (T) {
        const output = task.responses[member.name] ?? ""
        const depth = T.depth ?? 0
        const dec = parseDecompose(output)
        const maxDepth = task.maxDepth ?? DEFAULT_RECURSE_DEPTH
        const maxSubtasks = task.maxSubtasks ?? DEFAULT_RECURSE_SUBTASKS
        const canDecompose =
            !dec.parseFailed
            && dec.subtasks.length > 0
            && depth < maxDepth
            && T.blockedBy.length === 0
            && dec.subtasks.length <= maxSubtasks
            && tasks.filter(t => t.status !== "deleted").length + dec.subtasks.length <= team.bounds.maxTasks
        if (canDecompose) {
            if (await maybeRequestApproval(ctx, team, {
                kind: "recurse_decompose",
                summary: `Member ${member.name} proposed decomposing task "${T.subject}" into ${dec.subtasks.length} subtasks.`,
                taskId: T.id,
                member: member.name,
                subtasks: dec.subtasks,
            })) {
                return
            }
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
        } else if (dec.parseFailed) {
            // H46: a malformed <decompose> block is NOT a leaf — the member
            // explicitly tried to decompose but formatted it wrong. Marking
            // the task completed with the raw output would be a false success.
            // Re-dispatch the member with feedback so it can retry.
            const member2 = findMember(team, member.name)
            if (member2?.sessionId) {
                await dispatchToMember(
                    ctx, member2,
                    `[Decompose parse failed — your <decompose> block was malformed.\n`
                    + `Either solve the task directly (no tag), or emit a valid:\n`
                    + `<decompose>{"subtasks":[{"subject":"...","description":"..."}]}</decompose>\n\n[Your task]\n${T.subject}`,
                    member2.worktreePath ?? ctx.directory, team,
                )
                await saveTeamState(team)
            }
            recordEvent(team, {
                timestamp: Date.now(),
                kind: "errored",
                member: member.name,
                detail: `recurse: malformed <decompose> on task ${T.id}, re-dispatched`,
            })
        } else {
            // Leaf (or capped/aggregator): finalize with the member's output,
            // or a placeholder when the member produced nothing (so an aggregating
            // parent reads a recognizable sub-result, not an empty string).
            // Reset aggregation stall counter when the decomposer claims and
            // finalizes the ROOT — the decomposer is doing its job.
            if (T.id === task.rootTaskId) {
                task.aggregationDispatchCount = 0
            }
            const result = output.length > 0 ? output : "(no output provided)"
            await updateTask(team.directory, T.id, { status: "completed", result })
        }
    }

    // Recurse-specific: when the root becomes aggregation-ready (all sub-tasks
    // completed), dispatch the DECOMPOSER with the aggregation prompt. Covers
    // two cases:
    //   1. A non-decomposer member just idled (woke the decomposer).
    //   2. The decomposer itself idled WITHOUT claiming the root (T was
    //      undefined above — protocol slip; re-dispatch with a stronger
    //      aggregation instruction).
    if (task.rootTaskId && task.decomposerMember) {
        const root = tasks.find(t => t.id === task.rootTaskId)
        if (
            root
            && root.status === "pending"
            && root.blockedBy.length > 0
            && root.blockedBy.every(id => tasks.find(x => x.id === id)?.status === "completed")
        ) {
            // Only dispatch if the decomposer did not just claim the root. If
            // T exists and T.id === rootTaskId, the decomposer is mid-
            // aggregation and the leaf branch above finalizes on its next
            // idle — do not interrupt with another dispatch.
            const decomposerIdleWithoutRoot = !T || T.id !== task.rootTaskId
            const decomposer = team.members.find(m => m.name === task.decomposerMember)
            if (
                decomposer
                && decomposer.status === "idle"
                && decomposer.sessionId
                && decomposerIdleWithoutRoot
            ) {
                const now = Date.now()
                if (
                    !decomposer.lastNotifiedAt
                    || now - decomposer.lastNotifiedAt >= NOTIFY_COOLDOWN_MS
                ) {
                    // Stall detection: count only ACTUAL dispatches (not every
                    // idle event — cooldown-filtered idles would otherwise
                    // exhaust the cap without dispatching). Each dispatch that
                    // fails to produce a root claim increments the counter;
                    // once it exceeds the cap the run fails fast instead of
                    // looping to wall-clock. Reset to 0 when the decomposer
                    // claims the root (see leaf branch above).
                    task.aggregationDispatchCount = (task.aggregationDispatchCount ?? 0) + 1
                    // H42: allow task-level override of the aggregation stall threshold.
                    const maxDispatches = task.maxAggregationDispatches ?? MAX_AGGREGATION_DISPATCHES
                    if (task.aggregationDispatchCount > maxDispatches) {
                        recordEvent(team, {
                            timestamp: Date.now(),
                            kind: "aggregation_stalled",
                            member: task.decomposerMember,
                            detail: `root still pending after ${maxDispatches} aggregation dispatches`,
                        })
                        await finishRun(ctx, team, "recurse_aggregation_stalled", "failed")
                        return
                    }
                    decomposer.lastNotifiedAt = now
                    await dispatchToMember(
                        ctx,
                        decomposer,
                        buildAggregationPrompt(root.subject, root.blockedBy.length),
                        decomposer.worktreePath ?? ctx.directory,
                        team,
                    )
                    return
                }
            }
        }
    }

    // Shared delegate-style tail: all-complete / deadlock / re-prompt.
    await runDelegateStyleTail(ctx, team, member, "recurse", () => buildRecursePrompt())
}

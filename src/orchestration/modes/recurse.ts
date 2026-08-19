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
/** Retry cap for a task that keeps re-emitting <decompose> after being forced to solve directly. */
const MAX_FORCED_DIRECT_DECOMPOSE_RETRIES = 3

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

/** Prompt for a member whose decomposition was refused (or re-emitted after
 * forcing): solve the task directly and do not emit another <decompose> block. */
function buildDirectSolvePrompt(subject: string): string {
    return (
        `[Direct solve required]\n`
        + `The proposed decomposition cannot be used. Solve this task directly and do not emit another <decompose> block.\n\n`
        + `[Your task]\n${subject}`
    )
}

/**
 * Aggregation-phase dispatch prompt for the decomposer. Stronger than the
 * generic buildRecursePrompt(): states the completed sub-task count, forbids
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
    // Treat child creation and parent linkage as one transaction. If either
    // step fails, delete every created child so no unlinked claimable work
    // remains.
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
    } catch (err) {
        // Clean up all created children regardless of which transactional step
        // failed, and log cleanup failures for diagnosis.
        for (const id of ids) {
            await updateTask(team.directory, id, { status: "deleted" }).catch(cleanupErr => {
                logSwallowed(ctx, "recurse decompose: failed to delete orphaned child task", cleanupErr, { taskId: id })
            })
        }
        throw err
    }
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "decomposed",
        member: request.member,
        detail: `${parent.subject} -> ${ids.length} @d${childDepth}`,
    })
    await runRecurseTailFromApproval(ctx, team, request.member)
}

/** Reject a recurse decomposition and re-dispatch the member to solve the task directly. */
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
    if (!task.forcedDirectTaskIds?.includes(parent.id)) {
        task.forcedDirectTaskIds = [...(task.forcedDirectTaskIds ?? []), parent.id]
    }
    const member = findMember(team, request.member ?? "")
    if (member?.sessionId) {
        delete task.responses[member.name]
        await dispatchToMember(
            ctx,
            member,
            buildDirectSolvePrompt(parent.subject),
            member.worktreePath ?? ctx.directory,
            team,
        )
    }
    await saveTeamState(team)
}

/**
 * Hierarchical recursive decomposition (recurse mode). When a member idles,
 * the orchestrator inspects that member's claimed task and either:
 *   • branch -- splits it into subtasks (depth+1) and re-queues the task as a
 *     pending aggregator blocked by those subtasks (re-claim aggregation); or
 *   • leaf -- finalizes the task as completed with the member's output as result.
 * Aggregators (blockedBy non-empty), depth/width-capped tasks, and no-tag
 * responses never branch — they are finalized as leaves directly, or (when
 * they still emit a <decompose> block) forced into a direct solve —
 * preventing infinite recursion/oscillation.
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
    // An errored member must not have its claimed task finalized from stale
    // output. Release the task to pending so another member can complete it.
    if (T && member.status === "errored") {
        await updateTask(team.directory, T.id, {
            status: "pending",
            owner: undefined,
            claimedAt: undefined,
        }, {
            // Use the actual status rather than assuming "claimed".
            expectedOwner: member.name,
            expectedStatus: T.status as "claimed" | "in_progress",
        })
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "errored",
            member: member.name,
            detail: `recurse: released claimed task ${T.id} from errored member`,
        })
        // Fall through to runDelegateStyleTail so idle members are dispatched
        // toward the newly claimable task instead of leaving it stranded.
    } else if (T) {
        const output = task.responses[member.name] ?? ""
        const depth = T.depth ?? 0
        const dec = parseDecompose(output)
        // Reset the parse-failure counter on any successful parse so failures
        // are consecutive rather than accumulated across unrelated tasks.
        if (!dec.parseFailed) {
            task.decomposeParseFailures = 0
        }
        const maxDepth = task.maxDepth ?? DEFAULT_RECURSE_DEPTH
        const maxSubtasks = task.maxSubtasks ?? DEFAULT_RECURSE_SUBTASKS
        const forcedDirect = task.forcedDirectTaskIds?.includes(T.id) ?? false
        const canDecompose =
            !forcedDirect
            && !dec.parseFailed
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
                delete task.responses[member.name]
                await saveTeamState(team)
                return
            }
            // Branch: create subtasks (depth+1), re-queue T as their aggregator.
            // Roll back already-created children if creation or parent linkage
            // fails so no claimable child is left without a parent.
            const ids: string[] = []
            try {
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
                delete task.responses[member.name]
            } catch (createErr) {
                // Mark rolled-back children deleted through updateTask, which
                // uses atomicWrite with symlink traversal protection. Deleted
                // tasks remain visible to the stale-claim reaper but cannot be
                // claimed.
                const { updateTask } = await import("../../state/tasks.js")
                for (const id of ids) {
                    try {
                        await updateTask(team.directory, id, { status: "deleted" })
                    } catch (rollbackErr: unknown) {
                        // Log rollback failure so orphaned tasks are observable.
                        // The stale-claim reaper will eventually clean them.
                        logSwallowed(
                            ctx,
                            "recurse rollback delete child task",
                            rollbackErr,
                            { taskId: id },
                        )
                    }
                }
                throw createErr
            }
            recordEvent(team, {
                timestamp: Date.now(),
                kind: "decomposed",
                member: member.name,
                detail: `${T.subject} -> ${ids.length} @d${depth + 1}`,
            })
            // Reset the parse-failure counter after successful decomposition so
            // unrelated malformed responses do not accumulate across the run.
            task.decomposeParseFailures = 0
        } else if (dec.subtasks.length > 0 && !dec.parseFailed) {
            if (forcedDirect) {
                const attempts = (task.forcedDirectDecomposeAttempts?.[T.id] ?? 0) + 1
                task.forcedDirectDecomposeAttempts = {
                    ...(task.forcedDirectDecomposeAttempts ?? {}),
                    [T.id]: attempts,
                }
                if (attempts > MAX_FORCED_DIRECT_DECOMPOSE_RETRIES) {
                    await finishRun(ctx, team, `recurse_forced_direct_decompose_failed:${attempts}_attempts`, "failed")
                    return
                }
            } else {
                task.forcedDirectTaskIds = [...(task.forcedDirectTaskIds ?? []), T.id]
            }
            delete task.responses[member.name]
            await dispatchToMember(
                ctx,
                member,
                buildDirectSolvePrompt(T.subject),
                member.worktreePath ?? ctx.directory,
                team,
            )
            await saveTeamState(team)
            return
        } else if (dec.parseFailed) {
            // A malformed <decompose> block is not a leaf: the member attempted
            // decomposition but formatted it incorrectly. Track a dedicated
            // parse-failure counter so continuous errors cannot consume
            // unlimited tokens.
            task.decomposeParseFailures = (task.decomposeParseFailures ?? 0) + 1
            const maxParseFailures = task.maxDecomposeParseFailures ?? 3
            // Use >= so "max 3" means exactly three failures, not four.
            if (task.decomposeParseFailures >= maxParseFailures) {
                await finishRun(ctx, team, `recurse_decompose_parse_failed:${task.decomposeParseFailures}_attempts`, "failed")
                return
            }
            delete task.responses[member.name]
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
            // Leaf: finalize with the member's output. An empty output is not
            // finalized — the member is re-dispatched for a direct solve instead.
            // Reset aggregation stall counter when the decomposer claims and
            // finalizes the ROOT — the decomposer is doing its job.
            if (T.id === task.rootTaskId) {
                task.aggregationDispatchCount = 0
            }
            // Empty output must not complete the task; retry the member so the
            // root cannot finish without an actual result.
            if (output.length === 0) {
                // Don't complete — re-dispatch the member for a direct solve.
                const owner = team.members.find(m => m.name === member.name)
                if (owner?.sessionId && owner.status !== "running") {
                    // Include the full description so the member receives the
                    // task requirements rather than only its subject.
                    const prompt = T.description ? `${T.subject}\n\n${T.description}` : T.subject
                    await dispatchToMember(ctx, owner, prompt, owner.worktreePath ?? ctx.directory, team)
                }
                return
            }
            const result = output
            await updateTask(team.directory, T.id, { status: "completed", result }, {
                // Guard the update with compare-and-swap ownership.
                expectedOwner: member.name,
            })
            delete task.responses[member.name]
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
        // Re-read tasks after the leaf completion above so the
        // root-ready check sees the updated child statuses.
        const freshTasks = await listAllTasks(team.directory)
        const root = freshTasks.find(t => t.id === task.rootTaskId)
        if (
            root
            && root.status === "pending"
            && root.blockedBy.length > 0
            && root.blockedBy.every(id => freshTasks.find(x => x.id === id)?.status === "completed")
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
                    // Allow a task-level override of the aggregation stall threshold.
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
                    // Clear the stale response before re-dispatch so the next
                    // idle handler doesn't re-read the old aggregation output.
                    delete task.responses[decomposer.name]
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
    // Before entering the tail, verify the root task still exists. If root
    // is deleted/missing, the delegate tail's incomplete.length === 0 check
    // would falsely succeed.
    if (task.rootTaskId) {
        const rootTask = await getTask(team.directory, task.rootTaskId)
        if (!rootTask || rootTask.status === "deleted") {
            await finishRun(ctx, team, "recurse_failed:root_task_missing", "failed")
            return
        }
        if (rootTask.status === "completed") {
            // Emit the aggregated event when the root task completes.
            await recordEvent(team, { timestamp: Date.now(), kind: "aggregated", member: member.name })
        }
    }
    await runDelegateStyleTail(ctx, team, member, "recurse", () => buildRecursePrompt())
}

/**
 * Delegate handler. Drives a shared task pool: members claim tasks, work them,
 * and idle. runDelegateStyleTail owns the termination engine -- all-complete
 * delivers; ALL members idle with NO claimable tasks fails as deadlock;
 * otherwise idle members are RATE-LIMITED re-prompted toward remaining
 * claimable tasks (the whole idle pool is a candidate, the just-idled member
 * first).
 * Recurse (recurse.ts) reuses this tail.
 *
 * STATE MACHINE:
 *   member_dispatch → task_claim → work → idle → [claim_more | rate_limited | deadlock | all_complete]
 *   - All tasks completed → deliver (idle: delegate_complete)
 *   - All idle, no claimable tasks (deadlock) → deliver (failed: delegate_deadlock)
 *   - Member idle with claimable tasks → rate-limited re-prompt toward next task
 */

import type { PluginContext } from "../../core/context.js"
import { type Team } from "../../state/store.js"
import type { MemberState, Task } from "../../core/types.js"
import { listAllTasks, TaskOwnershipError, TaskStatusError, updateTask } from "../../state/tasks.js"
import { dispatchToMember } from "../control/dispatch.js"
import { extractSessionStatusEntry, asSdkMessages } from "../protocol/output.js"
import { finishRun } from "../control/completion.js"
import { maybeTriggerSignoff } from "../control/signoff.js"
import { captureMemberOutput } from "../records/capture.js"
import { recordEvent } from "../records/events.js"
import { logSwallowed } from "../../core/log.js"

/** Default cooldown (ms) between re-prompt notifications in delegate/recurse.
 *  Bypassed when every idle member is still cooling: the earliest-notified
 *  member is re-prompted immediately so the pool cannot stall on cooldowns. */
export const NOTIFY_COOLDOWN_MS = 10_000

/**
 * Shared delegate-style termination tail: scan the task list, deliver on
 * all-complete, fail on deadlock, else rate-limit re-prompt the idling member
 * toward claimable tasks. Used by both delegate (label "delegate") and recurse
 * (label "recurse"); the reason prefix and re-prompt text differ by caller.
 */
export async function runDelegateStyleTail(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
    label: string,
    buildReprompt: (claimable: Task[]) => string,
): Promise<void> {
    const tasks = await listAllTasks(team.directory)
    const incomplete = tasks.filter(t => t.status !== "completed" && t.status !== "deleted")

    if (incomplete.length === 0) {
        // Do not finalize while a non-master member is still running. Its idle
        // event will re-drive this tail after in-flight output is available,
        // preventing completion from racing signoff.
        const stillRunning = team.members.some(
            m => !m.isMaster && m.sessionId && m.status === "running",
        )
        if (stillRunning) return

        // Before clearing the active task (or entering signoff), capture any
        // member whose turn output hasn't been persisted yet. Delegate/recurse
        // members run concurrently; when the completing member idles and
        // triggers this branch, others may still be running or have idled
        // without their captureMemberOutput firing (their subsequent idle
        // would hit a cleared activeTask and skip). MUST run before
        // maybeTriggerSignoff: a reviewer's primary task output (e.g. a coder
        // who is also the configured decider) would otherwise never be
        // captured, and once signoff dispatches the reviewer their prior turn's
        // task output is superseded in task.responses (overwrite, not append).
        // Idempotent: already-captured members yield empty outputs and return early.
        for (const m of team.members) {
            if (m.isMaster || !m.sessionId) continue
            // Skip already-errored members — they're terminal, no need to
            // re-check the status API.
            if (m.status === "errored") continue
            // Verify the member's session is not still working before treating
            // it as complete. A member whose cached status is "idle" but whose
            // session is actually mid-turn (retry/busy/running) would otherwise
            // pass the incomplete.length === 0 check and finish the run
            // prematurely.
            try {
                const st = await ctx.client.session.status({})
                // Use extractSessionStatusEntry so the SDK status payload is
                // narrowed safely instead of cast at the call site; a shape
                // mismatch yields undefined.
                const entry = extractSessionStatusEntry(st.data, m.sessionId)
                // Any non-idle live status means the member is still working and
                // prevents delegate completion while its turn remains in flight.
                if (entry?.type === "retry" || entry?.type === "busy" || entry?.type === "running") {
                    return
                }
            } catch {
                // Status API unavailable — fall through to cached-state check.
            }
            // Log capture failures so operators can distinguish missing member
            // output from session-message or persistent I/O failures.
            try {
                const res = await ctx.client.session.messages({ path: { id: m.sessionId } })
                const msgs = asSdkMessages(res.data)
                await captureMemberOutput(team, m, msgs)
            } catch (err) {
                logSwallowed(ctx, "delegate tail: captureMemberOutput failed", err, { member: m.name })
            }
        }
        if (await maybeTriggerSignoff(ctx, team)) {
            return  // signoff in progress or run terminated
        }
        await finishRun(ctx, team, `${label}_complete`, "idle")
        return
    }

    // Reset errored members' claimed or in-progress tasks to pending
    // BEFORE the claimable filter. Without this, an errored member's task
    // stays at "claimed"/"in_progress" — excluded from claimable — so the
    // deadlock check sees claimable.length === 0 AND all members
    // idle/errored → false deadlock. This matches the recurse handler.
    let erroredResetHappened = false
    for (const m of team.members) {
        if (m.status !== "errored" || !m.sessionId) continue
        const erroredTask = incomplete.find(
            t => (t.status === "claimed" || t.status === "in_progress") && t.owner === m.name,
        )
        if (erroredTask) {
            try {
                // Pass expectedOwner and expectedStatus so a concurrent reaper
                // reset and re-claim cannot be clobbered by a slow release.
                await updateTask(team.directory, erroredTask.id, {
                    status: "pending",
                    owner: undefined,
                    claimedAt: undefined,
                }, {
                    expectedOwner: m.name,
                    expectedStatus: erroredTask.status as "claimed" | "in_progress",
                })
                recordEvent(team, {
                    timestamp: Date.now(),
                    kind: "errored",
                    member: m.name,
                    detail: `${label}: released ${erroredTask.status} task ${erroredTask.id} from errored member`,
                })
                erroredResetHappened = true
            } catch (err: unknown) {
                // Task transitioned out between our read and update — do NOT clobber.
                if (!(err instanceof TaskOwnershipError) && !(err instanceof TaskStatusError)) throw err
            }
        }
    }
    // Re-read tasks after the reset so claimable reflects the updated statuses.
    const tasksForClaimable = erroredResetHappened
        ? await listAllTasks(team.directory)
        : tasks
    const incompleteForClaimable = erroredResetHappened
        ? tasksForClaimable.filter(t => t.status !== "completed" && t.status !== "deleted")
        : incomplete

    // Claimable tasks: pending AND all blockers completed or deleted.
    // claimTask treats deleted blockers as resolved (tasks.ts blockersAreResolved);
    // the tail must match, or a pending task whose only blocker was deleted
    // is forever unclaimable → false deadlock.
    const claimable = incompleteForClaimable.filter(
        t =>
            t.status === "pending"
            && t.blockedBy.every(id => {
                const blocker = tasksForClaimable.find(x => x.id === id)
                return blocker?.status === "completed" || blocker?.status === "deleted"
            }),
    )

    // Deadlock: no claimable tasks and all members idle.
    // errored counts as terminal (like idle) so an errored member cannot wedge
    // the deadlock check -- its claimed tasks are reaped by the sweep and a
    // survivor reclaims them.
    if (claimable.length === 0) {
        // Before declaring deadlock, check whether a member holds a claimed or
        // in-progress task. Such a member may have output awaiting finalization
        // or may have been woken by a wake hint, so re-prompt its owner.
        const membersWithTasks = incompleteForClaimable.filter(
            t => (t.status === "claimed" || t.status === "in_progress") && t.owner,
        )
        if (membersWithTasks.length > 0) {
            // Re-dispatch owners of claimed/in_progress tasks instead of
            // declaring deadlock. The task is still in flight.
            for (const t of membersWithTasks) {
                const owner = team.members.find(m => m.name === t.owner)
                if (owner?.sessionId && owner.status !== "running") {
                    await dispatchToMember(ctx, owner, t.subject, owner.worktreePath ?? ctx.directory, team)
                }
            }
            return
        }
        // Fast path: use cached member.status.
        const prelimAllIdle = team.members.every(
            m => m.status === "idle" || m.status === "errored" || !m.sessionId,
        )
        if (prelimAllIdle) {
            // Cross-check against the live OpenCode session status. A member
            // woken by a wake-hint (promptAsync) flips its OpenCode session to
            // running without going through dispatchToMember, so its
            // member.status may lag at "idle". Without this cross-check the
            // deadlock verdict fires while the session is actually working.
            const status = await ctx.client.session.status({})
            const trulyAllIdle = team.members.every(m => {
                if (!m.sessionId) return true
                const entry = extractSessionStatusEntry(status.data, m.sessionId)
                // A member is truly idle only when its SDK session reports
                // "idle" (or the entry is missing). The SDK SessionStatus type
                // has no "running" variant — an actively-working session
                // reports "busy", and a retrying one reports "retry". Both must
                // count as non-idle here, otherwise the deadlock check
                // false-positives while members woken via wake-hint are busy.
                return !entry || entry.type === "idle"
            })
            if (trulyAllIdle) {
                await finishRun(ctx, team, `${label}_deadlock`, "failed")
                return
            }
            // A member is actually running (wake-hint path) — wait for it.
            return
        }
        return // some members still running, wait
    }

    // Dispatch idle members toward claimable tasks -- RATE-LIMITED per member
    // to avoid claim-race busy-loop. The current idling member is dispatched
    // first, then any OTHER idle members are dispatched until enough are
    // heading for the available tasks (claimable <= running). Without this
    // extra pass, only the member that just idled gets re-prompted while
    // other idle members (e.g. woken earlier by wake-hint, found no tasks,
    // went back to idle) never get a second chance to claim tasks created
    // later in the same run.
    const now = Date.now()
    const allIdle = team.members.filter(
        m => !m.isMaster && m.sessionId && m.status === "idle",
    )
    const eligible = allIdle.filter(
        m => !m.lastNotifiedAt || now - m.lastNotifiedAt >= NOTIFY_COOLDOWN_MS,
    )
    // When every idle member is in cooldown, claimable tasks would be
    // permanently stranded — no event re-invokes this handler after cooldown
    // expires (all members are already idle, no new idle event fires). In
    // that case, bypass the cooldown filter and dispatch the member notified
    // longest ago (its cooldown is closest to expiry). This is rare (requires
    // all members notified within the cooldown window), so the rate-limiting
    // purpose of the cooldown is preserved in the common case.
    let dispatchPool = eligible
    if (eligible.length === 0 && allIdle.length > 0) {
        dispatchPool = allIdle
        // Dispatch the member notified longest ago (closest to cooldown expiry).
        dispatchPool.sort((a, b) => (a.lastNotifiedAt ?? 0) - (b.lastNotifiedAt ?? 0))
    } else {
        // Normal: sort so the current member is first (it just produced
        // output / has the freshest context), then the rest.
        dispatchPool.sort((a, b) => (a.name === member.name ? -1 : b.name === member.name ? 1 : 0))
    }
    for (const m of dispatchPool) {
        const curRunning = team.members.filter(mm => mm.status === "running" && !mm.isMaster).length
        if (claimable.length <= curRunning) break // enough dispatched
        m.lastNotifiedAt = now
        await dispatchToMember(ctx, m, buildReprompt(claimable), m.worktreePath ?? ctx.directory, team)
    }
}

/** Delegate idle handler: runs the delegate-style tail with "delegate" label. */
export async function handleDelegateIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    await runDelegateStyleTail(ctx, team, member, "delegate", tasks =>
        `[Team Orchestrator]\n` 
        + `You have completed your task. ${tasks.length} task(s) available. `
        + `Use team_task_list to check, team_task_update to claim, execute, then team_send_message `
        + `to report to master. Repeat until no tasks remain.`)
}

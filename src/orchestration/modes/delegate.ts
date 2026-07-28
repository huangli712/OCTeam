/**
 * Delegate handler. Drives a shared task pool: members claim tasks, work them,
 * and idle. runDelegateStyleTail owns the termination engine -- all-complete
 * delivers, all-idle-with-claimable fails as deadlock, otherwise the just-idled
 * member is RATE-LIMITED re-prompted toward remaining claimable tasks.
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
import type { MemberState } from "../../core/types.js"
import { listAllTasks, updateTask } from "../../state/tasks.js"
import { dispatchToMember } from "../control/dispatch.js"
import { extractSessionStatusEntry, asSdkMessages } from "../protocol/output.js"
import { finishRun } from "../control/completion.js"
import { maybeTriggerSignoff } from "../control/signoff.js"
import { captureMemberOutput } from "../records/capture.js"
import { recordEvent } from "../records/events.js"

/** Minimum cooldown (ms) between re-prompt notifications in delegate/recurse. */
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
    buildReprompt: (claimableCount: number) => string,
): Promise<void> {
    const tasks = await listAllTasks(team.directory)
    const incomplete = tasks.filter(t => t.status !== "completed" && t.status !== "deleted")

    if (incomplete.length === 0) {
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
            try {
                const res = await ctx.client.session.messages({ path: { id: m.sessionId } })
                const msgs = asSdkMessages(res.data)
                await captureMemberOutput(team, m, msgs)
            } catch {
                // Best-effort capture: a transient session.messages failure must
                // not crash the delegate barrier — the member's last captured
                // output (if any) will be used in the summary.
            }
        }
        if (await maybeTriggerSignoff(ctx, team)) {
            return  // signoff in progress
        }
        await finishRun(ctx, team, `${label}_complete`, "idle")
        return
    }

    // H40: reset errored members' claimed/in_progress tasks to pending
    // BEFORE the claimable filter. Without this, an errored member's task
    // stays at "claimed"/"in_progress" — excluded from claimable — so the
    // deadlock check sees claimable.length === 0 AND all members
    // idle/errored → false deadlock. recurse.ts:184-197 already does this;
    // the shared tail now matches.
    let erroredResetHappened = false
    for (const m of team.members) {
        if (m.status !== "errored" || !m.sessionId) continue
        const erroredTask = incomplete.find(
            t => (t.status === "claimed" || t.status === "in_progress") && t.owner === m.name,
        )
        if (erroredTask) {
            try {
                await updateTask(team.directory, erroredTask.id, {
                    status: "pending",
                    owner: undefined,
                    claimedAt: undefined,
                })
                recordEvent(team, {
                    timestamp: Date.now(),
                    kind: "errored",
                    member: m.name,
                    detail: `${label}: released ${erroredTask.status} task ${erroredTask.id} from errored member`,
                })
                erroredResetHappened = true
            } catch {
                // Task transitioned out between our read and update — do NOT clobber.
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

    // Claimable tasks: pending AND all blockers completed.
    const claimable = incompleteForClaimable.filter(
        t =>
            t.status === "pending"
            && t.blockedBy.every(id => tasksForClaimable.find(x => x.id === id)?.status === "completed"),
    )

    // Deadlock: no claimable tasks and all members idle.
    // errored counts as terminal (like idle) so an errored member cannot wedge
    // the deadlock check -- its claimed tasks are reaped by the sweep and a
    // survivor reclaims them.
    if (claimable.length === 0) {
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
    // C16: when every idle member is in cooldown, claimable tasks would be
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
        await dispatchToMember(ctx, m, buildReprompt(claimable.length), m.worktreePath ?? ctx.directory, team)
    }
}

/** Delegate idle handler: runs the delegate-style tail with "delegate" label. */
export async function handleDelegateIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    await runDelegateStyleTail(ctx, team, member, "delegate", n =>
        `[Team Orchestrator]\n` 
        + `You have completed your task. ${n} task(s) available. `
        + `Use team_task_list to check, team_task_update to claim, execute, then team_send_message `
        + `to report to master. Repeat until no tasks remain.`)
}

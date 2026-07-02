/**
 * Delegate handler. Drives a shared task pool: members claim tasks, work them,
 * and idle. runDelegateStyleTail owns the termination engine -- all-complete
 * delivers, all-idle-with-claimable fails as deadlock, otherwise the just-idled
 * member is RATE-LIMITED re-prompted toward remaining claimable tasks.
 * Recurse (recurse.ts) reuses this tail.
 */

import type { PluginContext } from "../core/context.js"
import { type Team, clearActiveTask } from "../state/store.js"
import type { MemberState } from "../core/types.js"
import { listAllTasks } from "../state/tasks.js"
import { dispatchToMember } from "./dispatch.js"
import { deliverSummaryToLeader } from "./summary.js"
import { maybeTriggerSignoff } from "./signoff.js"

const NOTIFY_COOLDOWN_MS = 10_000

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
                const entry = (status.data as Record<string, { type?: string }> | undefined)?.[m.sessionId]
                // A member is truly idle only when its SDK session reports
                // "idle" (or the entry is missing). The SDK SessionStatus type
                // has no "running" variant — an actively-working session
                // reports "busy", and a retrying one reports "retry". Both must
                // count as non-idle here, otherwise the deadlock check
                // false-positives while members woken via wake-hint are busy.
                return !entry || entry.type === "idle"
            })
            if (trulyAllIdle) {
                await deliverSummaryToLeader(ctx, team, `${label}_deadlock`)
                clearActiveTask(team)
                team.status = "failed"
                return
            }
            // A member is actually running (wake-hint path) — wait for it.
            return
        }
        return // some members still running, wait
    }

    // Re-prompt this member -- RATE-LIMITED to avoid claim-race busy-loop.
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

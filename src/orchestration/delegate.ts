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

import type { PluginContext } from "../core/context.js"
import { type Team } from "../state/store.js"
import type { MemberState } from "../core/types.js"
import { listAllTasks } from "../state/tasks.js"
import { dispatchToMember } from "./dispatch.js"
import { finishRun } from "./summary.js"
import { maybeTriggerSignoff } from "./signoff.js"
import { captureMemberOutput } from "./handlers.js"

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
        if (await maybeTriggerSignoff(ctx, team)) {
            return  // signoff in progress
        }
        // Before clearing the active task, capture any member whose turn output
        // hasn't been persisted yet. Delegate/recurse members run concurrently;
        // when the completing member idles and triggers this branch, others may
        // still be running or have idled without their captureMemberOutput
        // firing (their subsequent idle would hit a cleared activeTask and skip).
        // Idempotent: already-captured members yield empty outputs and return early.
        for (const m of team.members) {
            if (m.isMaster || !m.sessionId) continue
            const res = await ctx.client.session.messages({ path: { id: m.sessionId } })
            const msgs = (res.data ?? []) as Array<{ info?: any; parts?: any }>
            await captureMemberOutput(ctx, team, m, msgs)
        }
        await finishRun(ctx, team, `${label}_complete`, "idle")
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
    const idleMembers = team.members.filter(
        m => !m.isMaster && m.sessionId && m.status === "idle"
            && (!m.lastNotifiedAt || now - m.lastNotifiedAt >= NOTIFY_COOLDOWN_MS),
    )
    // Sort so the current member is first (it just produced output / has the
    // freshest context), then the rest.
    idleMembers.sort(a => a.name === member.name ? -1 : 1)
    for (const m of idleMembers) {
        const curRunning = team.members.filter(mm => mm.status === "running" && !mm.isMaster).length
        if (claimable.length <= curRunning) break // enough dispatched
        m.lastNotifiedAt = now
        await dispatchToMember(ctx, m, buildReprompt(claimable.length), m.worktreePath ?? ctx.directory, team)
    }
}

export async function handleDelegateIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    await runDelegateStyleTail(ctx, team, member, "delegate", n =>
        `[Team Orchestrator] You have completed your task. ${n} task(s) available. `
        + `Use team_task_list to check, team_task_update to claim, execute, then team_send_message `
        + `to report to master. Repeat until no tasks remain.`)
}

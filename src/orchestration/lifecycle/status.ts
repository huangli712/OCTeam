/**
 * Session status event handler: monitors retry/error/idle/busy transitions
 * and escalates sustained retries to "errored" (otherwise barriers wait forever).
 *
 * Extracted from handlers.ts. This is an independent event-driven entry point
 * (called from hooks.ts), unrelated to the idle state machine.
 */

import type { PluginContext } from "../../core/context.js"
import { logger } from "../../core/log.js"
import type { MemberState } from "../../core/types.js"
import { type Team, loadTeamState, saveTeamStateBounded } from "../../state/store.js"
import { resolveTeamMember } from "../../state/resolve.js"
import { recordEvent } from "../records/events.js"
import { extractSessionStatusEntry } from "../protocol/output.js"
import { checkTermination } from "./termination.js"
import { handleReduceIdle } from "../modes/reduce.js"
import { handleSignoffIdle } from "../control/signoff.js"
import { handleParallelIdle } from "../modes/parallel.js"
import { handleDelegateIdle } from "../modes/delegate.js"
import { handleRecurseIdle } from "../modes/recurse.js"
import { advanceWorkflowStep } from "../workflow/engine.js"
import { handleArenaIdle } from "../modes/arena.js"
import { handleQuorumIdle } from "../modes/quorum.js"

/** Sustained-retry grace window before a member is escalated to "errored". */
const RETRY_ESCALATION_MS = 60_000

/**
 * Escalate a member to errored after sustained retry, then re-drive the state
 * machine if the run survived checkTermination.
 *
 * The re-drive block only reaches for concurrent or multi-phase modes whose
 * barrier can continue with survivors (parallel / delegate / recurse /
 * workflow / arena). The other modes have tolerance 0 in checkTermination, so
 * by the time we reach here activeTask is already cleared for them — they are
 * intentionally absent from the switch.
 */
async function escalateMemberToErrored(
    ctx: PluginContext,
    team: Team,
    live: MemberState,
    entry: { type: string; message?: string } | undefined,
): Promise<void> {
    const retryingSince = live.retryingSince
    live.status = "errored"
    // HIGH: clear retryingSince so sweep doesn't re-escalate this member
    // on every tick. Pre-fix code left it set, causing repeated escalation.
    live.retryingSince = undefined
    live.error =
        `sustained retry > ${RETRY_ESCALATION_MS}ms`
        + ((live.retryCount ?? 0) > 0 ? ` after ${live.retryCount} retries` : "")
        + `: ${entry?.message ?? "unknown"}`
    // H-status: bounded-retry save so a transient I/O error does not leave
    // memory (errored) and disk (still retrying) diverged. Pre-fix code used
    // bare saveTeamState whose throw propagated up through the event wrapper,
    // swallowing the error but leaving the member as errored in memory only.
    try {
        await saveTeamStateBounded(team)
    } catch (err) {
        logger.warn("retry escalation state save failed after retries", {
            team: team.teamName,
            member: live.name,
            error: err instanceof Error ? err.message : String(err),
        })
        // Save failed after retries — rollback in-memory status so the next
        // sweep re-attempts the escalation.
        live.status = "running"
        live.retryingSince = retryingSince
        live.error = undefined
        return
    }
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "errored",
        member: live.name,
        reason: live.error,
    })
    await checkTermination(ctx, team)
    if (team.activeTask) {
        if (team.activeTask.reduceStage) {
            await handleReduceIdle(ctx, team, live)
        } else if (team.activeTask.signoffStage) {
            await handleSignoffIdle(ctx, team, live)
        } else {
            switch (team.activeTask.type) {
                case "parallel":
                    await handleParallelIdle(ctx, team)
                    break
                case "delegate":
                    await handleDelegateIdle(ctx, team, live)
                    break
                case "recurse":
                    await handleRecurseIdle(ctx, team, live)
                    break
                case "workflow":
                    await advanceWorkflowStep(ctx, team)
                    break
                case "arena":
                    await handleArenaIdle(ctx, team, live)
                    break
                case "quorum":
                    // Re-drive the barrier so it can re-check readiness and fire
                    // tally if this errored member was the last-awaited participant.
                    // checkTermination already ran above; do NOT call it again here.
                    await handleQuorumIdle(ctx, team)
                    break
                default:
                    break
            }
        }
    }
    // H-status: trailing save also uses bounded retry.
    try {
        await saveTeamStateBounded(team)
    } catch (err) {
        logger.warn("maybeEscalateRetry: trailing save failed after retries", { team: team.teamName, member: live.name, error: String(err) })
        throw err
    }
}

/**
 * Handle session.status events. session.idle carries no error signal and a
 * retrying member never idles, so we subscribe to session.status to catch
 * retry/error and escalate a sustained retry to "errored" (otherwise the
 * barrier would wait forever). Mutates member state under the team mutex.
 */
export async function handleStatusEvent(
    ctx: PluginContext,
    event: { properties?: Record<string, unknown>; type?: string },
): Promise<void> {
    const sessionID = event.properties?.sessionID
    if (typeof sessionID !== "string" || !sessionID) return
    const member = await resolveTeamMember(ctx.storageRoot, sessionID)
    if (!member || member.isMaster) return

    let team
    try {
        // M-STATUS: use member.storageRoot (the actual scope the team lives in),
    // not ctx.storageRoot (the active plugin scope). Pre-fix code used ctx.scope,
    // which fails for members in the non-active scope (e.g. user-scope member
    // during a project-scope plugin run).
    team = await loadTeamState(member.storageRoot, member.teamName, member.leadSessionId)
    } catch (err) {
        logger.warn("status handler: failed to load team state", { teamName: member.teamName, error: String(err) })
        return
    }
    await team.mutex.runExclusive(async () => {
        if (team.deleted) return
        // CRIT #4: cross-process ownership guard — don't process status
        // events for a run owned by another process.
        if (team.runnerPid !== undefined && team.runnerPid !== process.pid) return
        // HIGH: verify the event's sessionID matches the live member's.
        const live = team.members.find(m => m.name === member.name)
        if (!live) return
        if (live.sessionId !== undefined && live.sessionId !== sessionID) return
        // The event payload is only a signal; re-query to read the authoritative
        // status entry for this session.
        const status = await ctx.client.session.status({})
        const entry = extractSessionStatusEntry(status.data, sessionID)
        if (entry?.type === "retry") {
            const wasUnset = live.retryingSince === undefined
            live.retryingSince ??= Date.now()
            // Persist retryingSince on first set so crash-resume does not lose
            // the escalation timer (otherwise a restart resets it and the
            // 60s escalation window starts over).
            if (wasUnset) await saveTeamStateBounded(team)
            await maybeEscalateRetry(ctx, team, live)
        } else if (entry?.type === "idle") {
            // Member returned to idle: the retry storm ended, so clear tracking.
            live.retryingSince = undefined
            await saveTeamStateBounded(team)
        } else if (entry?.type === "busy") {
            // A previously-idle member is active again: backfill the running state.
            // H7: also clear retryingSince — the member is now productively
            // working (not retrying). Pre-fix code only cleared on idle, so a
            // member that retried then succeeded would keep the retry timer,
            // and maybeEscalateRetry would later mark it errored after 60s of
            // normal work.
            let changed = false
            if (live.status === "idle") {
                live.status = "running"
                changed = true
            }
            if (live.retryingSince !== undefined) {
                live.retryingSince = undefined
                changed = true
            }
            if (changed) await saveTeamStateBounded(team)
        }
    })
}

/**
 * M-8: shared retry-escalation check. Called from BOTH handleStatusEvent (on
 * new session.status events) AND sweepTeamOnce (periodically). Pre-fix code
 * only checked the escalation window inside handleStatusEvent, so a long retry
 * storm with no new status events would never escalate — the member stayed in
 * retry forever, consuming wall-clock until the global timeout.
 *
 * Must be called inside team.mutex.runExclusive.
 */
export async function maybeEscalateRetry(
    ctx: PluginContext,
    team: Team,
    live: MemberState,
): Promise<void> {
    if (live.retryingSince === undefined) return
    if (Date.now() - live.retryingSince <= RETRY_ESCALATION_MS) return
    const maxRetries = team.activeTask?.maxRetries ?? 0
    // Within grace (max_retries not exhausted): consume one grace retry
    // and reset the window so the next escalation check starts fresh.
    if ((live.retryCount ?? 0) < maxRetries) {
        live.retryCount = (live.retryCount ?? 0) + 1
        live.retryingSince = Date.now()
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "retry",
            member: live.name,
            detail: `grace ${live.retryCount}/${maxRetries}`,
        })
        await saveTeamStateBounded(team)
        return
    }
    // Grace exhausted: escalate the member to errored, then re-drive.
    await escalateMemberToErrored(ctx, team, live, undefined)
    // HIGH #10: re-dispatch the errored member so the barrier can advance
    // instead of waiting for wall-clock timeout. The error-recovery barrier
    // (processErrorRecovery) will route the errored member through the mode
    // handler so the barrier sees it and proceeds.
    if (team.activeTask && !live.isMaster && live.sessionId) {
        try {
            const { processErrorRecovery } = await import("./idle.js")
            await processErrorRecovery(ctx, team, live)
        } catch (err) {
            // Best-effort — the errored member will be caught by the next sweep.
            logger.warn("maybeEscalateRetry: re-dispatch after escalation failed", {
                team: team.teamName, member: live.name, error: String(err),
            })
        }
    }
}

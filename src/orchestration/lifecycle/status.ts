/**
 * Session status event handler: monitors retry/error/idle/busy transitions
 * and escalates sustained retries to "errored" (otherwise barriers wait forever).
 *
 * This independent event-driven entry point is called from hooks.ts and is
 * unrelated to the idle state machine.
 */

import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
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
    // Clear retryingSince so the sweep does not re-escalate this member on
    // every tick.
    live.retryingSince = undefined
    live.error =
        `sustained retry > ${RETRY_ESCALATION_MS}ms`
        + ((live.retryCount ?? 0) > 0 ? ` after ${live.retryCount} retries` : "")
        + `: ${entry?.message ?? "unknown"}`
    // A bounded-retry save keeps in-memory and on-disk member state aligned
    // across transient I/O failures.
    try {
        await saveTeamStateBounded(team)
    } catch (err) {
        logSwallowed(ctx, "retry escalation state save failed after retries", err, {
            team: team.teamName,
            member: live.name,
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
    // The trailing save also uses bounded retry.
    try {
        await saveTeamStateBounded(team)
    } catch (err) {
        logSwallowed(
            ctx,
            "maybeEscalateRetry: trailing save failed after retries",
            err,
            { team: team.teamName, member: live.name },
        )
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
        // Use member.storageRoot, the scope where the team lives, rather than
        // ctx.storageRoot, which may point at the plugin's other active scope.
    team = await loadTeamState(member.storageRoot, member.teamName, member.leadSessionId)
    } catch (err) {
        logSwallowed(
            ctx,
            "status handler: failed to load team state",
            err,
            { teamName: member.teamName },
        )
        return
    }
    await team.mutex.runExclusive(async () => {
        if (team.deleted) return
        // Cross-process ownership guard: do not process status
        // events for a run owned by another process.
        if (team.runnerPid !== undefined && team.runnerPid !== process.pid) return
        // Verify that the event's sessionID matches the live member's.
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
            // Also clear retryingSince because the member is productively
            // working again and must not be escalated during normal work.
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
 * Shared retry-escalation check called from handleStatusEvent on new status
 * events and from sweepTeamOnce periodically, so a sustained retry can escalate
 * even when the host emits no further status events.
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
}

/**
 * Session status event handler: monitors retry/error/idle/busy transitions
 * and escalates sustained retries to "errored" (otherwise barriers wait forever).
 *
 * Extracted from handlers.ts. This is an independent event-driven entry point
 * (called from hooks.ts), unrelated to the idle state machine.
 */

import type { PluginContext } from "../../core/context.js"
import type { MemberState } from "../../core/types.js"
import { type Team, loadTeamState, saveTeamState } from "../../state/store.js"
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
    entry: { type: string; message?: string },
): Promise<void> {
    live.status = "errored"
    live.error =
        `sustained retry > ${RETRY_ESCALATION_MS}ms`
        + ((live.retryCount ?? 0) > 0 ? ` after ${live.retryCount} retries` : "")
        + `: ${entry.message ?? "unknown"}`
    await saveTeamState(team)
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
    await saveTeamState(team)
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

    const team = await loadTeamState(ctx.storageRoot, member.teamName, member.leadSessionId)
    await team.mutex.runExclusive(async () => {
        if (team.deleted) return
        const live = team.members.find(m => m.name === member.name)
        if (!live) return
        // The event payload is only a signal; re-query to read the authoritative
        // status entry for this session.
        const status = await ctx.client.session.status({})
        const entry = extractSessionStatusEntry(status.data, sessionID)
        if (entry?.type === "retry") {
            live.retryingSince ??= Date.now()
            if (Date.now() - live.retryingSince > RETRY_ESCALATION_MS) {
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
                    await saveTeamState(team)
                    return
                }
                // Grace exhausted: escalate the member to errored, then
                // re-drive the state machine if the run survived.
                await escalateMemberToErrored(ctx, team, live, entry)
                return
            }
        } else if (entry?.type === "idle") {
            // Member returned to idle: the retry storm ended, so clear tracking.
            live.retryingSince = undefined
            await saveTeamState(team)
        } else if (entry?.type === "busy") {
            // A previously-idle member is active again: backfill the running state.
            if (live.status === "idle") {
                live.status = "running"
                await saveTeamState(team)
            }
        }
    })
}

/**
 * Session status event handler: monitors retry/error/idle/busy transitions
 * and escalates sustained retries to "errored" (otherwise barriers wait forever).
 *
 * Extracted from handlers.ts. This is an independent event-driven entry point
 * (called from hooks.ts), unrelated to the idle state machine.
 */

import type { PluginContext } from "../../core/context.js"
import { loadTeamState, saveTeamState } from "../../state/store.js"
import { resolveTeamMember } from "../../state/resolve.js"
import { recordEvent } from "../runs/events.js"
import { checkTermination } from "./termination.js"
import { handleReduceIdle, handleSignoffIdle } from "../runtime/signoff.js"
import { handleParallelIdle } from "../modes/parallel.js"
import { handleDelegateIdle } from "../modes/delegate.js"
import { handleRecurseIdle } from "../modes/recurse.js"
import { advanceWorkflowStep } from "../workflow/workflow.js"
import { handleArenaIdle } from "../modes/arena.js"

const RETRY_ESCALATION_MS = 60_000

/**
 * handle session.status events. session.idle carries no error signal and a
 * retrying member never idles, so we subscribe to session.status to catch
 * retry/error and escalate a sustained retry to "errored" (otherwise the
 * barrier would wait forever). Mutates member state under the team mutex.
 */
export async function handleStatusEvent(
    ctx: PluginContext,
    event: { properties?: Record<string, unknown>; type?: string },
): Promise<void> {
    const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID
    if (!sessionID) return
    const member = await resolveTeamMember(ctx.storageRoot, sessionID)
    if (!member || member.isMaster) return

    const team = await loadTeamState(ctx.storageRoot, member.teamName, member.leadSessionId)
    await team.mutex.runExclusive(async () => {
        if (team.deleted) return
        const live = team.members.find(m => m.name === member.name)
        if (!live) return
        const status = await ctx.client.session.status({})
        const entry = (status.data as Record<string, { type: string; message?: string }> | undefined)?.[sessionID]
        if (entry?.type === "retry") {
            live.retryingSince ??= Date.now()
            if (Date.now() - live.retryingSince > RETRY_ESCALATION_MS) {
                const maxRetries = team.activeTask?.maxRetries ?? 0
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
                            default:
                                break
                        }
                    }
                }
                await saveTeamState(team)
            }
        } else if (entry?.type === "idle") {
            live.retryingSince = undefined
            await saveTeamState(team)
        } else if (entry?.type === "busy") {
            if (live.status === "idle") {
                live.status = "running"
                await saveTeamState(team)
            }
        }
    })
}

import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
import type { RunStatus } from "../../core/types.js"
import { ackMessages, pollMailbox } from "../../messaging/mailbox.js"
import { formatMailboxInjection } from "../../messaging/format.js"
import type { Team } from "../../state/store.js"
import { recordEvent } from "../runs/events.js"
import { persistRun } from "../runs/runs.js"
import { buildSummary } from "../runs/summary.js"

/**
 * Drain the master mailbox and deliver queued team results when the master goes
 * idle. Called from the event handler's master special-case branch.
 * Uses the same formatter as the Transform hook so the user sees consistent
 * formatting regardless of which drain path delivered the result.
 */
export async function deliverQueuedResultsToMaster(
    ctx: PluginContext,
    team: Team,
    masterSessionId: string,
): Promise<void> {
    const queued = await pollMailbox(team.directory, "master")
    if (queued.length === 0) return

    // Security: filter forged master self-impersonation directives. The master
    // mailbox is writable by any member agent with .octeam/ FS access (see
    // mailbox.ts TRUST BOUNDARY header). Without this filter, a forged line
    // {from:"master", kind:"directive", ...} would be rendered as [DIRECTIVE]
    // into the master's own session, weaponizing the master LLM via forged
    // self-directives. The master never legitimately sends directives to
    // itself, so strip both kind=directive and from=master entries on this
    // drain path. (Forge into other members' mailboxes remains a documented
    // accepted limitation — see mailbox.ts header.)
    const safe = queued.filter(m => m.kind !== "directive" && m.from !== "master")

    let delivered = true
    if (safe.length > 0) {
        await ctx.client.session.promptAsync({
            path: { id: masterSessionId },
            body: {
                parts: [{ type: "text", text: formatMailboxInjection(safe), synthetic: true }],
            },
        }).catch(err => {
            delivered = false
            logSwallowed(ctx, "deliver queued results to master failed", err, { team: team.teamName })
        })
    }
    // ACK all queued (including filtered forged entries) on successful delivery
    // so forged messages are permanently dropped rather than re-delivered by
    // releaseStaleReservations in a 30s TTL loop. On failure, leave all reserved
    // so releaseStaleReservations re-delivers legitimate team results after TTL
    // — otherwise a transient master-session error silently drops them.
    if (delivered) {
        await ackMessages(team.directory, "master", queued)
    }
}

/**
 * Deliver the workflow summary to the leader. Always pushes via promptAsync
 * so the host wakes the leader (immediately if idle, or queued if mid-turn).
 *
 * @param status Explicit run status for persistRun. When omitted, persistRun
 *               falls back to the runStatusFromReason heuristic.
 */
export async function deliverSummaryToLeader(
    ctx: PluginContext,
    team: Team,
    reason: string,
    status?: RunStatus,
): Promise<void> {
    if (!team.activeTask) return
    const summary = await buildSummary(team, team.activeTask, reason)

    // Timeline (#5): emit the terminated event while runId is still on the task
    // (finishRun at most call sites calls clearActiveTask right after this).
    recordEvent(team, { timestamp: Date.now(), kind: "terminated", reason })

    // Persist the run record (#2) BEFORE clearing/delivering. Best-effort: a
    // persistence failure must never block leader delivery. Runs under the
    // team mutex (every call site holds it), so the runId dir has one writer.
    await persistRun(team, reason, status).catch(err =>
        logSwallowed(ctx, "persist run record failed", err, { team: team.teamName, reason }),
    )

    await ctx.client.session.promptAsync({
        path: { id: team.leadSessionId },
        body: {
            parts: [
                {
                    type: "text",
                    text: `<team_result team="${team.teamName}">\n${summary}\n</team_result>`,
                    synthetic: true,
                },
            ],
        },
    })
}

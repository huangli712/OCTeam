/**
 * Result summary construction and leader delivery.
 *
 * The leader session is always notified via promptAsync when a workflow
 * completes — the summary is pushed immediately regardless of the leader's
 * current session state. The host queues the promptAsync if the leader is
 * mid-turn and drives a new turn when the leader becomes available.
 *
 * Detailed per-member results that were sent to the master mailbox during the
 * workflow (e.g. via team_send_message in delegate/consensus modes) are
 * drained separately by deliverQueuedResultsToMaster on the master's idle
 * event.
 */

import type { PluginContext } from "../core/context.js"
import { type Team, clearActiveTask } from "../state/store.js"
import { formatMailboxInjection, pollMailbox, ackMessages } from "../messaging/mailbox.js"
import { truncateOutput } from "./output.js"
import { logSwallowed } from "../core/log.js"
import { persistRun } from "./runs.js"
import { recordEvent } from "./events.js"
import type { ActiveTask, RunStatus } from "../core/types.js"
import {
    summarizeDelegate,
    summarizeLoop,
    summarizeRoute,
    summarizeArbitrate,
    summarizeRecurse,
    summarizeTollgate,
    summarizePipeline,
    summarizeWorkflow,
    summarizeConsensus,
    summarizeParallel,
    summarizeArena,
} from "./summarize-mode.js"

/**
 * Deliver the run summary, clear the active task, and set the team status.
 * Consolidates the teardown triplet (deliver -> clear -> status) that was
 * copy-pasted across the orchestration primitives. Sites with intervening
 * work between deliver and clear (e.g. loop's decisionHistory.push) call the
 * individual operations directly.
 */
export async function finishRun(
    ctx: PluginContext,
    team: Team,
    reason: string,
    status: "idle" | "failed",
): Promise<void> {
    await deliverSummaryToLeader(ctx, team, reason)
    clearActiveTask(team)
    team.status = status
}

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

/**
 * Mode-aware summary. delegate aggregates from the task list (per-task results
 * were already delivered to master via team_send_message; responses[] is NOT
 * used for delegate). loop uses decisionHistory (structured) rather than
 * the overwritten responses[]. parallel/pipeline concatenate captured outputs.
 *
 * Per-mode formatting lives in the summarize* helpers below; this function is
 * a thin dispatcher with an exhaustiveness guard on OrchestrationType.
 */
export async function buildSummary(
    team: Team,
    task: ActiveTask,
    reason: string,
): Promise<string> {
    const head = `mode=${task.type} reason=${reason} tokens=${task.tokensUsed}`
    switch (task.type) {
        case "delegate": return await summarizeDelegate(team, head)
        case "loop": return summarizeLoop(task, head)
        case "route": return summarizeRoute(task, head)
        case "arbitrate": return summarizeArbitrate(task, head)
        case "recurse": return await summarizeRecurse(team, task, head)
        case "tollgate": return summarizeTollgate(task, head)
        case "pipeline": return summarizePipeline(task, head)
        case "consensus": return summarizeConsensus(task, head)
        case "parallel": return summarizeParallel(task, head)
        case "workflow": return summarizeWorkflow(task, head)
        case "arena": return summarizeArena(task, head)
        default: {
            // Exhaustiveness guard for OrchestrationType. Every variant has an
            // explicit case above, so task narrows to `never` here. Adding a new
            // OrchestrationType without a matching case fails this assignment at
            // compile time. Runtime throw prevents silent fall-through.
            const _exhaustive: never = task
            void _exhaustive
            throw new Error(`buildSummary: unhandled OrchestrationType: ${String((task as { type: string }).type)}`)
        }
    }
}

/** One-line-per-member digest of the current round's outputs (consensus). */
export function buildRoundSummary(responses: Record<string, string>): string {
    return Object.entries(responses)
        .map(([name, out]) => `- ${name}: ${truncateOutput(out, 500)}`)
        .join("\n")
}

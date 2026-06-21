/**
 * Result summary construction and leader delivery (design §7.2).
 *
 * The leader session is always notified via promptAsync when a workflow
 * completes — the summary is pushed immediately regardless of the leader's
 * current session state. The host queues the promptAsync if the leader is
 * mid-turn and drives a new turn when the leader becomes available.
 *
 * Detailed per-member results that were sent to the master mailbox during the
 * workflow (e.g. via team_send_message in delegate/discussion modes) are
 * drained separately by deliverQueuedResultsToMaster on the master's idle
 * event.
 */

import type { PluginContext } from "../context.js"
import type { Team } from "../state/store.js"
import { formatMailboxInjection, pollMailbox, ackMessages } from "../mailbox.js"
import { listAllTasks } from "../tasks.js"
import { truncateOutput } from "../utils.js"
import type { ActiveTask } from "../types.js"

/**
 * Deliver the workflow summary to the leader. Always pushes via promptAsync
 * so the host wakes the leader (immediately if idle, or queued if mid-turn).
 */
export async function deliverSummaryToLeader(
    ctx: PluginContext,
    team: Team,
    reason: string,
): Promise<void> {
    if (!team.activeTask) return
    const summary = await buildSummary(team, team.activeTask, reason)

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
 * Drain the master mailbox and deliver queued team results when the master goes
 * idle (B1 fix). Called from the event handler's master special-case branch.
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
    await ctx.client.session.promptAsync({
        path: { id: masterSessionId },
        body: {
            parts: [{ type: "text", text: formatMailboxInjection(queued), synthetic: true }],
        },
    })
    await ackMessages(team.directory, "master", queued)
}

/**
 * Mode-aware summary. delegate aggregates from the task list (per-task results
 * were already delivered to master via team_send_message; responses[] is NOT
 * used for delegate — #3). loop uses decisionHistory (structured) rather than
 * the overwritten responses[]. parallel/pipeline concatenate captured outputs.
 */
export async function buildSummary(
    team: Team,
    task: ActiveTask,
    reason: string,
): Promise<string> {
    const head = `mode=${task.type} reason=${reason} tokens=${task.tokensUsed}`
    switch (task.type) {
        case "delegate": {
            const tasks = await listAllTasks(team.directory)
            const lines = tasks.map(
                t => `- [${t.status}] ${t.subject}${t.owner ? ` (@${t.owner})` : ""}`,
            )
            return `${head}\n${lines.join("\n")}`
        }
        case "loop": {
            const last = task.decisionHistory.at(-1)
            const rounds = task.decisionHistory.map(
                d => `  round ${d.round}: ${d.decision} — ${d.rationale}`,
            )
            return `${head} rounds=${task.currentRound}\nfinal: ${last?.decision ?? "n/a"}\n${rounds.join("\n")}`
        }
        default: {
            // parallel / pipeline: concatenate each member's captured output
            return (
                `${head}\n`
                + Object.entries(task.responses)
                    .map(([name, out]) => `### ${name}\n${truncateOutput(out)}`)
                    .join("\n\n")
            )
        }
    }
}

/** One-line-per-member digest of the current round's outputs (discussion). */
export function buildRoundSummary(responses: Record<string, string>): string {
    return Object.entries(responses)
        .map(([name, out]) => `- ${name}: ${truncateOutput(out, 500)}`)
        .join("\n")
}

/**
 * Result summary construction and leader delivery (design §7.2).
 *
 * The leader session is a passive client: results are delivered only when the
 * leader is idle (so the user's interactive workflow is never interrupted). If
 * the leader is busy, results are queued to the master mailbox and drained
 * later via the event handler (proactive) or the Transform hook (on next turn).
 * The reservation protocol (mailbox.ts) prevents double-delivery.
 */

import type { PluginContext } from "../context.js"
import type { Team } from "../state/store.js"
import { formatMailboxInjection, pollMailbox, ackMessages, writeMailboxMessage } from "../mailbox.js"
import { truncateOutput } from "../utils.js"
import type { ActiveTask, Message } from "../types.js"

/** Check whether the leader session is currently idle. */
async function leaderIsIdle(ctx: PluginContext, team: Team): Promise<boolean> {
    const status = await ctx.client.session.status({ query: { directory: ctx.directory } })
    const leaderStatus = (status.data as Record<string, { type: string }> | undefined)?.[team.leadSessionId]
    return leaderStatus?.type === "idle"
}

/**
 * Deliver the workflow summary to the leader. If idle, inject via promptAsync
 * immediately; otherwise queue to the master mailbox for later drainage.
 */
export async function deliverSummaryToLeader(
    ctx: PluginContext,
    team: Team,
    reason: string,
): Promise<void> {
    if (!team.activeTask) return
    const summary = await buildSummary(team, team.activeTask, reason)

    if (await leaderIsIdle(ctx, team)) {
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
    } else {
        // Queue to master mailbox; drained by event handler on master idle
        // and/or Transform hook on master's next turn (reservation protocol
        // guarantees exactly-once delivery between the two drainers).
        const msg: Message = {
            version: 1,
            id: cryptoRandom(),
            from: "orchestrator",
            to: "master",
            kind: "announcement",
            body: summary,
            summary: `Task complete: ${reason}`,
            timestamp: Date.now(),
            deliveryStatus: "pending",
        }
        await writeMailboxMessage(team.directory, "master", msg)
    }
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
            const { listAllTasks } = await import("../tasks.js")
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

function cryptoRandom(): string {
    return globalThis.crypto.randomUUID()
}

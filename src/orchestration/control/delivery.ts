/**
 * Result delivery that is independent of run completion.
 *
 * The leader can accumulate mailbox messages while an orchestration is active.
 * This module drains those queued results when the master session becomes idle,
 * without coupling mailbox delivery to a particular run's teardown.
 */

import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
import { formatMailboxInjection } from "../../messaging/format.js"
import { ackMessages, pollMailbox } from "../../messaging/mailbox.js"
import type { Team } from "../../state/store.js"

/**
 * Deliver queued member results to the master session and acknowledge the
 * complete reservation batch only after successful delivery.
 *
 * Directive and master-authored records are never injected from this path.
 * Even filtered records are acknowledged with the original batch so forged or
 * otherwise unsafe messages cannot remain reserved forever.
 */
export async function deliverQueuedResultsToMaster(
    ctx: PluginContext,
    team: Team,
    masterSessionId: string,
): Promise<void> {
    const queued = await pollMailbox(team.directory, "master")
    if (queued.length === 0) return

    // Only ordinary member results are safe to inject into the leader session.
    const safe = queued.filter(message => message.kind !== "directive" && message.from !== "master")

    let delivered = true
    if (safe.length > 0) {
        await ctx.client.session.promptAsync({
            path: { id: masterSessionId },
            body: {
                parts: [
                    {
                        type: "text",
                        text: formatMailboxInjection(safe),
                        synthetic: false,
                    }
                ],
            },
        }).catch(err => {
            delivered = false
            logSwallowed(ctx, "deliver queued results to master failed", err, {
                team: team.teamName,
            })
        })
    }

    // Acknowledge only after successful injection so delivery failures retry.
    if (delivered) {
        await ackMessages(team.directory, "master", queued)
    }
}

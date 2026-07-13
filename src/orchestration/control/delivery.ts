import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
import { formatMailboxInjection } from "../../messaging/format.js"
import { ackMessages, pollMailbox } from "../../messaging/mailbox.js"
import type { Team } from "../../state/store.js"

export async function deliverQueuedResultsToMaster(
    ctx: PluginContext,
    team: Team,
    masterSessionId: string,
): Promise<void> {
    const queued = await pollMailbox(team.directory, "master")
    if (queued.length === 0) return
    const safe = queued.filter(message => message.kind !== "directive" && message.from !== "master")

    let delivered = true
    if (safe.length > 0) {
        await ctx.client.session.promptAsync({
            path: { id: masterSessionId },
            body: {
                parts: [{ type: "text", text: formatMailboxInjection(safe), synthetic: true }],
            },
        }).catch(err => {
            delivered = false
            logSwallowed(ctx, "deliver queued results to master failed", err, {
                team: team.teamName,
            })
        })
    }
    if (delivered) {
        await ackMessages(team.directory, "master", queued)
    }
}

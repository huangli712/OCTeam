/**
 * Recipient delivery helper. Writes a message to each recipient's mailbox
 * (Layer 1) and sends a best-effort wake hint to idle recipients (Layer 2) so
 * they process the message on their next turn. Shared by team_intervene
 * (directives) and team_send_message (member messaging) — both follow the same
 * write + wake-hint pattern.
 */

import type { PluginContext } from "../core/context.js"
import { logger } from "../core/log.js"
import type { Message } from "../core/types.js"
import { type Team } from "../state/store.js"
import { countUnreadMessages, writeMailboxMessage, BackpressureError } from "./mailbox.js"
import { sendWakeHint } from "./wake-hint.js"

/**
 * Deliver `base` (a message template without `to`) to each named recipient.
 * For each recipient: append to mailbox, then wake-hint if idle.
 */
export async function deliverToRecipients(
    ctx: PluginContext,
    team: Team,
    recipients: string[],
    base: Omit<Message, "to">,
    backpressureMaxBytes?: number,
): Promise<void> {
    // Pass teamName and active runId for directive authentication binding.
    const authContext = base.kind === "directive"
        ? { teamName: team.teamName, runId: team.activeTask?.runId }
        : undefined
    const failures: string[] = []
    for (const r of recipients) {
        try {
            await writeMailboxMessage(team.directory, r, { ...base, to: r }, backpressureMaxBytes, authContext)
        } catch (err) {
            // BackpressureError is a deliberate rejection, not an I/O failure —
            // propagate immediately so the caller can return the right message.
            if (err instanceof BackpressureError) throw err
            // Isolate per-recipient failures: one bad write must NOT abort the
            // remaining recipients (partial broadcast). Record and continue.
            logger.warn("deliver: mailbox write failed", { recipient: r, error: String(err) })
            failures.push(r)
            continue
        }
        // Best-effort wake hint if the recipient is idle (Layer 2) so it
        // is prompted to process the message on its next turn. Wake-hint
        // failure does NOT count as a delivery failure — the message is
        // already in the mailbox and will be polled on the next turn.
        try {
            const member = team.members.find(m => m.name === r)
            if (member?.sessionId && member.status === "idle") {
                const n = await countUnreadMessages(team.directory, r)
                await sendWakeHint(ctx, member.sessionId, n)
            }
        } catch (err) {
            // wake-hint is best-effort — the message is already in the mailbox
            logger.debug("deliver: wake-hint failed (best-effort)", { recipient: r, error: String(err) })
        }
    }
    if (failures.length > 0) {
        throw new Error(`delivery failed for: ${failures.join(", ")}`)
    }
}

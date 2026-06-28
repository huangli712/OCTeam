/**
 * Recipient delivery helper. Writes a message to each recipient's mailbox
 * (Layer 1) and sends a best-effort wake hint to idle recipients (Layer 2) so
 * they process the message on their next turn. Shared by team_intervene
 * (directives) and team_send_message (member messaging) — both follow the same
 * write + wake-hint pattern.
 */

import type { PluginContext } from "../core/context.js"
import type { Message } from "../core/types.js"
import { type Team } from "../state/store.js"
import { countUnreadMessages, writeMailboxMessage } from "./mailbox.js"
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
): Promise<void> {
    for (const r of recipients) {
        await writeMailboxMessage(team.directory, r, { ...base, to: r })
        // Best-effort wake hint if the recipient is idle (Layer 2) so it
        // is prompted to process the message on its next turn.
        const member = team.members.find(m => m.name === r)
        if (member?.sessionId && member.status === "idle") {
            const n = await countUnreadMessages(team.directory, r)
            await sendWakeHint(ctx, member.sessionId, n)
        }
    }
}

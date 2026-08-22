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
    onDelivered?: (recipient: string) => void,
): Promise<void> {
    // Check team.deleted before delivery. team_delete holds team.mutex during
    // deletion, so this catches deletion completed before delivery starts.
    // A concurrent delete can still race because this loop does not hold the mutex.
    if (team.deleted) {
        throw new Error("deliverToRecipients: team is deleted, refusing to deliver")
    }
    // Use base.runId, captured at dispatch time under the team mutex. Re-reading
    // team.activeTask here could bind a directive to another run if the active
    // run changes between capture and delivery.
    const authContext = base.kind === "directive"
        ? { teamName: team.directory, runId: base.runId }
        : undefined
    const failures: string[] = []
    const backpressureFailures: string[] = []
    for (const r of recipients) {
        // Re-check the tombstone per recipient to narrow the window where
        // team_delete completes after the initial check but before this write.
        // Acquiring team.mutex here could deadlock when the caller already holds it.
        if (team.deleted) {
            throw new Error("deliverToRecipients: team was deleted during delivery")
        }
        try {
            await writeMailboxMessage(team.directory, r, { ...base, to: r }, backpressureMaxBytes, authContext)
        } catch (err) {
            // BackpressureError rejects only the full recipient mailbox, not the
            // entire broadcast. Collect these failures so remaining recipients
            // still receive the message, then throw one BackpressureError after
            // the loop to preserve the caller's catch behavior (recipients
            // already written before the throw stay delivered — a caller-side
            // retry of the same broadcast re-writes them).
            if (err instanceof BackpressureError) {
                backpressureFailures.push(r)
                continue
            }
            // Isolate per-recipient failures: one bad write must NOT abort the
            // remaining recipients (partial broadcast). Record and continue.
            logger.warn("deliver: mailbox write failed", { recipient: r, error: String(err) })
            failures.push(r)
            continue
        }
        onDelivered?.(r)
        // Best-effort wake hint if the recipient is idle (Layer 2) so it
        // is prompted to process the message on its next turn. Wake-hint
        // failure does NOT count as a delivery failure — the message is
        // already in the mailbox and will be polled on the next turn.
        //
        // Fire and forget without awaiting. The message is already in the
        // mailbox (writeMailboxMessage completed above). Awaiting the wake
        // hint blocks the delivery loop — if one recipient's host API is
        // slow, all subsequent recipients' mailbox writes are delayed.
        // Fire-and-forget lets the loop proceed immediately. sendWakeHint
        // internally catches its own rejection (best-effort), so no
        // unhandled rejection is possible.
        try {
            const member = team.members.find(m => m.name === r)
            if (member?.sessionId && member.status === "idle") {
                const n = await countUnreadMessages(team.directory, r)
                void sendWakeHint(ctx, member.sessionId, n)
            }
        } catch (err) {
            // wake-hint is best-effort — the message is already in the mailbox
            logger.debug("deliver: wake-hint setup failed (best-effort)", { recipient: r, error: String(err) })
        }
    }
    if (backpressureFailures.length > 0) {
        // Throw BackpressureError for the first backpressured recipient so the
        // caller (intervene.ts / send_message) can return its specific message.
        // The remaining recipients were still delivered.
        const also = backpressureFailures.length > 1
            ? ` (also: ${backpressureFailures.slice(1).join(", ")})`
            : ""
        throw new BackpressureError(
            backpressureFailures[0],
            `recipient "${backpressureFailures[0]}" mailbox is full (backpressure)${also}`,
        )
    }
    if (failures.length > 0) {
        throw new Error(`delivery failed for: ${failures.join(", ")}`)
    }
}

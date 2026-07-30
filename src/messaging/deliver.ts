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
    // C2 fix: use base.runId (captured at dispatch time under the team
    // mutex) instead of team.activeTask?.runId (re-read here, which may
    // have changed if a run completed and a new run started between
    // capture and delivery). Pre-fix code allowed a directive from run A
    // to be authenticated against run B's context if the run switched.
    const authContext = base.kind === "directive"
        ? { teamName: team.directory, runId: base.runId }
        : undefined
    const failures: string[] = []
    const backpressureFailures: string[] = []
    for (const r of recipients) {
        try {
            await writeMailboxMessage(team.directory, r, { ...base, to: r }, backpressureMaxBytes, authContext)
        } catch (err) {
            // H11: BackpressureError is a per-recipient rejection (that one
            // mailbox is full), NOT a global failure. Pre-fix code threw
            // immediately, aborting all remaining recipients — already-
            // successful recipients kept the message, and a retry would
            // duplicate it. Now collect backpressure failures and continue
            // so remaining recipients still receive the message, then throw
            // a single BackpressureError at the end (preserving the caller's
            // catch behavior).
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
        // H12: fire-and-forget (NOT awaited). The message is already in the
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
        // The remaining recipients were still delivered (H11 fix).
        throw new BackpressureError(backpressureFailures[0], `recipient "${backpressureFailures[0]}" mailbox is full (backpressure)${backpressureFailures.length > 1 ? ` (also: ${backpressureFailures.slice(1).join(", ")})` : ""}`)
    }
    if (failures.length > 0) {
        throw new Error(`delivery failed for: ${failures.join(", ")}`)
    }
}

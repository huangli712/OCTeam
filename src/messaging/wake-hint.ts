/**
 * Best-effort wake hint (Layer 2 delivery, design §5). When a member/master has
 * unread mailbox messages and is idle, send a lightweight reminder (NOT the
 * message content) via promptAsync. The actual content is injected by the
 * Transform hook (Layer 3) on the next turn. Throttled per-session to 1/30s to
 * avoid wake loops.
 */

import type { PluginContext } from "../core/context.js"

const WAKE_HINT_THROTTLE_MS = 30_000
const wakeHintLastSent = new Map<string, number>()

/**
 * Send a wake hint to an idle session that has unread messages. Best-effort:
 * failures are swallowed (the Transform hook is the source of truth for
 * delivery). Throttled per session.
 */
export async function sendWakeHint(
    ctx: PluginContext,
    sessionID: string,
    unread: number,
): Promise<void> {
    const now = Date.now()
    const last = wakeHintLastSent.get(sessionID) ?? 0
    if (now - last < WAKE_HINT_THROTTLE_MS) return
    wakeHintLastSent.set(sessionID, now)
    await ctx.client.session
        .promptAsync({
            path: { id: sessionID },
            body: {
                parts: [
                    {
                        type: "text",
                        text: `[Team Orchestrator] You have ${unread} new team message(s). They will be injected on your next turn.`,
                        synthetic: true,
                    },
                ],
            },
        })
        .catch(() => {
            // best-effort — Transform hook remains the delivery source of truth
        })
}

/** Drop a session's throttle entry (L1) — called on team_delete to bound the map. */
export function clearWakeHint(sessionID: string): void {
    wakeHintLastSent.delete(sessionID)
}

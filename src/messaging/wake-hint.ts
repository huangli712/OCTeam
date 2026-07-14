/**
 * Best-effort wake hint (Layer 2 of the three-layer communication model). When a member/master has
 * unread mailbox messages and is idle, send a lightweight reminder (NOT the
 * message content) via promptAsync. The actual content is injected by the
 * Transform hook (Layer 3) on the next turn. Throttled per-session to 1/30s to
 * avoid wake loops.
 */

import type { PluginContext } from "../core/context.js"

// Minimum gap between wake hints sent to the same session. Prevents wake loops
// where a long unread backlog keeps re-triggering promptAsync on every sweep.
const WAKE_HINT_THROTTLE_MS = 30_000

// Cap on tracked sessions. When exceeded, the oldest entries are evicted to
// bound memory growth for long-lived hosts where sessions end without a
// team_delete (the only path that calls clearWakeHint).
const WAKE_HINT_MAP_CAP = 64

// sessionID -> last wake-hint timestamp. Used to enforce WAKE_HINT_THROTTLE_MS.
// Size bounded by WAKE_HINT_MAP_CAP via evictStaleWakeHints().
const wakeHintLastSent = new Map<string, number>()

/** Evict the oldest throttle entries once the map exceeds the cap. */
function evictStaleWakeHints(): void {
    if (wakeHintLastSent.size <= WAKE_HINT_MAP_CAP) return
    // Oldest first by stored timestamp.
    const sorted = [...wakeHintLastSent.entries()].sort((a, b) => a[1] - b[1])
    const toRemove = sorted.length - WAKE_HINT_MAP_CAP
    for (let i = 0; i < toRemove; i++) {
        wakeHintLastSent.delete(sorted[i]![0])
    }
}

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
    evictStaleWakeHints()
    await ctx.client.session
        .promptAsync({
            path: { id: sessionID },
            body: {
                parts: [
                    {
                        type: "text",
                        text: `[Team Orchestrator] You have ${unread} new team message(s). They will be injected on your next turn.`,
                        synthetic: false,
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

// ---------------------------------------------------------------------------
// Test-only API (production code must NOT use this)
// ---------------------------------------------------------------------------

/** @internal Exported only for test files. */
export const __test__ = {
    /** Current number of tracked sessions (bounds-check regression). */
    wakeHintMapSize(): number {
        return wakeHintLastSent.size
    },
}

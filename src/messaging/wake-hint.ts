/**
 * Best-effort wake hint (Layer 2 of the three-layer communication model). When a member/master has
 * unread mailbox messages and is idle, send a lightweight reminder (NOT the
 * message content) via promptAsync. The actual content is injected by the
 * Transform hook (Layer 3) on the next turn. Throttled per-session to 1/30s to
 * avoid wake loops.
 */

import type { PluginContext } from "../core/context.js"
import { logger } from "../core/log.js"

// Minimum gap between wake hints sent to the same session. Prevents wake loops
// where a long unread backlog keeps re-triggering promptAsync on every sweep.
const WAKE_HINT_THROTTLE_MS = 30_000
// H-G1: bound the promptAsync call so a hanging host API does not leave
// an unresolved promise indefinitely. Fire-and-forget wake hints should
// never block the caller.
const WAKE_HINT_TIMEOUT_MS = 10_000

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
        wakeHintLastSent.delete(sorted[i][0])
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
    // M2: snapshot the timestamp BEFORE the async send so we can check
    // afterward whether a newer call overwrote it. Pre-fix code deleted the
    // entry unconditionally on failure — if a newer call wrote a fresh
    // timestamp in between, the deletion would clear the legitimate throttle.
    const snapshot = now
    wakeHintLastSent.set(sessionID, snapshot)
    evictStaleWakeHints()
    // H-G1: race the promptAsync against a timeout so a hanging host API
    // does not leave an unresolved promise. Pre-fix code had no timeout,
    // so a stuck SDK call would permanently occupy the await.
    const promptPromise = ctx.client.session
        .promptAsync({
            path: { id: sessionID },
            body: {
                parts: [
                    {
                        type: "text",
                        text: `[Team Orchestrator]\n` 
                            + `You have ${unread} new team message(s). `
                            + `They will be injected on your next turn.\n`
                            + `<!-- OMO_INTERNAL_INITIATOR -->`,
                        synthetic: false,
                    },
                ],
            },
        })
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("wake-hint promptAsync timeout")), WAKE_HINT_TIMEOUT_MS)
        timeoutHandle.unref()
    })
    try {
        await Promise.race([promptPromise, timeoutPromise])
    } catch (err) {
        // M2: only clear the throttle if OUR timestamp is still the one
        // in the map. Pre-fix code deleted unconditionally, so a newer
        // call's throttle would be cleared by an older call's failure.
        if (wakeHintLastSent.get(sessionID) === snapshot) {
            wakeHintLastSent.delete(sessionID)
        }
        logger.debug("wake-hint promptAsync failed (best-effort)", { sessionID, error: String(err) })
    } finally {
        // MEDIUM: clear the timeout timer on both success and failure so
        // it doesn't linger as an unref'd timer.
        if (timeoutHandle) clearTimeout(timeoutHandle)
    }
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

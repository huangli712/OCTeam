/**
 * Directive authentication — in-process registry binding directive IDs to
 * their authenticated content.
 *
 * The mailbox JSONL lives under .octeam/ which member agents can write to, so
 * stored fields (id, from, kind, body) are all forgeable (see mailbox.ts
 * "TRUST BOUNDARY" header). A member CAN read a legitimate directive's id from
 * the JSONL and append a forged line with the SAME id but a DIFFERENT body. To
 * defeat this replay attack, the registry maps id → {from, body}: the stored
 * content must match BOTH the id AND the from/body of the line being rendered.
 * A member cannot add to this in-process map (only writeMailboxMessage, running
 * in the host plugin, can), so the only forged line that passes is a VERBATIM
 * copy of a legitimate directive — which merely re-delivers identical content
 * (harmless, bounded by pollMailbox's exactly-once delivery).
 */

import type { Message } from "../core/types.js"

// Cap on tracked directive authentications. When exceeded, the oldest
// entries are evicted to bound memory growth for long-lived hosts.
// Directives are authenticated at write time and checked at poll time
// (typically seconds later); 64 is far above any realistic in-flight count.
const AUTH_DIRECTIVE_MAP_CAP = 64
const authenticatedDirectives = new Map<string, { from: string; to: string; body: string; teamName?: string; runId?: string; ts: number }>()

/** Evict the oldest auth entries once the map exceeds the cap. */
function evictStaleAuthDirectives(): void {
    if (authenticatedDirectives.size <= AUTH_DIRECTIVE_MAP_CAP) return
    const sorted = [...authenticatedDirectives.entries()].sort((a, b) => a[1].ts - b[1].ts)
    const toRemove = sorted.length - AUTH_DIRECTIVE_MAP_CAP
    for (let i = 0; i < toRemove; i++) {
        authenticatedDirectives.delete(sorted[i][0])
    }
}

/**
 * Register a directive's authenticated content (called by writeMailboxMessage
 * for kind:"directive" messages). The (from, body) binding prevents a member
 * from replaying a legitimate id with forged content. The optional runId
 * binding prevents cross-run replay: a directive authenticated for run A is
 * rejected when the active run is B.
 */
export function authenticateDirective(
    msg: Message,
    teamName?: string,
    runId?: string,
): void {
    authenticatedDirectives.set(msg.id, {
        from: msg.from,
        to: msg.to,
        body: msg.body,
        teamName,
        runId,
        ts: Date.now(),
    })
    evictStaleAuthDirectives()
}

/**
 * True iff `msg` is a directive whose (id, from, body) match a registered
 * legitimate write. Rejects forged lines (unregistered id OR same id with
 * different content). When `activeRunId` is provided and the registered
 * directive has a runId, the runId must match — this prevents cross-run
 * replay of directives from ended orchestrations.
 */
export function isAuthenticatedDirective(
    msg: Message,
    activeRunId?: string,
): boolean {
    if (msg.kind !== "directive") return false
    const registered = authenticatedDirectives.get(msg.id)
    if (registered === undefined) return false
    if (registered.from !== msg.from) return false
    if (registered.to !== msg.to) return false
    if (registered.body !== msg.body) return false
    // runId binding: if the registered directive has a runId and an active
    // runId is provided for comparison, they must match. A directive without
    // a registered runId (legacy/unscoped) passes regardless.
    if (registered.runId !== undefined && activeRunId !== undefined && registered.runId !== activeRunId) {
        return false
    }
    return true
}

// ---------------------------------------------------------------------------
// Test-only API (production code must NOT use this)
// ---------------------------------------------------------------------------

/** @internal Exported only for test files. */
export const __test__ = {
    /** Current number of tracked authentications (bounds-check regression). */
    authDirectiveMapSize(): number {
        return authenticatedDirectives.size
    },
}

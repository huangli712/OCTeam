/**
 * Directive authentication — in-process registry binding directive IDs to
 * their authenticated content.
 *
 * The mailbox JSONL lives under .octeam/ which member agents can write to, so
 * stored fields (id, from, kind, body) are all forgeable (see mailbox.ts
 * "TRUST BOUNDARY" header). A member CAN read a legitimate directive's id from
 * the JSONL and append a forged line with the SAME id but a DIFFERENT body. To
 * defeat this replay attack, the registry maps a (to, id) key → {from, body}:
 * the stored content must match BOTH the key AND the from/body of the line
 * being rendered. A member cannot add to this in-process map (only
 * writeMailboxMessage, running in the host plugin, can), so the only forged
 * line that passes is a VERBATIM copy of a legitimate directive.
 *
 * One-shot binding: a successful delivery CONSUMES the auth record via
 * {@link consumeDirectiveAuth} (called from ackMessages). A replay of the same
 * JSONL after ack no longer matches anything in the registry → downgraded to a
 * regular message. This restores the contract documented above against the
 * accepted replay-after-ack gap (the previous code never consumed IDs).
 *
 * Recipient binding: the registry key is `(to, id)` so a broadcast (one base
 * id, written per-recipient with `to` mutated) authenticates each recipient
 * independently. A single-id key would let later recipients overwrite earlier
 * ones, silently downgrading them.
 */

import type { Message } from "../core/types.js"

// Cap on tracked directive authentications. When exceeded, the oldest
// entries are evicted to bound memory growth for long-lived hosts.
// Directives are authenticated at write time and checked at poll time
// (typically seconds later); 64 is far above any realistic in-flight count.
const AUTH_DIRECTIVE_MAP_CAP = 64
const authenticatedDirectives = new Map<string, { from: string; to: string; body: string; teamName?: string; runId?: string; ts: number }>()

/** Registry key combines recipient + id so broadcast (same id, many recipients) authenticates each recipient independently. */
function authKey(to: string, id: string): string {
    return `${to}|${id}`
}

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
 * rejected when the active run is B (or unknown).
 */
export function authenticateDirective(
    msg: Message,
    teamName?: string,
    runId?: string,
): void {
    authenticatedDirectives.set(authKey(msg.to, msg.id), {
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
 * different content). When the registered directive has a runId, the active
 * runId MUST be provided AND match — this prevents cross-run replay and FAILS
 * CLOSED when the active run is unknown (e.g. team state unreadable in the
 * Transform hook). A directive without a registered runId (legacy/unscoped)
 * passes regardless of activeRunId for backward compatibility.
 */
export function isAuthenticatedDirective(
    msg: Message,
    activeRunId?: string,
): boolean {
    if (msg.kind !== "directive") return false
    const registered = authenticatedDirectives.get(authKey(msg.to, msg.id))
    if (registered === undefined) return false
    if (registered.from !== msg.from) return false
    if (registered.to !== msg.to) return false
    if (registered.body !== msg.body) return false
    // Fail-closed runId binding: if the registered directive has a runId, the
    // activeRunId MUST be defined AND match. Returning true when activeRunId
    // is undefined would let a directive authenticated for run A receive
    // [DIRECTIVE] priority during run B (or no run at all), which is the
    // cross-run replay attack the binding exists to prevent.
    if (registered.runId !== undefined && registered.runId !== activeRunId) {
        return false
    }
    return true
}

/**
 * One-shot consumption: delete the auth record for `msg` after it has been
 * successfully delivered. Returns true iff the message was authenticated
 * before consumption. After this call, a replay of the same JSONL line no
 * longer matches the registry → downgraded to a regular message.
 *
 * Called from mailbox.ackMessages so consumption is tied to the durable
 * delivery confirmation (reserved file unlink), not to the in-memory render.
 */
export function consumeDirectiveAuth(
    msg: Message,
    activeRunId?: string,
): boolean {
    if (!isAuthenticatedDirective(msg, activeRunId)) return false
    authenticatedDirectives.delete(authKey(msg.to, msg.id))
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

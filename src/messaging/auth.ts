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
import { logger } from "../core/log.js"

// Cap on tracked directive authentications. When exceeded, the oldest
// entries (older than AUTH_MIN_AGE_MS) are evicted to bound memory growth.
// H-G2: pre-fix cap of 64 was too low — a 12-member team × 6 broadcasts
// already produces 72 in-flight authentications. Raised to 512 and added
// a minimum-age guard so fresh in-flight directives are never evicted.
const AUTH_DIRECTIVE_MAP_CAP = 512
const AUTH_MIN_AGE_MS = 60_000
const authenticatedDirectives = new Map<string, { from: string; to: string; body: string; correlationId: string | undefined; teamName?: string; runId?: string; ts: number }>()

/** Registry key combines team + recipient + id so broadcast (same id, many recipients) authenticates each recipient independently, and directives cannot be replayed across teams that share a member name. */
function authKey(teamName: string | undefined, to: string, id: string): string {
    return `${teamName ?? ""}|${to}|${id}`
}

/** Evict the oldest auth entries once the map exceeds the cap.
 * H-G2: never evict entries younger than AUTH_MIN_AGE_MS — they are likely
 * still in-flight (not yet polled/ACKed). Only evict aged entries. */
function evictStaleAuthDirectives(): void {
    if (authenticatedDirectives.size <= AUTH_DIRECTIVE_MAP_CAP) return
    const now = Date.now()
    const sorted = [...authenticatedDirectives.entries()]
        .filter(([, v]) => now - v.ts > AUTH_MIN_AGE_MS)
        .sort((a, b) => a[1].ts - b[1].ts)
    const excess = authenticatedDirectives.size - AUTH_DIRECTIVE_MAP_CAP
    const toRemove = Math.min(sorted.length, excess)
    for (let i = 0; i < toRemove; i++) {
        // M-7: log eviction so operators can detect if legitimate directives
        // are being silently downgraded. Pre-fix code deleted without logging,
        // so a large broadcast exceeding the 64-entry cap would silently
        // degrade earlier directives to regular messages.
        const evicted = sorted[i]
        const teamDir = evicted[1].teamName ?? "(unknown)"
        logger.warn("evictStaleAuthDirectives: auth entry evicted (cap exceeded); directive will be downgraded to regular message if replayed", {
            teamDir, to: evicted[1].to, age: Date.now() - evicted[1].ts,
        })
        authenticatedDirectives.delete(evicted[0])
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
    authenticatedDirectives.set(authKey(teamName, msg.to, msg.id), {
        from: msg.from,
        to: msg.to,
        body: msg.body,
        correlationId: msg.correlationId,
        teamName,
        runId,
        ts: Date.now(),
    })
    evictStaleAuthDirectives()
}

/**
 * True iff `msg` is a directive whose (id, from, body, correlationId) match
 * a registered legitimate write. Rejects forged lines (unregistered id OR same id with
 * different content). When the registered directive has a runId, the active
 * runId MUST be provided AND match — this prevents cross-run replay and FAILS
 * CLOSED when the active run is unknown (e.g. team state unreadable in the
 * Transform hook).
 *
 * Fail-closed for unscoped directives (C8): a directive registered WITHOUT
 * a runId is accepted ONLY when there is no active run (activeRunId ===
 * undefined), preserving backward compat for the pre-capture edge. When
 * there IS an active run, an unscoped directive is rejected — it cannot be
 * verified as belonging to the current run, and accepting it would allow
 * cross-run replay.
 *
 * correlationId binding (C7): without it, an attacker who knows a
 * directive's (id, from, body) can modify the correlationId to inject
 * additional text into the rendered attribute, bypassing the content
 * binding. The correlationId is now part of the authenticated content.
 */
export function isAuthenticatedDirective(
    msg: Message,
    activeRunId?: string,
    teamName?: string,
): boolean {
    if (msg.kind !== "directive") return false
    const registered = authenticatedDirectives.get(authKey(teamName, msg.to, msg.id))
    if (registered === undefined) return false
    if (registered.from !== msg.from) return false
    if (registered.to !== msg.to) return false
    if (registered.body !== msg.body) return false
    if (registered.correlationId !== msg.correlationId) return false
    // Fail-closed runId binding (C8): a directive without a registered
    // runId is accepted ONLY when there is no active run (activeRunId ===
    // undefined). This preserves backward compat for the pre-capture edge
    // (activeTask.runId still undefined). When there IS an active run,
    // an unscoped directive is rejected — it cannot be verified as
    // belonging to the current run, and accepting it would allow cross-run
    // replay (an attacker who copied the directive line before ACK could
    // replay it in a subsequent run).
    if (registered.runId === undefined) {
        if (activeRunId !== undefined) return false
    } else if (registered.runId !== activeRunId) {
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
 *
 * runId independence (C7): consumption intentionally does NOT re-check the
 * runId binding. ACK is called after successful delivery — the directive
 * was already authenticated by formatMailboxInjection with the active run's
 * runId. The previous code passed msg.runId as activeRunId to
 * isAuthenticatedDirective, which meant an attacker who deleted msg.runId
 * could prevent ACK consumption and replay the directive indefinitely
 * within the same run. Only (to, id, from, body, correlationId) need to
 * match to consume the record.
 */
export function consumeDirectiveAuth(
    msg: Message,
    teamName?: string,
): boolean {
    if (msg.kind !== "directive") return false
    const registered = authenticatedDirectives.get(authKey(teamName, msg.to, msg.id))
    if (registered === undefined) return false
    if (registered.from !== msg.from) return false
    if (registered.to !== msg.to) return false
    if (registered.body !== msg.body) return false
    if (registered.correlationId !== msg.correlationId) return false
    authenticatedDirectives.delete(authKey(teamName, msg.to, msg.id))
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
    /** Test-only: backdate all auth entries by ms to simulate aging. */
    backdateAuthEntries(ms: number): void {
        const offset = Date.now() - ms
        for (const [, v] of authenticatedDirectives) v.ts = offset
    },
    AUTH_DIRECTIVE_MAP_CAP,
    AUTH_MIN_AGE_MS,
}

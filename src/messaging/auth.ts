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
 * One-shot binding: a successful delivery consumes the auth record via
 * {@link consumeDirectiveAuth} (called from ackMessages). After acknowledgement,
 * a replay of the same JSONL line no longer matches the registry and is
 * downgraded to a regular message.
 *
 * Recipient binding: the registry key is `(to, id)` so a broadcast (one base
 * id, written per-recipient with `to` mutated) authenticates each recipient
 * independently. A single-id key would let later recipients overwrite earlier
 * ones, silently downgrading them.
 */

import type { Message } from "../core/types.js"
import { logger } from "../core/log.js"

// Cap on tracked directive authentications. When exceeded, the oldest
// entries are evicted oldest-first to bound memory growth.
// A cap of 512 accommodates six broadcasts to a 12-member team while bounding
// memory growth. Minimum-age ordering evicts older entries before fresh ones.
const AUTH_DIRECTIVE_MAP_CAP = 512
const AUTH_MIN_AGE_MS = 60_000
const authenticatedDirectives = new Map<string, { from: string; to: string; body: string; correlationId: string | undefined; teamName?: string; runId?: string; ts: number }>()

/** Registry key combines team + recipient + id so broadcast (same id, many recipients) authenticates each recipient independently, and directives cannot be replayed across teams that share a member name. */
function authKey(teamName: string | undefined, to: string, id: string): string {
    return `${teamName ?? ""}|${to}|${id}`
}

/** Evict the oldest auth entries once the map exceeds the cap.
 * Prefer aged entries, then evict fresh entries only when required to enforce
 * the hard count cap. */
function evictStaleAuthDirectives(): void {
    if (authenticatedDirectives.size <= AUTH_DIRECTIVE_MAP_CAP) return
    const now = Date.now()
    const sorted = [...authenticatedDirectives.entries()].sort((a, b) => a[1].ts - b[1].ts)
    const aged = sorted.filter(([, value]) => now - value.ts > AUTH_MIN_AGE_MS)
    const fresh = sorted.filter(([, value]) => now - value.ts <= AUTH_MIN_AGE_MS)
    const excess = authenticatedDirectives.size - AUTH_DIRECTIVE_MAP_CAP
    const toRemove = [...aged, ...fresh].slice(0, excess)
    for (const evicted of toRemove) {
        // Log eviction so operators can detect legitimate directives being
        // downgraded. A cap overflow can degrade earlier directives to regular
        // messages.
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
 * Unscoped directives fail closed: a directive registered WITHOUT
 * a runId is accepted ONLY when there is no active run (activeRunId ===
 * undefined), which supports directives captured before runId assignment. When
 * there IS an active run, an unscoped directive is rejected because it cannot be
 * verified as belonging to the current run, and accepting it would allow
 * cross-run replay.
 *
 * The correlationId is authenticated because an attacker who knows a
 * directive's (id, from, body) can modify the correlationId to inject
 * additional text into the rendered attribute, bypassing the content
 * binding.
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
    // A directive without a registered runId is accepted ONLY when there is no
    // active run (activeRunId ===
    // undefined), supporting directives captured before activeTask.runId is
    // assigned. When there IS an active run, an unscoped directive is rejected
    // because it cannot be verified as belonging to the current run, and
    // accepting it would allow cross-run
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
 * Called from mailbox.ackMessages after its reserved-file unlink attempt.
 * Consumption still occurs when unlink fails so the in-process auth record
 * cannot be replayed from a reservation left on disk.
 *
 * Consumption intentionally does NOT re-check the runId binding. ACK is called
 * after successful delivery, so the directive
 * was already authenticated by formatMailboxInjection with the active run's
 * runId. Rechecking against msg.runId would let a missing value prevent ACK
 * consumption and leave the directive replayable within the same run. Only
 * (to, id, from, body, correlationId) need to match to consume the record.
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

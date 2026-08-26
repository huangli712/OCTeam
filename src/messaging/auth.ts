/**
 * Directive authentication — in-process registry mapping (teamName, to, id)
 * keys to the authenticated {from, body, correlationId} content. Mailbox
 * JSONL is member-writable and forgeable; only the host plugin writes this
 * registry, so a replayed line passes only as a verbatim copy. Records are
 * one-shot: consumed at ACK (see consumeDirectiveAuth), after which a replay
 * is downgraded to a regular message; the recipient-scoped key lets each
 * broadcast recipient authenticate independently.
 */

import type { Message } from "../core/types.js"
import { logger } from "../core/log.js"

/** Authenticated directive content; every field is re-checked against the
 * replayed line on authentication. */
type AuthDirectiveRecord = {
    from: string
    to: string
    body: string
    correlationId: string | undefined
    teamName?: string
    runId?: string
    ts: number                    // epoch ms at authentication time
}

/** Max tracked authentications; overflow evicts oldest-first (aged first). */
const AUTH_DIRECTIVE_MAP_CAP = 512

/** Age beyond which an entry is preferred for eviction under cap pressure. */
const AUTH_MIN_AGE_MS = 60_000

/** The registry itself: authKey → authenticated directive content. */
const authenticatedDirectives = new Map<string, AuthDirectiveRecord>()

/** Registry key of team + recipient + id: broadcast recipients authenticate
 * independently, and directives cannot replay across teams sharing a name. */
function authKey(teamName: string | undefined, to: string, id: string): string {
    return `${teamName ?? ""}|${to}|${id}`
}

/** Evict the oldest auth entries once the map exceeds the cap: prefer aged
 * entries, evicting fresh ones only to enforce the hard count cap. */
function evictStaleAuthDirectives(): void {
    if (authenticatedDirectives.size <= AUTH_DIRECTIVE_MAP_CAP) return
    const now = Date.now()
    const sorted = [...authenticatedDirectives.entries()].sort((a, b) => a[1].ts - b[1].ts)
    const aged = sorted.filter(([, value]) => now - value.ts > AUTH_MIN_AGE_MS)
    const fresh = sorted.filter(([, value]) => now - value.ts <= AUTH_MIN_AGE_MS)
    const excess = authenticatedDirectives.size - AUTH_DIRECTIVE_MAP_CAP
    const toRemove = [...aged, ...fresh].slice(0, excess)
    for (const evicted of toRemove) {
        // Warn so operators can detect legitimately authenticated
        // directives being downgraded by cap overflow.
        const teamDir = evicted[1].teamName ?? "(unknown)"
        logger.warn(
            "evictStaleAuthDirectives: auth entry evicted (cap exceeded); "
                + "directive will be downgraded to regular message if replayed",
            { teamDir, to: evicted[1].to, age: Date.now() - evicted[1].ts },
        )
        authenticatedDirectives.delete(evicted[0])
    }
}

/**
 * Register a directive's authenticated content (writeMailboxMessage calls
 * this for kind:"directive"). The content binding defeats forged-content
 * replay; the optional runId binding defeats cross-run replay.
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
 * True iff `msg` is a directive whose registered content matches exactly
 * (id, from, to, body, correlationId). A registered runId MUST equal the
 * active run's — unknown active runs FAIL CLOSED. An unregistered (unscoped)
 * runId is accepted only with no active run, supporting directives captured
 * before runId assignment. correlationId is authenticated to block attribute
 * injection. Registered content is written only by the host plugin.
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
    // Unscoped (no registered runId) is accepted only with no active run;
    // otherwise cross-run replay could not be rejected.
    if (registered.runId === undefined) {
        if (activeRunId !== undefined) return false
    } else if (registered.runId !== activeRunId) {
        return false
    }
    return true
}

/**
 * One-shot consumption: delete `msg`'s auth record after successful
 * delivery (called from ackMessages, even on reservation-unlink failure, so
 * an on-disk leftover cannot be replayed). Returns true iff a record was
 * consumed. Intentionally does NOT re-check runId: delivery already
 * authenticated against the active run, and re-checking would let a missing
 * value block ACK and leave the directive replayable.
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

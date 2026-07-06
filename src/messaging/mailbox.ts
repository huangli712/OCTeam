/**
 * File mailbox (Layer 1 of the three-layer communication model).
 *
 * Each recipient has its own append-only inbox `mailbox/{recipient}.jsonl`.
 * Broadcasts are copied into every recipient's inbox at send time (no global
 * read-flag — eliminates multi-reader bugs). Delivery uses the atomic
 * read-and-reserve protocol so the two master drainers
 * (event-handler proactive drain + Transform hook) never double-deliver.
 *
 * TRUST BOUNDARY — message authenticity. The mailbox lives under
 * `<project>/.octeam/mailbox/`, i.e. inside the project directory that member
 * agents (any role mapped to the `oct-junior` agent: coder/debugger/optimizer/...)
 * can read and write via their edit/write/bash tools. Messages carry NO
 * cryptographic integrity tag (no HMAC/signature): `from` and `kind` are stored
 * verbatim and only XML-escaped on output, never re-authenticated on read.
 * Consequently a member with filesystem write access to `.octeam/` CAN append a
 * forged line (e.g. `{from:"master", kind:"directive", ...}`) that will be
 * rendered as a high-priority `[DIRECTIVE]` apparently from the master — a
 * cross-member privilege-escalation vector. The master's own drain path
 * (`deliverQueuedResultsToMaster`) filters such self-directed forgeries as a
 * partial mitigation; see ARCHITECTURE.md "Mailbox authenticity".
 *
 * This is an accepted, documented limitation of the shared-process,
 * shared-filesystem architecture: an HMAC key cannot be hidden from a member
 * that runs in the same OpenCode process and can read the key file. The robust
 * defense is host-side — exclude `.octeam/` from member write paths via the
 * OpenCode permission layer — which is outside this plugin's control. Code
 * here treats `.octeam/` as trusted and assumes cooperative, non-malicious
 * member agents (the documented threat model). Do NOT add logic that trusts
 * `from`/`kind` for security decisions without acknowledging this boundary.
 */

import fs from "node:fs/promises"
import path from "node:path"

import { isEnoent } from '../core/utils.js';
import { RESERVATION_TTL_MS, atomicWrite, refuseSymlink, withLock } from "../state/locks.js"
import {
    inboxPath,
    isSafePathSegment,
    mailboxLockPath,
    processedPath,
    reservedDir,
    reservedPath,
} from "../state/paths.js"
import type { Message } from "../core/types.js"

// Max lines retained in mailbox/{recipient}.processed.jsonl (audit log). The
// log is append-only by nature; without a cap it grows unbounded across a
// long-lived team. Pruning keeps the most recent entries (see ackMessages).
const PROCESSED_MAX_LINES = 1000

// In-memory registry binding directive IDs to their authenticated CONTENT.
// The mailbox JSONL lives under .octeam/ which member agents can write to, so
// stored fields (id, from, kind, body) are all forgeable (see file header
// "TRUST BOUNDARY"). A member CAN read a legitimate directive's id from the
// JSONL and append a forged line with the SAME id but a DIFFERENT body. To
// defeat this replay attack, the registry maps id → {from, body}: the stored
// content must match BOTH the id AND the from/body of the line being rendered.
// A member cannot add to this in-process map (only writeMailboxMessage, running
// in the host plugin, can), so the only forged line that passes is a VERBATIM
// copy of a legitimate directive — which merely re-delivers identical content
// (harmless, bounded by pollMailbox's exactly-once delivery).
const authenticatedDirectives = new Map<string, { from: string; body: string }>()

/**
 * Register a directive's authenticated content (called by writeMailboxMessage
 * for kind:"directive" messages). The (from, body) binding prevents a member
 * from replaying a legitimate id with forged content.
 */
export function authenticateDirective(msg: Message): void {
    authenticatedDirectives.set(msg.id, { from: msg.from, body: msg.body })
}

/** True iff `msg` is a directive whose (id, from, body) match a registered
 *  legitimate write. Rejects forged lines (unregistered id OR same id with
 *  different content). */
function isAuthenticatedDirective(msg: Message): boolean {
    if (msg.kind !== "directive") return false
    const registered = authenticatedDirectives.get(msg.id)
    return registered !== undefined
        && registered.from === msg.from
        && registered.body === msg.body
}

// --- low-level jsonl helpers ---

async function appendJsonl(filePath: string, obj: unknown): Promise<void> {
    await refuseSymlink(filePath)
    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {
        // parent may already exist
    })
    await fs.appendFile(filePath, JSON.stringify(obj) + "\n", "utf8")
}

/**
 * Minimal top-level schema check for a mailbox Message. Each jsonl line is
 * parsed and cast to Message; a corrupt or tampered line can be valid JSON yet
 * miss the fields delivery/formatting dereference. Validate just id/from/body so
 * wrong-shape entries are skipped alongside the already-skipped malformed lines.
 *
 * NOTE: this is a SHAPE check only, NOT an authenticity check — see the file
 * header "TRUST BOUNDARY" comment. `from`/`kind` are never re-authenticated, so
 * a tampered line with a valid shape is accepted (and rendered trusting its
 * stored sender/kind).
 */
function isValidMessage(value: unknown): value is Message {
    if (typeof value !== "object" || value === null) return false
    const m = value as Record<string, unknown>
    return (
        typeof m.id === "string"
        && isSafePathSegment(m.id)
        && typeof m.from === "string"
        && typeof m.body === "string"
    )
}

async function readJsonl(filePath: string): Promise<Message[]> {
    try {
        const raw = await fs.readFile(filePath, "utf8")
        const lines = raw.split("\n").filter(l => l.length > 0)
        const out: Message[] = []
        let skipped = 0
        for (const line of lines) {
            let parsed: unknown
            try {
                parsed = JSON.parse(line)
            } catch {
                skipped++
                continue
            }
            if (!isValidMessage(parsed)) {
                // Valid JSON but wrong shape (corrupt / tampered): skip it the
                // same way malformed lines are skipped.
                skipped++
                continue
            }
            out.push(parsed)
        }
        if (skipped > 0) {
            console.warn(`[octeam] readJsonl: skipped ${skipped} invalid message line(s) in ${filePath}`)
        }
        return out
    } catch (err: unknown) {
        if (isEnoent(err)) return []
        throw err
    }
}

async function truncateFile(filePath: string): Promise<void> {
    await refuseSymlink(filePath)
    await fs.writeFile(filePath, "", "utf8").catch(err => {
        if (!isEnoent(err)) throw err
    })
}

// --- public API ---

/**
 * Append a single message to a recipient's inbox. Caller handles broadcast by
 * invoking this once per recipient. Enforces payload size before writing.
 */
export async function writeMailboxMessage(
    teamDirectory: string,
    recipient: string,
    message: Message,
): Promise<void> {
    // Authenticate directives at the legitimate write-API boundary, binding
    // the id to the actual (from, body) content. A member forging a line via
    // direct FS append bypasses this function → unregistered → downgraded at
    // render. A replay (same id, different body) fails the content check.
    if (message.kind === "directive") {
        authenticateDirective(message)
    }
    // Hold the mailbox lock so this append is mutually exclusive with
    // pollMailbox's read-reserve-truncate. Without it, an append landing
    // between pollMailbox's read and truncate is silently destroyed
    // (read-truncate race). O_APPEND still applies inside the lock.
    await withLock(mailboxLockPath(teamDirectory, recipient), async () => {
        await appendJsonl(inboxPath(teamDirectory, recipient), message)
    })
}

/**
 * Atomic read-and-reserve. Moves inbox messages into `reserved/` under the
 * mailbox file lock and returns them. Two concurrent drainers calling this see
 * disjoint sets (first wins, second sees empty inbox) — this is the core
 * duplicate-delivery guard between the event-handler master drain and the
 * Transform hook.
 */
export async function pollMailbox(
    teamDirectory: string,
    recipient: string,
): Promise<Message[]> {
    return withLock(mailboxLockPath(teamDirectory, recipient), async () => {
        const inbox = await readJsonl(inboxPath(teamDirectory, recipient))
        if (inbox.length === 0) return []
        for (const msg of inbox) {
            try {
                await atomicWrite(
                    reservedPath(teamDirectory, recipient, msg.id),
                    JSON.stringify({ ...msg, deliveryStatus: "delivered", reservedAt: Date.now() }),
                )
            } catch (err) {
                // Rollback: a later reservation write failed after earlier ones
                // succeeded. Without this cleanup the earlier messages would
                // exist in BOTH reserved/ and inbox/ (inbox is never truncated),
                // and releaseStaleReservations (TTL 30s) would re-append the
                // reserved copy → duplicate injection. Unlink the reserved
                // copies written so far so the inbox remains authoritative.
                for (const done of inbox) {
                    if (done.id === msg.id) break
                    await fs.unlink(reservedPath(teamDirectory, recipient, done.id)).catch(() => {
                        // already removed or never written
                    })
                }
                throw err
            }
        }
        try {
            await truncateFile(inboxPath(teamDirectory, recipient))
        } catch (err) {
            // Rollback: truncate failed after reserves succeeded. Without this
            // cleanup the messages would exist in BOTH reserved/ and inbox/,
            // and releaseStaleReservations (TTL 30s) would re-append the
            // reserved copy → duplicate injection (at-least-once degradation
            // from the module's exactly-once contract). Unlink the reserved
            // copies so the original inbox entries remain authoritative for
            // the next poll attempt. Best-effort: an unlink failure leaves a
            // stranded reserved file that the stale-reaper eventually clears.
            for (const msg of inbox) {
                await fs.unlink(reservedPath(teamDirectory, recipient, msg.id)).catch(() => {
                    // already removed or never written
                })
            }
            throw err
        }
        return inbox
    })
}

/**
 * Commit reserved messages to processed.jsonl and remove the reserved files.
 * Called after a drainer confirms successful delivery.
 */
export async function ackMessages(
    teamDirectory: string,
    recipient: string,
    msgs: Message[],
): Promise<void> {
    // Hold the mailbox lock for the whole batch so releaseStaleReservations
    // cannot re-add a message to the inbox between our append-to-processed and
    // unlink-reservation (exactly-once violation). Matches pollMailbox and
    // releaseStaleReservations batch semantics. Calls _pruneProcessedLogUnlocked
    // (not pruneProcessedLog) to avoid re-acquiring the same non-reentrant lock.
    return withLock(mailboxLockPath(teamDirectory, recipient), async () => {
        for (const msg of msgs) {
            await appendJsonl(processedPath(teamDirectory, recipient), {
                ...msg,
                deliveryStatus: "processed",
            })
            await fs.unlink(reservedPath(teamDirectory, recipient, msg.id)).catch((err: unknown) => {
                // ENOENT is the benign race (reservation already removed) —
                // swallow. Any other errno (EPERM, EBUSY, EROFS, ...) leaves
                // the reservation on disk; releaseStaleReservations would then
                // re-append it to the inbox → duplicate delivery of an already
                // processed message. Surface the failure instead.
                if (!isEnoent(err)) throw err
            })
        }
        // Retention: cap the audit log so it doesn't grow unbounded.
        await _pruneProcessedLogUnlocked(teamDirectory, recipient)
    })
}

/**
 * Cap mailbox/{recipient}.processed.jsonl at PROCESSED_MAX_LINES entries,
 * keeping the most recent. Runs under the mailbox lock so concurrent acks and
 * the stale-reservation reaper can't race the truncate-and-rewrite. Best-effort
 * on read errors (a malformed/missing log is left untouched).
 */
/** Unlocked body of pruneProcessedLog. Caller MUST hold the mailbox lock. */
async function _pruneProcessedLogUnlocked(teamDirectory: string, recipient: string): Promise<void> {
    const p = processedPath(teamDirectory, recipient)
    let raw: string
    try {
        raw = await fs.readFile(p, "utf8")
    } catch (err: unknown) {
        if (isEnoent(err)) return
        throw err
    }
    const lines = raw.split("\n").filter(l => l.length > 0)
    if (lines.length <= PROCESSED_MAX_LINES) return
    const kept = lines.slice(lines.length - PROCESSED_MAX_LINES)
    await atomicWrite(p, kept.join("\n") + "\n")
}

/**
 * Reaper: release reserved messages older than RESERVATION_TTL_MS back to the
 * inbox so they get re-delivered. Covers the crash-between-reserve-and-ack
 * window. Run by the sweep timer.
 */
export async function releaseStaleReservations(
    teamDirectory: string,
    recipient: string,
): Promise<void> {
    return withLock(mailboxLockPath(teamDirectory, recipient), async () => {
        const dir = reservedDir(teamDirectory, recipient)
        let files: string[]
        try {
            files = await fs.readdir(dir)
        } catch (err: unknown) {
            if (isEnoent(err)) return
            throw err
        }
        // Build a set of already-processed message ids so we don't re-deliver
        // a message whose ack succeeded but whose reservation unlink failed
        // (non-ENOENT — see ackMessages). Such an orphan would otherwise be
        // reaped and re-appended to the inbox → duplicate delivery.
        const processedIds = new Set<string>()
        try {
            const processedRaw = await fs.readFile(processedPath(teamDirectory, recipient), "utf8")
            for (const line of processedRaw.split("\n")) {
                if (line.length === 0) continue
                try {
                    const p = JSON.parse(line) as { id?: unknown }
                    if (typeof p.id === "string") processedIds.add(p.id)
                } catch {
                    // skip malformed line
                }
            }
        } catch (err: unknown) {
            if (!isEnoent(err)) throw err
            // no processed.jsonl yet — nothing to dedupe against
        }
        for (const f of files) {
            const p = path.join(dir, f)
            let reservedAt: number | undefined
            let parsed: Message & { reservedAt?: number } | undefined
            try {
                parsed = JSON.parse(await fs.readFile(p, "utf8")) as Message & { reservedAt?: number }
                reservedAt = parsed.reservedAt
            } catch {
                // unreadable reservation file — best-effort skip
                continue
            }
            let mtime: number | undefined
            try {
                mtime = (await fs.stat(p)).mtimeMs
            } catch {
                // gone
            }
            const age = Date.now() - (reservedAt ?? mtime ?? 0)
            if (age > RESERVATION_TTL_MS && parsed) {
                // Skip re-delivery if the message was already processed (its
                // ack succeeded but the reservation unlink failed, leaving an
                // orphan). Just clean up the stale reservation file.
                if (typeof parsed.id === "string" && processedIds.has(parsed.id)) {
                    await fs.unlink(p).catch(() => {
                        // already gone
                    })
                    continue
                }
                // Unlink BEFORE requeuing. If the unlink fails (any errno,
                // including non-ENOENT like EPERM/EBUSY), skip the requeue and
                // leave the file for the next sweep — otherwise the same
                // reservation would be re-requeued on every sweep → infinite
                // duplicate requeues. ENOENT means another sweep already
                // removed it, so the requeue is still safe.
                let unlinked = true
                try {
                    await fs.unlink(p)
                } catch (err: unknown) {
                    if (isEnoent(err)) {
                        // already gone — safe to requeue (no duplicate risk)
                    } else {
                        // unlink failed — do NOT requeue; retry next sweep
                        unlinked = false
                    }
                }
                if (!unlinked) continue
                await appendJsonl(inboxPath(teamDirectory, recipient), {
                    ...parsed,
                    deliveryStatus: "pending",
                })
            }
        }
    })
}

/**
 * Count unread messages in the inbox ONLY (not reserved). Reserved messages are
 * in-flight and will be injected by the Transform hook on the next turn, so
 * skipping the wake-hint for them is correct. Used for wake-hint throttling.
 */
export async function countUnreadMessages(
    teamDirectory: string,
    recipient: string,
): Promise<number> {
    return (await readJsonl(inboxPath(teamDirectory, recipient))).length
}

/**
 * Total on-disk byte size of a recipient's unread inbox (NOT reserved).
 * Used for backpressure checks (messageUnreadMaxBytes) — measures ACTUAL bytes
 * rather than the old `count * 1024` line-proxy, which under-counted by up to
 * 32x for max-size (32KB) message bodies. Returns 0 when the inbox is absent.
 * Cheaper than countUnreadMessages (one stat, no JSON parse).
 */
export async function unreadInboxBytes(
    teamDirectory: string,
    recipient: string,
): Promise<number> {
    try {
        const stat = await fs.stat(inboxPath(teamDirectory, recipient))
        return stat.size
    } catch (err: unknown) {
        if (isEnoent(err)) return 0
        throw err
    }
}

// --- XML escaping (injection hardening) ---

// Escape XML text content (message body). `&` MUST be replaced first so the
// ampersands introduced for the other entities are not double-escaped.
function escapeXmlText(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}

// Escape an XML attribute value (from, correlationId). Builds on text escaping
// and additionally neutralizes the quotes that could close the attribute.
function escapeXmlAttr(value: string): string {
    return escapeXmlText(value)
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

/**
 * Format messages for injection as a synthetic user message. Shared by the
 * Transform hook (member delivery) and the master drain path so both routes
 * present identical formatting.
 *
 * Directive priority: messages with kind === "directive" are rendered FIRST,
 * each prefixed with a [DIRECTIVE] marker, so they take visual precedence in
 * the injected prompt. Regular messages follow after, preserving their order.
 *
 * SECURITY: `kind` and `from` are taken verbatim from the stored line (no
 * authenticity check — see the file header "TRUST BOUNDARY" comment). Only
 * the legitimate write path (writeMailboxMessage, called by team_send_message
 * and team_intervene) sets these fields; the only legitimate directive source
 * is team_intervene, which writes `from: "master"`. A `kind:"directive"` line
 * with any other `from` is a forgery (a member with FS write to .octeam/
 * impersonating control traffic) and is downgraded to a regular message here.
 */
export function formatMailboxInjection(msgs: Message[]): string {
    const render = (m: Message, prefix: string): string =>
        `<team_message from="${escapeXmlAttr(m.from)}"${m.correlationId ? ` correlationId="${escapeXmlAttr(m.correlationId)}"` : ""}>\n`
        + `${prefix}${escapeXmlText(m.body)}\n</team_message>`
    // Directives first (with marker), then regular messages in original order.
    // Authentication: only directives whose (id, from, body) match a
    // legitimate writeMailboxMessage registration are honored. A forged line
    // — whether unregistered id OR a replayed id with different content — is
    // downgraded to a regular message (no [DIRECTIVE] prefix, no priority).
    const directives = msgs.filter(m => isAuthenticatedDirective(m))
    const regular = msgs.filter(m => !isAuthenticatedDirective(m))
    return [
        ...directives.map(m => render(m, "[DIRECTIVE] ")),
        ...regular.map(m => render(m, "")),
    ].join("\n\n")
}

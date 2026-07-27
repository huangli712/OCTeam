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
 * partial mitigation.
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

import { isEnoent } from "../core/utils.js"
import { assertNoSymlinkTraversal, RESERVATION_TTL_MS, atomicWrite, withLock } from "../state/locks.js"
import {
    inboxPath,
    mailboxLockPath,
    processedPath,
    reservedDir,
    reservedPath,
} from "../state/paths.js"
import type { Message } from "../core/types.js"
import { authenticateDirective, consumeDirectiveAuth } from "./auth.js"
import { appendJsonl, readJsonl, truncateFile } from "./jsonl.js"
import { logger } from "../core/log.js"

// Max lines retained in mailbox/{recipient}.processed.jsonl (audit log). The
// log is append-only by nature; without a cap it grows unbounded across a
// long-lived team. Pruning keeps the most recent entries (see ackMessages).
const PROCESSED_MAX_LINES = 1000

/**
 * Append a single message to a recipient's inbox. Caller handles broadcast by
 * invoking this once per recipient. Enforces payload size before writing.
 * When `backpressureMaxBytes` is provided, checks inbox size INSIDE the lock
 * before appending and throws a BackpressureError if the cap would be exceeded.
 */
export class BackpressureError extends Error {
    constructor(public readonly recipient: string, message: string) {
        super(message)
        this.name = "BackpressureError"
    }
}

export async function writeMailboxMessage(
    teamDirectory: string,
    recipient: string,
    message: Message,
    backpressureMaxBytes?: number,
    authContext?: { teamName?: string; runId?: string },
): Promise<void> {
    // Authenticate directives at the legitimate write-API boundary, binding
    // the id to the actual (from, body) content. A member forging a line via
    // direct FS append bypasses this function → unregistered → downgraded at
    // render. A replay (same id, different body) fails the content check.
    // The runId binding prevents cross-run replay of directives.
    if (message.kind === "directive") {
        authenticateDirective(message, authContext?.teamName, authContext?.runId)
    }
    // Hold the mailbox lock so this append is mutually exclusive with
    // pollMailbox's read-reserve-truncate. Without it, an append landing
    // between pollMailbox's read and truncate is silently destroyed
    // (read-truncate race). O_APPEND still applies inside the lock.
    await withLock(mailboxLockPath(teamDirectory, recipient), async () => {
        // Backpressure check INSIDE the lock so concurrent senders cannot
        // both pass the check and collectively exceed the cap.
        if (backpressureMaxBytes !== undefined) {
            const lineBytes = Buffer.byteLength(JSON.stringify(message) + "\n", "utf8")
            const currentBytes = await unreadInboxBytes(teamDirectory, recipient)
            if (currentBytes + lineBytes > backpressureMaxBytes) {
                throw new BackpressureError(recipient, `recipient "${recipient}" mailbox is full (backpressure)`)
            }
        }
        await appendJsonl(inboxPath(teamDirectory, recipient), message, teamDirectory)
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
                    teamDirectory,
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
            await truncateFile(inboxPath(teamDirectory, recipient), teamDirectory)
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
    // releaseStaleReservations batch semantics. Calls pruneProcessedLogUnlocked
    // (the unlocked variant) to avoid re-acquiring the same non-reentrant lock.
    return withLock(mailboxLockPath(teamDirectory, recipient), async () => {
        for (const msg of msgs) {
            await appendJsonl(processedPath(teamDirectory, recipient), {
                ...msg,
                deliveryStatus: "processed",
            }, teamDirectory)
            // One-shot directive auth consumption: a successful ack confirms
            // durable delivery. Delete the in-memory auth record so a later
            // replay of the same JSONL line (via FS tampering or stale
            // reserved-file resurrection) no longer matches the registry and
            // is downgraded to a regular message. The activeRunId argument is
            // omitted here — consumption is delivery-confirmed regardless of
            // current run state (by the time ack runs, formatMailboxInjection
            // has already decided priority using the run binding).
            if (msg.kind === "directive") {
                consumeDirectiveAuth(msg)
            }
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
        await pruneProcessedLogUnlocked(teamDirectory, recipient)
    })
}

/**
 * Cap mailbox/{recipient}.processed.jsonl at PROCESSED_MAX_LINES entries,
 * keeping the most recent. Caller MUST hold the mailbox lock — runs under
 * the same lock as ackMessages and the stale-reservation reaper so concurrent
 * acks can't race the truncate-and-rewrite. Best-effort on read errors
 * (a malformed/missing log is left untouched).
 */
async function pruneProcessedLogUnlocked(teamDirectory: string, recipient: string): Promise<void> {
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
    await atomicWrite(p, kept.join("\n") + "\n", teamDirectory)
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
            // C-6: refuse to follow a symlinked entry inside reserved/. A
            // hostile .octeam/ writer can drop a symlink here to make the
            // reaper read/stat/unlink an arbitrary file outside the team
            // root. Skip and log; do NOT process the entry. (The reserved/
            // directory is an internal protocol artifact — only
            // pollMailbox/ackMessages write to it, never with symlinks.)
            try {
                await assertNoSymlinkTraversal(teamDirectory, p)
            } catch (err) {
                logger.warn("releaseStaleReservations: skipping symlinked reserved entry", {
                    recipient, entry: f,
                    error: err instanceof Error ? err.message : String(err),
                })
                continue
            }
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
                // Requeue: APPEND to inbox FIRST, then unlink the reserved file.
                // The order matters for crash safety — if append fails (ENOSPC,
                // EACCES, EROFS, or process crash mid-operation), the reserved
                // file is still there for the next sweep to retry. Pre-fix code
                // did unlink-then-append, which on append failure permanently
                // lost the only copy of the message. The duplicate risk from
                // append-then-unlink (requeue succeeds but unlink fails → next
                // sweep re-appends) is bounded by pollMailbox's read-reserve-
                // truncate exactly-once protocol and by the processedIds dedup.
                try {
                    await appendJsonl(inboxPath(teamDirectory, recipient), {
                        ...parsed,
                        deliveryStatus: "pending",
                    }, teamDirectory)
                } catch (err) {
                    // Append failed — leave the reserved file in place for
                    // the next sweep. Skip the unlink so the message survives.
                    logger.warn("releaseStaleReservations: requeue append failed; preserving reserved file", {
                        recipient, entry: parsed.id,
                        error: err instanceof Error ? err.message : String(err),
                    })
                    continue
                }
                // Append succeeded — safe to remove the reserved copy. A
                // failure here is best-effort: the message is already in the
                // inbox and will be re-delivered; the orphaned reserved file
                // is a benign duplicate that this same sweep will catch next
                // tick (the requeue above is idempotent against pollMailbox's
                // exactly-once protocol).
                try {
                    await fs.unlink(p)
                } catch (err: unknown) {
                    if (!isEnoent(err)) {
                        logger.debug("releaseStaleReservations: reserved unlink failed after requeue (orphan; benign)", {
                            recipient, entry: parsed.id,
                            error: err instanceof Error ? err.message : String(err),
                        })
                    }
                }
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

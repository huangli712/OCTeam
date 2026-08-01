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

export class AckMessagesError extends Error {
    constructor(
        public readonly acknowledgedMessages: Message[],
        cause: unknown,
    ) {
        super(cause instanceof Error ? cause.message : String(cause), { cause })
        this.name = "AckMessagesError"
    }
}

export async function writeMailboxMessage(
    teamDirectory: string,
    recipient: string,
    message: Message,
    backpressureMaxBytes?: number,
    authContext?: { teamName?: string; runId?: string },
): Promise<void> {
    // H8: authenticate directives INSIDE the lock so the auth record and the
    // mailbox write are transactionally consistent. Pre-fix code registered
    // auth BEFORE acquiring the lock; if the write then failed (backpressure,
    // I/O error), the auth record was orphaned — a forger using the same id
    // could authenticate against it even though no legitimate message was
    // written. Moving auth inside the lock means a failed write never
    // registers auth.
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
        // C8: fall back to message.runId when authContext.runId is absent.
        // M11 fix: register auth AFTER append succeeds. Pre-fix code
        // registered auth BEFORE append — if append failed (EIO, ENOSPC),
        // the auth record persisted for a message that was never written to
        // the mailbox, creating an orphan auth entry that could authenticate
        // a forged inbox line matching the directive's id/from/to/body.
        // Now: the message must be durably in the inbox before it can be
        // authenticated. The mailbox lock prevents poll from observing the
        // message between append and auth registration.
        await appendJsonl(inboxPath(teamDirectory, recipient), message, teamDirectory)
        if (message.kind === "directive") {
            const runId = authContext?.runId ?? message.runId
            // C-9: default the team binding to teamDirectory so directives
            // are ALWAYS bound to the team they were written to, even when
            // the caller omits authContext. This matches what deliver.ts now
            // passes explicitly and makes cross-team replay impossible.
            authenticateDirective(message, authContext?.teamName ?? teamDirectory, runId)
        }
    }, teamDirectory)
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
        const inbox = await readJsonl(inboxPath(teamDirectory, recipient), teamDirectory)
        if (inbox.length === 0) return []
        // HIGH-E: dedup by message ID within this batch. A crash during
        // pollMailbox's truncate-rollback can leave the same message in BOTH
        // inbox and reserved; the stale-reaper then re-appends the reserved
        // copy to inbox → two lines with the same ID. Without this dedup,
        // the caller would inject the same message twice. Keep the first
        // occurrence (original write order).
        const seenIds = new Set<string>()
        const deduped = inbox.filter(msg => {
            if (seenIds.has(msg.id)) return false
            seenIds.add(msg.id)
            return true
        })
        if (deduped.length === 0) return []
        // C6: drop forged cross-mailbox directives. A directive whose `to`
        // does not match this mailbox's recipient was copied here by a member
        // with FS write access (the directive was authenticated for a
        // DIFFERENT recipient's mailbox). Without this filter the auth
        // registry (keyed by msg.to|id) would authenticate the forged copy,
        // letting a directive meant for Alice execute in Bob's session AND
        // consuming Alice's auth record via Bob's ACK. Only directives are
        // filtered — regular-message cross-mailbox copies are lower-impact
        // (the LLM can see the from/to mismatch) and filtering them would
        // change pollMailbox's contract for non-directive traffic.
        const safe = deduped.filter(msg => msg.kind !== "directive" || msg.to === recipient)
        for (const msg of safe) {
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
                for (const done of safe) {
                    if (done.id === msg.id) break
                    await fs.unlink(reservedPath(teamDirectory, recipient, done.id)).catch((err: unknown) => {
                        // H15: ENOENT is the benign race (already removed). Any
                        // other errno (EPERM, EBUSY) leaves an orphaned
                        // reservation that the stale-reaper eventually clears,
                        // but logging it makes the failure observable.
                        if (!isEnoent(err)) {
                            logger.debug("pollMailbox: rollback unlink failed (orphan; benign)", {
                                recipient, entry: done.id,
                                error: err instanceof Error ? err.message : String(err),
                            })
                        }
                    })
                }
                throw err
            }
        }
        // Even when all messages were filtered as forged directives (safe is
        // empty but deduped was not), still truncate the inbox so the
        // forgeries are durably discarded — otherwise they remain in the
        // inbox and reappear on every subsequent poll.
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
            for (const msg of safe) {
                await fs.unlink(reservedPath(teamDirectory, recipient, msg.id)).catch((err: unknown) => {
                    // H15: ENOENT is the benign race (already removed). Any
                    // other errno leaves an orphaned reservation that the
                    // stale-reaper eventually clears, but logging makes it
                    // observable.
                    if (!isEnoent(err)) {
                        logger.debug("pollMailbox: truncate-rollback unlink failed (orphan; benign)", {
                            recipient, entry: msg.id,
                            error: err instanceof Error ? err.message : String(err),
                        })
                    }
                })
            }
            throw err
        }
        return safe
    }, teamDirectory)
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
        const acknowledgedMessages: Message[] = []
        const unlinkErrors: unknown[] = []
        for (const msg of msgs) {
            try {
                await appendJsonl(processedPath(teamDirectory, recipient), {
                    ...msg,
                    deliveryStatus: "processed",
                    // M12 fix: record ACK time so retention pruning uses when the
                    // message was actually processed, not when it was sent. A
                    // message that sat in the inbox for a long time before being
                    // ACKed would otherwise be pruned immediately on the next
                    // prune cycle, losing its dedup protection.
                    processedAt: Date.now(),
                }, teamDirectory)
            } catch (err) {
                throw new AckMessagesError(acknowledgedMessages, err)
            }
            acknowledgedMessages.push(msg)
            // C-11: track per-message unlink outcome so one earlier failure
            // does not suppress auth consumption for later directives whose
            // own reservation unlink succeeded. Pre-fix code used a shared
            // `unlinkErrors.length === 0` check, leaving successful directives'
            // auth records unconsumed → same-run replay by copying the JSONL
            // line back into the inbox.
            // Note: auth consumption is now unconditional (HIGH #13), so
            // thisMsgUnlinkFailed is tracked only for the error report.
            await fs.unlink(reservedPath(teamDirectory, recipient, msg.id)).catch((err: unknown) => {
                if (!isEnoent(err)) {
                    const errMsg = err instanceof Error ? err.message : String(err)
                    logger.warn("ackMessages: reservation unlink failed", { msgId: msg.id, error: errMsg })
                    unlinkErrors.push(err)
                }
            })
            if (msg.kind === "directive") {
                // HIGH #13: consume auth after processed append succeeds,
                // regardless of unlink outcome. Pre-fix code only consumed
                // on unlink success, leaving auth replayable if unlink failed.
                consumeDirectiveAuth(msg, teamDirectory)
            }
        }
        if (unlinkErrors.length > 0) {
            throw new AckMessagesError(acknowledgedMessages, unlinkErrors[0])
        }
        // Retention: cap the audit log so it doesn't grow unbounded.
        try {
            await pruneProcessedLogUnlocked(teamDirectory, recipient)
        } catch (err) {
            throw new AckMessagesError(acknowledgedMessages, err)
        }
    }, teamDirectory)
}

/**
 * Cap mailbox/{recipient}.processed.jsonl by AGE, not line count. Keeps
 * entries younger than PROCESSED_RETENTION_MS so the dedup window in
 * releaseStaleReservations always covers any in-flight reservation (whose
 * TTL is RESERVATION_TTL_MS = 30s). Pre-fix code capped at 1000 lines,
 * which under high message volume could prune the processed record of a
 * message whose reservation file was still pending → duplicate delivery.
 * Caller MUST hold the mailbox lock.
 */
// H-G4: retention must cover the worst-case reservation lifetime.
// Reservations have TTL = RESERVATION_TTL_MS (30s); the stale-reaper checks
// periodically, so a reservation can survive up to ~2× TTL past expiry.
// Pre-fix multiplier of 2 (60s) was too tight if the reaper was delayed.
const PROCESSED_RETENTION_MS = RESERVATION_TTL_MS * 4
const PROCESSED_MAX_BYTES = 1_048_576
const PROCESSED_RETENTION_BYTES = 512 * 1024

async function pruneProcessedLogUnlocked(teamDirectory: string, recipient: string): Promise<void> {
    const p = processedPath(teamDirectory, recipient)
    // C-1: processedPath is a leaf under <team>/mailbox; the mailbox lock
    // only walks ancestors of the lockfile, so the processed.jsonl leaf
    // and any mailbox/ subdirs need their own guard.
    try {
        await assertNoSymlinkTraversal(teamDirectory, p)
    } catch (err) {
        if (isEnoent(err)) return
        throw err
    }
    let raw: string
    let truncated = false
    try {
        // H2: reject non-regular files and bound memory while compacting an
        // oversized log to its most recent complete-line window.
        const stat = await fs.lstat(p)
        if (!stat.isFile()) return
        if (stat.size > PROCESSED_MAX_BYTES) {
            const start = stat.size - PROCESSED_RETENTION_BYTES
            const buffer = Buffer.alloc(PROCESSED_RETENTION_BYTES)
            const handle = await fs.open(p, "r")
            try {
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
                const tail = buffer.subarray(0, bytesRead).toString("utf8")
                const firstNewline = tail.indexOf("\n")
                raw = firstNewline === -1 ? "" : tail.slice(firstNewline + 1)
                truncated = true
            } finally {
                await handle.close()
            }
        } else {
            raw = await fs.readFile(p, "utf8")
        }
    } catch (err: unknown) {
        if (isEnoent(err)) return
        throw err
    }
    const lines = raw.split("\n").filter(l => l.length > 0)
    // H14: prune by timestamp, not line count. Each processed entry has a
    // `timestamp` field (the original Message.timestamp) and optionally a
    // `processedAt` field (when the message was ACKed).
    // M12 fix: prefer `processedAt` for retention so a message that sat in
    // the inbox for a long time before ACK is not immediately pruned. Fall
    // back to `timestamp` for legacy entries without processedAt. Keep
    // entries whose retention time is within PROCESSED_RETENTION_MS of now.
    // Entries without a parseable timestamp are kept (conservative — never
    // prune what we can't age-check).
    const now = Date.now()
    const kept: string[] = []
    let pruned = 0
    for (const line of lines) {
        try {
            const entry = JSON.parse(line) as { timestamp?: unknown; processedAt?: unknown }
            const retentionTime = typeof entry.processedAt === "number" && Number.isFinite(entry.processedAt)
                ? entry.processedAt
                : entry.timestamp
            if (typeof retentionTime === "number" && Number.isFinite(retentionTime)
                && now - retentionTime > PROCESSED_RETENTION_MS) {
                pruned++
                continue
            }
        } catch {
            // malformed line — keep it (conservative)
        }
        kept.push(line)
    }
    if (pruned === 0 && !truncated) return
    // MEDIUM: before writing the truncated log, collect IDs from active
    // reservations so they're never lost from the processed dedup log.
    // Pre-fix code's byte truncation could delete IDs that still have
    // active reservations, causing the reaper to re-queue and re-deliver.
    // C8: pre-fix code manually built `<team>/reserved/<recipient>` which
    // does not exist — the actual layout is `<team>/mailbox/<recipient>.reserved`
    // (see paths.ts reservedDir). Use the canonical helper to read active
    // reservation IDs so truncation never drops them from the dedup log.
    const reservedDirPath = reservedDir(teamDirectory, recipient)
    let reservedIds: Set<string> | undefined
    try {
        const reservedEntries = await fs.readdir(reservedDirPath)
        reservedIds = new Set(reservedEntries.map(f => f.replace(/\.json$/, "")))
    } catch { /* ENOENT — no reservations */ }
    if (reservedIds && reservedIds.size > 0) {
        // Re-add any reserved IDs that were pruned by truncation.
        for (const line of lines) {
            try {
                const entry = JSON.parse(line) as { id?: string }
                if (entry.id && reservedIds.has(entry.id) && !kept.includes(line)) {
                    kept.push(line)
                }
            } catch { /* skip malformed */ }
        }
    }
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
        // C-1: reservedDir is <team>/mailbox/reserved/<recipient>; the lock
        // walks ancestors of <team>/mailbox/<recipient>.lock only, so the
        // reserved/ subdir chain needs its own guard before readdir.
        try {
            await assertNoSymlinkTraversal(teamDirectory, dir)
        } catch (err: unknown) {
            if (isEnoent(err)) return
            throw err
        }
        let files: string[]
        try {
            files = await fs.readdir(dir)
        } catch (err: unknown) {
            if (isEnoent(err)) return
            throw err
        }
        await pruneProcessedLogUnlocked(teamDirectory, recipient)
        // Build a set of already-processed message ids so we don't re-deliver
        // a message whose ack succeeded but whose reservation unlink failed
        // (non-ENOENT — see ackMessages). Such an orphan would otherwise be
        // reaped and re-appended to the inbox → duplicate delivery.
        const processedIds = new Set<string>()
        try {
            // H2: cap file size and reject non-regular files before reading.
            const procPath = processedPath(teamDirectory, recipient)
            // C-1: guard the processed.jsonl leaf path before lstat/readFile.
            await assertNoSymlinkTraversal(teamDirectory, procPath)
            const procStat = await fs.lstat(procPath)
            if (procStat.isFile() && procStat.size <= PROCESSED_MAX_BYTES) {
                const processedRaw = await fs.readFile(procPath, "utf8")
                for (const line of processedRaw.split("\n")) {
                    if (line.length === 0) continue
                    try {
                        const pr = JSON.parse(line) as { id?: unknown }
                        if (typeof pr.id === "string") processedIds.add(pr.id)
                    } catch {
                        // skip malformed line
                    }
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
                // H2: cap reservation file size and reject non-regular files.
                const rstat = await fs.lstat(p)
                if (!rstat.isFile() || rstat.size > 65_536) {
                    logger.warn("releaseStaleReservations: skipping non-regular/oversized reservation", { path: p, size: rstat.size })
                    continue
                }
                parsed = JSON.parse(await fs.readFile(p, "utf8")) as Message & { reservedAt?: number }
                const raw = (parsed as { reservedAt?: unknown }).reservedAt
                // H15: reservedAt MUST be a finite number. A tampered or corrupt
                // reservation file could carry reservedAt: "invalid" (string),
                // which would make age = Date.now() - "invalid" = NaN, and
                // NaN > TTL is always false → the message is stranded in
                // reserved/ forever (permanent message loss). Coerce non-finite
                // values to undefined so the mtime fallback below applies.
                // M5: reject future timestamps (clock skew, tampering). A
                // reservedAt far in the future produces negative age, so
                // age > TTL is always false → message stranded forever.
                // Allow a small tolerance (30s) for clock drift.
                const now = Date.now()
                reservedAt = typeof raw === "number" && Number.isFinite(raw) && raw <= now + 30_000
                    ? raw : undefined
            } catch (err) {
                // H15: log instead of silently skipping, so unreadable/corrupt
                // reservation files are observable. The skip itself is correct
                // (we cannot parse the message to requeue it).
                logger.warn("releaseStaleReservations: unreadable reservation file; skipping", {
                    recipient, entry: f,
                    error: err instanceof Error ? err.message : String(err),
                })
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
                    await fs.unlink(p).catch((err: unknown) => {
                        // H15: ENOENT is benign. Non-ENOENT leaves the orphaned
                        // reservation (processedIds dedup prevents re-delivery,
                        // so it's harmless but observable).
                        if (!isEnoent(err)) {
                            logger.debug("releaseStaleReservations: processed-dedup unlink failed", {
                                recipient, entry: parsed!.id,
                                error: err instanceof Error ? err.message : String(err),
                            })
                        }
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
    }, teamDirectory)
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
    return (await readJsonl(inboxPath(teamDirectory, recipient), teamDirectory)).length
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
        // C-1: unreadInboxBytes runs OUTSIDE the mailbox lock; guard the
        // inbox path's ancestor chain so a symlinked <team>/mailbox (or the
        // inbox file itself) cannot redirect the stat to an external file.
        const inboxP = inboxPath(teamDirectory, recipient)
        await assertNoSymlinkTraversal(teamDirectory, inboxP)
        const stat = await fs.stat(inboxP)
        return stat.size
    } catch (err: unknown) {
        if (isEnoent(err)) return 0
        throw err
    }
}

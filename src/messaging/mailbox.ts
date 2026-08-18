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
import { createInterface } from "node:readline"

import { isEnoent } from "../core/utils.js"
import { 
    assertNoSymlinkTraversal,
    RESERVATION_TTL_MS,
    atomicWrite,
    withLock
} from "../state/locks.js"
import {
    inboxPath,
    mailboxLockPath,
    processedPath,
    reservedDir,
    reservedPath,
} from "../state/paths.js"
import type { Message } from "../core/types.js"
import {
    authenticateDirective,
    consumeDirectiveAuth
} from "./auth.js"
import {
    appendJsonl,
    readJsonl,
    truncateFile
} from "./jsonl.js"
import { logger } from "../core/log.js"

/**
 * Cap mailbox/{recipient}.processed.jsonl by AGE, not line count. Keeps
 * entries younger than PROCESSED_RETENTION_MS so the dedup window in
 * releaseStaleReservations always covers any in-flight reservation whose
 * TTL is RESERVATION_TTL_MS = 30s, even under high message volume.
 * Reservations can survive up to ~2× TTL past expiry (the stale-reaper
 * checks periodically), so four TTL intervals leave room for delayed
 * reaper cycles.
 */
const PROCESSED_RETENTION_MS = RESERVATION_TTL_MS * 4

/** Size ceiling above which processed.jsonl is compacted by bytes. */
const PROCESSED_MAX_BYTES = 1_048_576

/** Tail window (bytes) kept when compacting an oversized processed.jsonl. */
const PROCESSED_RETENTION_BYTES = 512 * 1024

/** Raised when a recipient's mailbox exceeds its configured byte limit. */
export class BackpressureError extends Error {
    constructor(public readonly recipient: string, message: string) {
        super(message)
        this.name = "BackpressureError"
    }
}

/** Reports an acknowledgement failure along with messages already processed. */
export class AckMessagesError extends Error {
    constructor(
        public readonly acknowledgedMessages: Message[],
        cause: unknown,
    ) {
        super(cause instanceof Error ? cause.message : String(cause), { cause })
        this.name = "AckMessagesError"
    }
}

/**
 * Append one message to a recipient's inbox under its mailbox lock.
 * Caller handles broadcast by invoking this once per recipient. Enforces
 * backpressure and registers directive authentication after the write.
 */
export async function writeMailboxMessage(
    teamDirectory: string,
    recipient: string,
    message: Message,
    backpressureMaxBytes?: number,
    authContext?: { teamName?: string; runId?: string },
): Promise<void> {
    // Authenticate directives inside the lock so the auth record and mailbox
    // write are transactionally consistent. A failed write never registers an
    // orphan auth record that could authenticate a forged line with the same id.
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
        // Fall back to message.runId when authContext.runId is absent. Register
        // auth only after append succeeds so an I/O failure cannot leave an
        // orphan auth entry for a message that was never written. The mailbox
        // lock prevents polling between append and auth registration.
        await appendJsonl(inboxPath(teamDirectory, recipient), message, teamDirectory)
        if (message.kind === "directive") {
            const runId = authContext?.runId ?? message.runId
            // Default the team binding to teamDirectory so directives are always
            // bound to their destination team, even when the caller omits
            // authContext. This matches the explicit context from deliver.ts and
            // prevents cross-team replay.
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
        // Deduplicate by message ID within this batch. A crash during
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
        // Drop forged cross-mailbox directives. A directive whose `to`
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
                        // ENOENT is the benign race (already removed). Any
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
                    // ENOENT is the benign race (already removed). Any
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
                    // Record ACK time so retention pruning uses when the
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
            // Track unlink failures independently so one failure does not suppress
            // auth consumption for later directives. Auth consumption is
            // unconditional, so unlink outcome is retained only for error reporting.
            await fs.unlink(reservedPath(teamDirectory, recipient, msg.id)).catch((err: unknown) => {
                if (!isEnoent(err)) {
                    const errMsg = err instanceof Error ? err.message : String(err)
                    logger.warn("ackMessages: reservation unlink failed", { msgId: msg.id, error: errMsg })
                    unlinkErrors.push(err)
                }
            })
            if (msg.kind === "directive") {
                // Consume auth after the processed append succeeds, regardless of
                // unlink outcome, so cleanup failures cannot leave it replayable.
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
 * Prune a recipient's processed.jsonl audit/dedup log. Prunes by age
 * (see PROCESSED_RETENTION_MS) and, when the file exceeds
 * PROCESSED_MAX_BYTES, compacts it to the most recent
 * PROCESSED_RETENTION_BYTES tail window. Lines for messages with an
 * active reservation are always retained so they cannot be requeued.
 * Caller MUST hold the mailbox lock.
 */
async function pruneProcessedLogUnlocked(teamDirectory: string, recipient: string): Promise<void> {
    const p = processedPath(teamDirectory, recipient)
    // processedPath is a leaf under <team>/mailbox; the mailbox lock
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
    let reservedIds: Set<string> | undefined
    const reservedLines = new Map<string, string>()
    try {
        // Reject non-regular files and bound memory while compacting an
        // oversized log to its most recent complete-line window.
        const stat = await fs.lstat(p)
        if (!stat.isFile()) return
        if (stat.size > PROCESSED_MAX_BYTES) {
            try {
                reservedIds = new Set(await fs.readdir(reservedDir(teamDirectory, recipient)))
            } catch {}
            const start = stat.size - PROCESSED_RETENTION_BYTES
            const buffer = Buffer.alloc(PROCESSED_RETENTION_BYTES)
            const handle = await fs.open(p, "r")
            try {
                if (reservedIds && reservedIds.size > 0) {
                    const reader = createInterface({
                        input: handle.createReadStream({ encoding: "utf8", autoClose: false }),
                        crlfDelay: Infinity,
                    })
                    for await (const line of reader) {
                        if (line.length === 0) continue
                        try {
                            const entry = JSON.parse(line) as { id?: unknown }
                            if (typeof entry.id === "string" && reservedIds.has(entry.id)) {
                                reservedLines.set(entry.id, line)
                            }
                        } catch {}
                    }
                }
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
    // Prune by timestamp, not line count. Each processed entry has a
    // `timestamp` field (the original Message.timestamp) and optionally a
    // `processedAt` field (when the message was ACKed).
    // Prefer `processedAt` for retention so a message that sat in
    // the inbox for a long time before ACK is not immediately pruned. Fall
    // back to `timestamp` for legacy entries without processedAt. Keep
    // entries whose retention time is within PROCESSED_RETENTION_MS of now.
    // Entries without a parseable timestamp are kept (conservative — never
    // prune what we can't age-check).
    const now = Date.now()
    const kept: string[] = []
    const keptIds = new Set<string>()
    let pruned = 0
    for (const line of lines) {
        let entryId: string | undefined
        try {
            const entry = JSON.parse(line) as { id?: unknown; timestamp?: unknown; processedAt?: unknown }
            entryId = typeof entry.id === "string" ? entry.id : undefined
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
        if (entryId !== undefined) keptIds.add(entryId)
        kept.push(line)
    }
    if (pruned === 0 && !truncated) return
    // Before writing the truncated log, collect IDs from active reservations so
    // they remain in the processed dedup log and cannot be requeued. Read them
    // through reservedDir, which resolves the canonical reservation layout.
    if (reservedIds === undefined) {
        try {
            reservedIds = new Set(await fs.readdir(reservedDir(teamDirectory, recipient)))
        } catch {}
    }
    if (reservedIds && reservedIds.size > 0) {
        for (const line of lines) {
            try {
                const entry = JSON.parse(line) as { id?: unknown }
                if (typeof entry.id === "string" && reservedIds.has(entry.id)) {
                    reservedLines.set(entry.id, line)
                }
            } catch { /* skip malformed */ }
        }
    }
    const restored = [...reservedLines]
        .filter(([id]) => !keptIds.has(id))
        .map(([, line]) => line)
    await atomicWrite(p, [...restored, ...kept].join("\n") + "\n", teamDirectory)
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
        // reservedDir is <team>/mailbox/<recipient>.reserved; the lock
        // walks ancestors of <team>/mailbox/<recipient>.lock only, so the
        // <recipient>.reserved chain needs its own guard before readdir.
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
            // Cap file size and reject non-regular files before reading.
            const procPath = processedPath(teamDirectory, recipient)
            // Guard the processed.jsonl leaf path before lstat/readFile.
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
            // Refuse to follow a symlinked entry inside reserved/. A
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
                // Cap reservation file size and reject non-regular files.
                const rstat = await fs.lstat(p)
                if (!rstat.isFile() || rstat.size > 65_536) {
                    logger.warn("releaseStaleReservations: skipping non-regular/oversized reservation", { path: p, size: rstat.size })
                    continue
                }
                parsed = JSON.parse(await fs.readFile(p, "utf8")) as Message & { reservedAt?: number }
                const raw = (parsed as { reservedAt?: unknown }).reservedAt
                // reservedAt MUST be a finite number. A tampered or corrupt
                // reservation file could carry reservedAt: "invalid" (string),
                // which would make age = Date.now() - "invalid" = NaN, and
                // NaN > TTL is always false → the message is stranded in
                // reserved/ forever (permanent message loss). Coerce non-finite
                // values to undefined so the mtime fallback below applies.
                // Reject future timestamps from clock skew or tampering. A
                // reservedAt far in the future produces negative age, so
                // age > TTL is always false → message stranded forever.
                // Allow a small tolerance (30s) for clock drift.
                const now = Date.now()
                reservedAt = typeof raw === "number" && Number.isFinite(raw) && raw <= now + 30_000
                    ? raw : undefined
            } catch (err) {
                // Log instead of silently skipping so unreadable or corrupt
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
                        // ENOENT is benign. Non-ENOENT leaves the orphaned
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
                // Requeue by appending to the inbox before unlinking the reserved
                // file. An append failure leaves the reserved copy for the next
                // sweep. If the append succeeds but unlink fails, pollMailbox and
                // processedIds dedup bound the duplicate risk.
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
 * Total on-disk byte size of a recipient's inbox and reserved messages.
 * Used for backpressure checks (messageUnreadMaxBytes) and measures actual
 * bytes, including max-size message bodies. Returns 0 when both are absent.
 * Cheaper than countUnreadMessages (stats only, no JSON parse).
 */
export async function unreadInboxBytes(
    teamDirectory: string,
    recipient: string,
): Promise<number> {
    let total = 0
    try {
        // unreadInboxBytes runs outside the mailbox lock; guard the
        // inbox path's ancestor chain so a symlinked <team>/mailbox (or the
        // inbox file itself) cannot redirect the stat to an external file.
        const inboxP = inboxPath(teamDirectory, recipient)
        await assertNoSymlinkTraversal(teamDirectory, inboxP)
        const stat = await fs.stat(inboxP)
        total += stat.size
    } catch (err: unknown) {
        if (!isEnoent(err)) throw err
    }
    // Include reserved directory size so in-flight messages count against
    // backpressure before their TTL expires.
    try {
        const reservedDirectory = reservedDir(teamDirectory, recipient)
        const entries = await fs.readdir(reservedDirectory)
        for (const entry of entries) {
            try {
                const reservedStat = await fs.stat(path.join(reservedDirectory, entry))
                total += reservedStat.size
            } catch { /* best-effort */ }
        }
    } catch (err: unknown) {
        if (!isEnoent(err)) throw err
    }
    return total
}

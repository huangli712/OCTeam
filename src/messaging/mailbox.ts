/**
 * File mailbox (Layer 1 of the three-layer communication model).
 *
 * Each recipient has its own append-only inbox `mailbox/{recipient}.jsonl`.
 * Broadcasts are copied into every recipient's inbox at send time (no global
 * read-flag — eliminates multi-reader bugs). Delivery uses the atomic
 * read-and-reserve protocol so the two master drainers
 * (event-handler proactive drain + Transform hook) never double-deliver.
 */

import fs from "node:fs/promises"
import path from "node:path"

import { RESERVATION_TTL_MS, atomicWrite, withLock } from "../state/locks.js"
import {
    inboxPath,
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

// --- low-level jsonl helpers ---

async function appendJsonl(filePath: string, obj: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {
        // parent may already exist
    })
    await fs.appendFile(filePath, JSON.stringify(obj) + "\n", "utf8")
}

async function readJsonl(filePath: string): Promise<Message[]> {
    try {
        const raw = await fs.readFile(filePath, "utf8")
        const lines = raw.split("\n").filter(l => l.length > 0)
        const out: Message[] = []
        for (const line of lines) {
            try {
                out.push(JSON.parse(line) as Message)
            } catch {
                // skip malformed line
            }
        }
        return out
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
        throw err
    }
}

async function truncateFile(filePath: string): Promise<void> {
    await fs.writeFile(filePath, "", "utf8").catch(err => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
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
            await atomicWrite(
                reservedPath(teamDirectory, recipient, msg.id),
                JSON.stringify({ ...msg, deliveryStatus: "delivered", reservedAt: Date.now() }),
            )
        }
        await truncateFile(inboxPath(teamDirectory, recipient))
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
    for (const msg of msgs) {
        await appendJsonl(processedPath(teamDirectory, recipient), {
            ...msg,
            deliveryStatus: "processed",
        })
        await fs.unlink(reservedPath(teamDirectory, recipient, msg.id)).catch(() => {
            // already removed
        })
    }
    // Retention: cap the audit log so it doesn't grow unbounded.
    await pruneProcessedLog(teamDirectory, recipient)
}

/**
 * Cap mailbox/{recipient}.processed.jsonl at PROCESSED_MAX_LINES entries,
 * keeping the most recent. Runs under the mailbox lock so concurrent acks and
 * the stale-reservation reaper can't race the truncate-and-rewrite. Best-effort
 * on read errors (a malformed/missing log is left untouched).
 */
async function pruneProcessedLog(teamDirectory: string, recipient: string): Promise<void> {
    return withLock(mailboxLockPath(teamDirectory, recipient), async () => {
        const p = processedPath(teamDirectory, recipient)
        let raw: string
        try {
            raw = await fs.readFile(p, "utf8")
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return
            throw err
        }
        const lines = raw.split("\n").filter(l => l.length > 0)
        if (lines.length <= PROCESSED_MAX_LINES) return
        const kept = lines.slice(lines.length - PROCESSED_MAX_LINES)
        await atomicWrite(p, kept.join("\n") + "\n")
    })
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
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return
            throw err
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
                await appendJsonl(inboxPath(teamDirectory, recipient), {
                    ...parsed,
                    deliveryStatus: "pending",
                })
                await fs.unlink(p).catch(() => {
                    // already gone
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
 * Format messages for injection as a synthetic user message. Shared by the
 * Transform hook (member delivery) and the master drain path so both routes
 * present identical formatting.
 *
 * Directive priority: messages with kind === "directive" are rendered FIRST,
 * each prefixed with a [DIRECTIVE] marker, so they take visual precedence in
 * the injected prompt. Regular messages follow after, preserving their order.
 */
export function formatMailboxInjection(msgs: Message[]): string {
    const render = (m: Message, prefix: string): string =>
        `<team_message from="${m.from}"${m.correlationId ? ` correlationId="${m.correlationId}"` : ""}>\n`
        + `${prefix}${m.body}\n</team_message>`
    // Directives first (with marker), then regular messages in original order.
    const directives = msgs.filter(m => m.kind === "directive")
    const regular = msgs.filter(m => m.kind !== "directive")
    return [
        ...directives.map(m => render(m, "[DIRECTIVE] ")),
        ...regular.map(m => render(m, "")),
    ].join("\n\n")
}

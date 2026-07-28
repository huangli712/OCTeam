/**
 * Low-level JSONL file I/O helpers — append, read, truncate, and validate
 * mailbox message lines. Shared by mailbox.ts core operations.
 */

import fs from "node:fs/promises"
import path from "node:path"

import { logger } from "../core/log.js"
import { isEnoent } from "../core/utils.js"
import { refuseSymlink } from "../state/locks.js"
import { isSafePathSegment } from "../state/paths.js"
import type { Message } from "../core/types.js"

/** Append a JSON object as a single line to filePath. */
export async function appendJsonl(filePath: string, obj: unknown, trustedRoot?: string): Promise<void> {
    await refuseSymlink(filePath, trustedRoot)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.appendFile(filePath, JSON.stringify(obj) + "\n", "utf8")
}

/**
 * Schema check for a mailbox Message. Each jsonl line is parsed and cast
 * to Message; a corrupt or tampered line can be valid JSON yet miss the
 * fields delivery/formatting dereference. Validate the required fields so
 * wrong-shape entries are skipped alongside the already-skipped malformed
 * lines.
 *
 * HIGH-E: pre-fix code only validated id/from/body, leaving to/kind/timestamp
 * unverified. A line with a non-string `to` crashed downstream path
 * operations, a non-string `kind` broke switch statements, and a non-string
 * `correlationId` (when present) crashed formatMailboxInjection's
 * String.replace call. One maliciously crafted line could block an entire
 * mailbox batch (never acked, retried forever).
 *
 * NOTE: this is a SHAPE check only, NOT an authenticity check — see mailbox.ts
 * "TRUST BOUNDARY" header comment.
 */
function isValidMessage(value: unknown): value is Message {
    if (typeof value !== "object" || value === null) return false
    const m = value as Record<string, unknown>
    // H10: version MUST be 1 (the only defined schema). A missing or
    // mismatched version indicates a tampered or forward-incompatible line.
    if (m.version !== 1) return false
    if (typeof m.id !== "string" || !isSafePathSegment(m.id)) return false
    if (typeof m.from !== "string") return false
    // H10: body length cap (32 KiB, matching the Message type contract and
    // the tool schema .max(32768)). Without this, a raw mailbox write
    // bypassing writeMailboxMessage could inject an unbounded body,
    // causing memory/context exhaustion on read.
    if (typeof m.body !== "string") return false
    if (Buffer.byteLength(m.body, "utf8") > 32768) return false
    if (typeof m.to !== "string") return false
    if (m.kind !== "message" && m.kind !== "announcement" && m.kind !== "directive") return false
    if (typeof m.timestamp !== "number" || !Number.isFinite(m.timestamp)) return false
    if (m.summary !== undefined && typeof m.summary !== "string") return false
    if (m.correlationId !== undefined && typeof m.correlationId !== "string") return false
    if (m.runId !== undefined && typeof m.runId !== "string") return false
    if (
        m.deliveryStatus !== undefined
        && m.deliveryStatus !== "pending"
        && m.deliveryStatus !== "delivered"
        && m.deliveryStatus !== "processed"
    ) {
        return false
    }
    return true
}

/** Read and parse all message lines from filePath. Returns [] on ENOENT. */
export async function readJsonl(filePath: string): Promise<Message[]> {
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
                skipped++
                continue
            }
            out.push(parsed)
        }
        if (skipped > 0) {
            logger.warn(`readJsonl: skipped ${skipped} invalid message line(s)`, { file: filePath, skipped })
        }
        return out
    } catch (err: unknown) {
        if (isEnoent(err)) return []
        throw err
    }
}

/** Truncate filePath to empty (0 bytes). Silently ignores ENOENT. */
export async function truncateFile(filePath: string, trustedRoot?: string): Promise<void> {
    await refuseSymlink(filePath, trustedRoot)
    await fs.writeFile(filePath, "", "utf8").catch(err => {
        if (!isEnoent(err)) throw err
    })
}

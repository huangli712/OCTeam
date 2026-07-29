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
    // H1: refuse non-regular files (FIFO, device). A FIFO at the mailbox
    // path would hang appendFile indefinitely, holding the mailbox lock.
    try {
        const stat = await fs.lstat(filePath)
        if (!stat.isFile()) throw new Error(`appendJsonl: not a regular file: ${filePath}`)
    } catch (err) {
        if (!isEnoent(err) && err instanceof Error && !err.message.startsWith("appendJsonl:")) throw err
        // ENOENT is fine — appendFile will create the file.
    }
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
    // H2: cap id length. The id is used as a filename component (reservation
    // files, processed entries). An id longer than NAME_MAX (255 on Linux)
    // triggers ENAMETOOLONG on every file operation, permanently wedging the
    // mailbox. 128 is far above any legitimate UUID-based id.
    if (Buffer.byteLength(m.id, "utf8") > 128) return false
    if (typeof m.from !== "string") return false
    // M-JSONL: cap string field lengths to prevent DoS. from/to/summary are
    // short identifiers or one-line text; correlationId/runId are UUIDs. A
    // tampered line with multi-MB from/correlationId would inflate the
    // injected prompt context and bypass the 32 KiB body cap.
    if (Buffer.byteLength(m.from, "utf8") > 256) return false
    if (typeof m.body !== "string") return false
    if (Buffer.byteLength(m.body, "utf8") > 32768) return false
    if (typeof m.to !== "string") return false
    if (Buffer.byteLength(m.to, "utf8") > 256) return false
    if (m.kind !== "message" && m.kind !== "announcement" && m.kind !== "directive") return false
    if (typeof m.timestamp !== "number" || !Number.isFinite(m.timestamp)) return false
    if (m.summary !== undefined && typeof m.summary !== "string") return false
    if (m.summary !== undefined && Buffer.byteLength(m.summary, "utf8") > 1024) return false
    if (m.correlationId !== undefined && typeof m.correlationId !== "string") return false
    if (m.correlationId !== undefined && Buffer.byteLength(m.correlationId, "utf8") > 256) return false
    if (m.runId !== undefined && typeof m.runId !== "string") return false
    if (m.runId !== undefined && Buffer.byteLength(m.runId, "utf8") > 256) return false
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
        // H2: cap file size before reading. A tampered or runaway JSONL file
        // (e.g. /dev/zero symlink bypassing backpressure, or multi-GB trash)
        // would OOM the process during readFile. 10 MiB matches the mailbox
        // backpressure cap; any legitimate file exceeding this is a red flag.
        const stat = await fs.lstat(filePath)
        // H1: reject non-regular files (symlinks, FIFOs, device files).
        // Pre-fix code only rejected symlinks; a FIFO or /dev/zero would
        // hang readFile forever or produce infinite output.
        if (!stat.isFile()) return []
        if (stat.size > 10_485_760) {
            logger.warn("readJsonl: file exceeds 10 MiB cap, refusing to read", { file: filePath, size: stat.size })
            return []
        }
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

/**
 * Low-level JSONL file I/O helpers — append, read, truncate, and validate
 * mailbox message lines. Shared by mailbox.ts core operations.
 */

import fs from "node:fs/promises"
import path from "node:path"

import { logger } from "../core/log.js"
import { isEnoent } from "../core/utils.js"
import { atomicWrite, refuseSymlink, safeReadFile } from "../state/locks.js"
import { isSafePathSegment } from "../state/paths.js"
import type { Message } from "../core/types.js"

/**
 * Schema check for a mailbox Message. Each jsonl line is parsed and cast
 * to Message; a corrupt or tampered line can be valid JSON yet miss the
 * fields delivery/formatting dereference. Validate the required fields so
 * wrong-shape entries are skipped alongside the already-skipped malformed
 * lines.
 *
 * Validate every field consumed by downstream code. A non-string `to` crashes
 * path operations, a non-string `kind` breaks switch statements, and a non-string
 * `correlationId` (when present) crashes formatMailboxInjection's
 * String.replace call. One maliciously crafted line could block an entire
 * mailbox batch (never acked, retried forever).
 *
 * NOTE: this is a SHAPE check only, NOT an authenticity check — see mailbox.ts
 * "TRUST BOUNDARY" header comment.
 */
function isValidMessage(value: unknown): value is Message {
    if (typeof value !== "object" || value === null) return false
    const m = value as Record<string, unknown>
    // Version MUST be 1 (the only defined schema). A missing or
    // mismatched version indicates a tampered or forward-incompatible line.
    if (m.version !== 1) return false
    if (typeof m.id !== "string" || !isSafePathSegment(m.id)) return false
    // Cap id length because it is used as a filename component (reservation
    // files, processed entries). An id longer than NAME_MAX (255 on Linux)
    // triggers ENAMETOOLONG on every file operation, permanently wedging the
    // mailbox. 128 is far above any legitimate UUID-based id.
    if (Buffer.byteLength(m.id, "utf8") > 128) return false
    if (typeof m.from !== "string") return false
    // Cap string field lengths to prevent DoS. from/to/summary are
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
    // Message.deliveryStatus is a required field, but a JSONL line written
    // before that requirement (or hand-edited) may omit it. Normalize
    // undefined to "pending" so the type assertion (value is Message) is
    // sound.
    if (m.deliveryStatus === undefined) {
        m.deliveryStatus = "pending"
    }
    return true
}

/** Append a JSON object as a single line to filePath. */
export async function appendJsonl(filePath: string, obj: unknown, trustedRoot?: string): Promise<void> {
    await refuseSymlink(filePath, trustedRoot)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    // An fd-based open with O_NOFOLLOW|O_NONBLOCK|O_APPEND rejects leaf
    // symlinks and FIFOs. stat-on-fd eliminates TOCTOU between check and
    // write. handle.appendFile uses the same fd for atomic verify+write.
    const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
    const nonBlock = (fs.constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow | nonBlock
    const handle = await fs.open(filePath, flags)
    try {
        const stat = await handle.stat()
        if (!stat.isFile()) throw new Error(`appendJsonl: not a regular file: ${filePath}`)
        await handle.appendFile(Buffer.from(JSON.stringify(obj) + "\n", "utf8"))
    } finally {
        await handle.close().catch((err: unknown) => {
            logger.warn("appendJsonl: failed to close file handle", { filePath, error: err instanceof Error ? err.message : String(err) })
        })
    }
}

/** Read and parse all message lines from filePath. Returns [] on ENOENT. */
export async function readJsonl(filePath: string, trustedRoot?: string): Promise<Message[]> {
    try {
        const raw = await safeReadFile(trustedRoot ?? path.dirname(filePath), filePath, { maxBytes: 10_485_760 })
        if (raw === undefined) return []
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
    const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
    const nonBlock = (fs.constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
        handle = await fs.open(filePath, fs.constants.O_WRONLY | noFollow | nonBlock)
        const stat = await handle.stat()
        if (!stat.isFile()) throw new Error(`truncateFile: not a regular file: ${filePath}`)
    } catch (err) {
        if (!isEnoent(err)) throw err
    } finally {
        await handle?.close()
    }
    await atomicWrite(filePath, "", trustedRoot ?? path.dirname(filePath)).catch(err => {
        if (!isEnoent(err)) throw err
    })
}

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
 * Minimal top-level schema check for a mailbox Message. Each jsonl line is
 * parsed and cast to Message; a corrupt or tampered line can be valid JSON yet
 * miss the fields delivery/formatting dereference. Validate just id/from/body so
 * wrong-shape entries are skipped alongside the already-skipped malformed lines.
 *
 * NOTE: this is a SHAPE check only, NOT an authenticity check — see mailbox.ts
 * "TRUST BOUNDARY" header comment.
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

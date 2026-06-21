/**
 * TEMPORARY diagnostic logger for issue #1 (master not notified on completion).
 * Appends one JSON line per event to /tmp/octeam-diag.log. Best-effort, never
 * throws, fire-and-forget. DELETE THIS FILE and remove all diag() calls once the
 * root cause is confirmed.
 */
import fs from "node:fs/promises"

const DIAG_LOG = "/tmp/octeam-diag.log"

export function diag(tag: string, data: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ t: new Date().toISOString(), tag, ...data }) + "\n"
    void fs.appendFile(DIAG_LOG, line).catch(() => {
        // best-effort — diagnostics must never disrupt orchestration
    })
}

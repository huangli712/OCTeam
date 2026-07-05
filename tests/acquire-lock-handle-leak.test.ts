/**
 * Regression test for confirmed finding "acquire-lock-handle-leak".
 *
 * Bug: src/state/locks.ts:149-151 — acquireLock opens the lock file with
 *   `const fh = await fs.open(lockPath, "wx")`
 *   `await fh.writeFile(String(process.pid))`
 *   `await fh.close()`
 * with NO try/finally. If `writeFile` (or `close`) throws — disk full, I/O
 * error, etc. — the error is non-EEXIST so it propagates at locks.ts:155,
 * but:
 *   1. the file handle `fh` is never closed (leaked until GC), and
 *   2. the lock file created at :149 is never unlinked (orphaned on disk).
 *
 * Harm of the orphan: the next withLock caller on the same lockPath hits
 * EEXIST at :149, sees a FRESH mtime (just created), so the stale-reap guard
 * (:159, requires mtime > LOCK_TTL_MS old) refuses to touch it — the caller
 * spins on LOCK_POLL_MS until the 30s deadline, then throws a timeout. A
 * single transient write failure thus wedges that lock (and every state.json
 * write it guards) for 30 seconds.
 *
 * Fix: wrap :149-151 in try/finally — close the handle unconditionally, and
 * on failure unlink the partial lock file before rethrowing.
 *
 * Mocking strategy: node:fs/promises is pre-cached by bun's runtime, so
 * mock.module must (a) include a `default` export (locks.ts does
 * `import fs from "node:fs/promises"`) and (b) be in effect before locks.ts
 * is imported. We achieve (b) with a dynamic `await import` of locks.js
 * AFTER mock.module registers, wrapping the real FileHandle so writeFile
 * throws on the lock-acquire path. A runtime flag gates the failure so other
 * test files (which never set it) get real behavior.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"

// --- Load the REAL node:fs/promises BEFORE mock.module registers so every
//     export except `open` keeps its real implementation. ---
const require = createRequire(import.meta.url)
const realFs = require("node:fs/promises") as typeof import("node:fs/promises")

let failLockWrite = false
let lockHandleCloseCount = 0

const mockedFs = {
    ...realFs,
    open: (async (...args: Parameters<typeof realFs.open>) => {
        const handle = await realFs.open(...args)
        const [p, flags] = args
        // Only intercept the lock-acquire path: ".lock" file opened with "wx".
        // acquireLock is the sole caller matching this shape, and it uses only
        // writeFile + close on the handle, so a minimal wrapper suffices.
        if (typeof p === "string" && p.endsWith(".lock") && flags === "wx") {
            return {
                writeFile: async (...w: Parameters<typeof handle.writeFile>) => {
                    if (failLockWrite) {
                        throw new Error("simulated writeFile failure (lock acquire)")
                    }
                    return handle.writeFile(...w)
                },
                close: async () => {
                    lockHandleCloseCount++
                    return handle.close()
                },
            }
        }
        return handle
    }) as typeof realFs.open,
}

// `default` is required: locks.ts does `import fs from "node:fs/promises"`.
mock.module("node:fs/promises", () => ({ ...mockedFs, default: mockedFs }))

// Dynamic import AFTER mock.module so locks.ts resolves the MOCKED fs.
const { withLock } = await import("../src/state/locks.js")

import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

async function pathExists(p: string): Promise<boolean> {
    try {
        await realFs.access(p)
        return true
    } catch {
        return false
    }
}

afterEach(() => {
    failLockWrite = false
})
afterAll(cleanupTmpRoots)

describe("acquireLock handle/file leak (finding: acquire-lock-handle-leak)", () => {
    test("writeFile failure must not leak the file handle or leave the lock file", async () => {
        const root = tmpRoot("lock-handle-leak")
        const lockPath = `${root}/state.json.lock`
        lockHandleCloseCount = 0

        // Force fh.writeFile to throw immediately after fs.open("wx") already
        // created the lock file — reproducing a disk-full / I/O failure
        // mid-acquire at locks.ts:150.
        failLockWrite = true

        // withLock must propagate the failure (non-EEXIST error at :155).
        await expect(
            withLock(lockPath, async () => {
                throw new Error("critical section must never run when acquire failed")
            }),
        ).rejects.toThrow("simulated writeFile failure")

        // --- BUG (unfixed): acquireLock has no finally, so fh.close() at
        //     locks.ts:151 is never reached and the lock file created at
        //     locks.ts:149 stays on disk, wedging future callers.
        // --- FIXED: a finally closes the handle and rolls back the partial
        //     lock file before rethrowing.

        // Assertion 1: the partial lock file must be cleaned up (no orphan).
        expect(await pathExists(lockPath)).toBe(false)

        // Assertion 2: the file handle must have been closed (no leak).
        expect(lockHandleCloseCount).toBeGreaterThan(0)
    })
})

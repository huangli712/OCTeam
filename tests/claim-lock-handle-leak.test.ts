/**
 * Regression test for confirmed finding "claim-lock-handle-leak".
 *
 * Bug: src/state/tasks.ts:268-270 (and the retry at :281-283) — claimTask
 * acquires the persistent claim lock with NO try/finally:
 *   `const fh = await fs.open(lockPath, "wx")`   // :268 / :281 — creates file
 *   `await fh.writeFile(owner)`                   // :269 / :282
 *   `await fh.close()`                            // :270 / :283
 * If writeFile or close throws (disk full, I/O error), the catch at :271
 * checks `code !== "EEXIST"` and rethrows — but:
 *   1. the file handle `fh` is never closed (leaked until GC), and
 *   2. the claim lock file created at :268 is never unlinked (orphaned).
 *
 * Contrast: acquireLock in locks.ts:149-160 was ALREADY fixed (try/finally)
 * for finding "acquire-lock-handle-leak". But claimTask's OWN direct fs.open
 * at tasks.ts:268/:281 does NOT go through acquireLock — it has its own
 * unguarded open/writeFile/close sequence, so the same handle-leak class of
 * bug persists here independently.
 *
 * Harm of the orphan: the next claimTask caller on the same taskId hits
 * EEXIST at :268, then lockFresh (:273) sees a FRESH lock (< CLAIM_TTL_MS)
 * and throws TaskAlreadyClaimedError — wedging the task for 30s even though
 * no member actually holds it.
 *
 * Fix: wrap :268-270 (and :281-283) in try/finally — close the handle
 * unconditionally, and on failure unlink the partial claim lock before
 * rethrowing.
 *
 * Mocking strategy: node:fs/promises is pre-cached by bun's runtime, so
 * mock.module must (a) include a `default` export (tasks.ts and locks.ts
 * both do `import fs from "node:fs/promises"`) and (b) be in effect before
 * tasks.ts is imported. We wrap fs.open so that only the claim-lock path
 * (tasks/claims/{uuid}.lock) returns a handle whose writeFile throws. Other
 * ".lock" opens (claim-mutex.lock via withLock/acquireLock,
 * {uuid}.update.lock via withLock) pass through to the real implementation,
 * so claimTask's own claimMutex acquisition and updateTask locking work
 * normally.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"

// --- Load the REAL node:fs/promises BEFORE mock.module registers so every
//     export except `open` keeps its real implementation. ---
const require = createRequire(import.meta.url)
const realFs = require("node:fs/promises") as typeof import("node:fs/promises")

let failClaimLockWrite = false
let claimLockHandleCloseCount = 0

// Match ONLY the claim lock path: tasks/claims/{uuid}.lock.
// Excludes {uuid}.update.lock (suffix before .lock is "update", not a UUID)
// and claim-mutex.lock (basename is "claim-mutex", not a UUID).
const CLAIM_LOCK_RE =
    /claims[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock$/

const mockedFs = {
    ...realFs,
    open: (async (...args: Parameters<typeof realFs.open>) => {
        const handle = await realFs.open(...args)
        const [p, flags] = args
        // Intercept only the claim-lock acquisition path: a UUID-shaped
        // .lock file under claims/, opened with "wx". claimTask:268/:281 is
        // the sole caller matching this shape; it uses only writeFile + close
        // on the handle, so a minimal wrapper suffices.
        if (
            failClaimLockWrite
            && typeof p === "string"
            && CLAIM_LOCK_RE.test(p)
            && flags === "wx"
        ) {
            return {
                writeFile: async (..._w: Parameters<typeof handle.writeFile>) => {
                    throw new Error(
                        "simulated writeFile failure (claim lock acquire)",
                    )
                },
                close: async () => {
                    claimLockHandleCloseCount++
                    return handle.close()
                },
            }
        }
        return handle
    }) as typeof realFs.open,
}

// `default` is required: tasks.ts and locks.ts do `import fs from`.
mock.module("node:fs/promises", () => ({ ...mockedFs, default: mockedFs }))

// Dynamic import AFTER mock.module so tasks.ts resolves the MOCKED fs.
const { claimTask, createTask } = await import("../src/state/tasks.js")
import { claimLockPath } from "../src/state/paths.js"

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
    failClaimLockWrite = false
})
afterAll(cleanupTmpRoots)

describe("claimTask lock handle leak (finding: claim-lock-handle-leak)", () => {
    test("claim-lock writeFile failure must not leak the handle or leave the lock file", async () => {
        const root = tmpRoot("claim-lock-leak")
        const dir = `${root}/team` // simulated team directory

        // --- Fixture: create a pending task under the team dir (uses real
        //     fs paths — createTask's atomicWrite path does not match the
        //     claim-lock intercept, so it works normally). ---
        const task = await createTask(dir, {
            subject: "reproduce claim-lock leak",
            description: "fixture task",
        })
        const lockPath = claimLockPath(dir, task.id)
        claimLockHandleCloseCount = 0

        // Force the claim-lock FileHandle.writeFile to throw immediately
        // after fs.open("wx") already created the lock file — reproducing a
        // disk-full / I/O failure mid-claim-acquire at tasks.ts:269.
        failClaimLockWrite = true

        // claimTask must propagate the failure (non-EEXIST error at :272).
        await expect(
            claimTask(dir, task.id, "alice"),
        ).rejects.toThrow("simulated writeFile failure")

        // --- BUG (unfixed): tasks.ts:268-270 has no try/finally, so
        //     fh.close() at :270 is never reached and the claim lock file
        //     created at :268 stays on disk, wedging future claimTask
        //     callers within the CLAIM_TTL window.
        // --- FIXED: a finally closes the handle and rolls back the partial
        //     claim lock file before rethrowing.

        // Assertion 1: the partial claim lock file must be cleaned up.
        expect(await pathExists(lockPath)).toBe(false)

        // Assertion 2: the file handle must have been closed (no leak).
        expect(claimLockHandleCloseCount).toBeGreaterThan(0)
    })
})

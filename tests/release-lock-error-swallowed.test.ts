/**
 * Regression test for the lock-release error contract.
 *
 * History: releaseLock originally swallowed ALL unlink failures
 * (.catch(()=>{})), including non-ENOENT errors. That was fixed to only
 * swallow ENOENT and rethrow everything else.
 *
 * Subsequent audit (C1, 2026-07-26) found that rethrowing release errors
 * AFTER fn() already succeeded causes a worse bug: callers misinterpret the
 * release error as a work failure and roll back in-memory state that
 * correctly matches disk, causing memory/disk divergence.
 *
 * Current correct contract:
 *   - fn() succeeds + release fails → withLock RESOLVES with fn's value.
 *     The release error is logged (logger.warn) so it is surfaced, not
 *     silently swallowed. The stale-lock reaper recovers the stuck lock.
 *   - fn() fails + release succeeds → fn's error propagates normally.
 *   - fn() fails + release fails → fn's error propagates (release logged).
 *
 * This test verifies the first case: fn() succeeds, releaseLock throws EPERM,
 * and withLock resolves with fn's return value instead of rejecting.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"

// --- Load the REAL node:fs/promises BEFORE mock.module registers so every
//     export except `unlink` keeps its real implementation. ---
const require = createRequire(import.meta.url)
const realFs = require("node:fs/promises") as typeof import("node:fs/promises")

let failLockRelease = false

const mockedFs = {
    ...realFs,
    unlink: (async (p: string) => {
        // Only intercept the release path: ".lock" files. acquireLock's own
        // unlink calls (stale-reap at :183, writeFile-failure cleanup at :156)
        // do not execute during this test (fresh acquire, no stale reap, no
        // write failure), so the intercept is reached solely by releaseLock.
        if (failLockRelease && typeof p === "string" && p.endsWith(".lock")) {
            const err = new Error(
                `EPERM: simulated release failure: unlink '${p}'`,
            ) as NodeJS.ErrnoException
            err.code = "EPERM"
            throw err
        }
        return (realFs.unlink as typeof realFs.unlink)(p)
    }) as typeof realFs.unlink,
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
    failLockRelease = false
})
afterAll(cleanupTmpRoots)

describe("releaseLock error contract (finding: release-lock-error-swallowed + C1 audit)", () => {
    test("fn() result preserved when release fails: release error logged, not propagated", async () => {
        const root = tmpRoot("lock-release-swallowed")
        const lockPath = `${root}/state.json.lock`

        // Critical section marker — proves the section ran and the failure is
        // specifically in the release (finally), not the guarded work.
        let criticalRan = false

        // Force fs.unlink to throw EPERM for ".lock" paths. acquireLock does
        // not call unlink on the fresh-acquire path, so this is reached only
        // by releaseLock in withLock's finally.
        failLockRelease = true

        // C1 audit fix: fn() already succeeded, so the release error must NOT
        // propagate — the caller would misinterpret it as a work failure and
        // roll back in-memory state that correctly matches disk. The error is
        // logged via logger.warn instead.
        const result = await withLock(lockPath, async () => {
            criticalRan = true
            return "done"
        })

        // fn() ran and its result is preserved.
        expect(criticalRan).toBe(true)
        expect(result).toBe("done")

        // Evidence of the residual harm: the failed release left the lock
        // file on disk with this process's pid (a fresh live-owner lock).
        // The stale-reap guard refuses it, so the next caller would spin to
        // the 30s timeout. The stale-lock reaper eventually cleans it up.
        expect(await pathExists(lockPath)).toBe(true)
    })
})

/**
 * Regression test for confirmed finding "release-lock-error-swallowed".
 *
 * Bug: src/state/locks.ts:220 — releaseLock does
 *   `await fs.unlink(lockPath).catch(() => { /* raced *\/ })`
 * swallowing ALL unlink failures, not just the legitimate ENOENT race.
 * A non-ENOENT failure (EPERM, EBUSY, EROFS, ...) leaves the lock file on
 * disk still recording THIS process's pid, yet withLock resolves as if the
 * release succeeded.
 *
 * Harm: the next withLock caller on the same lockPath hits EEXIST at :149,
 * then the stale-reap guard at :168 (requires mtime > LOCK_TTL_MS old) AND
 * :176/:182 (refuses a live owner pid) BOTH refuse to touch the fresh
 * live-owner lock — so the caller spins on LOCK_POLL_MS until the 30s
 * deadline (:193) and throws a timeout. A single transient unlink failure
 * thus wedges that lock (and every state.json write it guards) for 30
 * seconds, with the caller never learning the release failed.
 *
 * Likely fix: only swallow ENOENT (the documented race), rethrow every
 * other errno so the release failure surfaces through withLock's finally.
 *
 * This test mocks node:fs/promises so fs.unlink throws EPERM for ".lock"
 * paths during release. It asserts that withLock does NOT silently succeed
 * when its release fails — the error must propagate.
 *   UNFIXED: .catch(()=>{}) swallows EPERM → withLock resolves normally
 *            → the rejects assertion FAILS.
 *   FIXED:   non-ENOENT error propagates from releaseLock through the
 *            finally → withLock rejects → the assertion PASSES.
 *
 * Mocking notes: node:fs/promises is pre-cached by bun's runtime, so
 * mock.module must (a) include a `default` export (locks.ts does
 * `import fs from "node:fs/promises"`) and (b) be in effect before locks.ts
 * is imported, achieved via a dynamic `await import` after mock.module.
 * The EPERM throw is flag-gated so other test files get real unlink behavior.
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

describe("releaseLock error swallowed (finding: release-lock-error-swallowed)", () => {
    test("non-ENOENT unlink failure during release must surface, not be swallowed", async () => {
        const root = tmpRoot("lock-release-swallowed")
        const lockPath = `${root}/state.json.lock`

        // Critical section marker — proves the section ran and the failure is
        // specifically in the release (finally), not the guarded work.
        let criticalRan = false

        // Force fs.unlink to throw EPERM for ".lock" paths. acquireLock does
        // not call unlink on the fresh-acquire path, so this is reached only
        // by releaseLock in withLock's finally.
        failLockRelease = true

        // --- UNFIXED: releaseLock's .catch(()=>{}) swallows the EPERM →
        //     withLock resolves with "done" → the rejects assertion FAILS.
        // --- FIXED: non-ENOENT error propagates from releaseLock through the
        //     finally → withLock rejects → the assertion PASSES. ---
        expect(
            withLock(lockPath, async () => {
                criticalRan = true
                return "done"
            }),
        ).rejects.toThrow(/EPERM/)

        // The critical section MUST have run — proves the failure is in the
        // release, not a trivial acquire error (different bug).
        expect(criticalRan).toBe(true)

        // Evidence of the harm: the failed release left the lock file on disk
        // with this process's pid (a fresh live-owner lock). The stale-reap
        // guard at locks.ts:168/:182 will refuse it, so the next caller would
        // spin to the 30s timeout. (This assertion passes on both fixed and
        // unfixed since unlink genuinely failed; it documents the harm.)
        expect(await pathExists(lockPath)).toBe(true)
    })
})

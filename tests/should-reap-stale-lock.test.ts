/**
 * Pure-core unit tests for the exported shouldReapStaleLock policy helper.
 * acquireLock intentionally does not call it because deciding from lock
 * metadata and then unlinking cannot be made atomic. The helper remains pure,
 * so it can be tested directly without filesystem or pid state.
 *
 * Decision contract (the mutual-exclusion invariant): a lock is reaped ONLY
 * when its mtime strictly exceeds the TTL AND the owner process is confirmed
 * dead. A live holder's lock is never reaped, even if the mtime is stale
 * (heartbeat glitch tolerance).
 */
import { describe, expect, test } from "bun:test"

import { shouldReapStaleLock } from "../src/state/locks.js"

describe("shouldReapStaleLock", () => {
    test("stale mtime + dead owner → reap (true)", () => {
        expect(shouldReapStaleLock(0, 1000, 100, false)).toBe(true)
    })

    test("stale mtime + ALIVE owner → do NOT reap (mutual exclusion preserved)", () => {
        expect(shouldReapStaleLock(0, 1000, 100, true)).toBe(false)
    })

    test("fresh mtime + dead owner → do NOT reap (not stale yet)", () => {
        expect(shouldReapStaleLock(950, 1000, 100, false)).toBe(false)
    })

    test("fresh mtime + alive owner → do NOT reap", () => {
        expect(shouldReapStaleLock(950, 1000, 100, true)).toBe(false)
    })

    test("mtime age == ttl is NOT stale (strict >) even with dead owner", () => {
        // now - mtimeMs == ttl exactly → boundary, not reaped
        expect(shouldReapStaleLock(900, 1000, 100, false)).toBe(false)
    })

    test("mtime age == ttl+1 with dead owner → reap", () => {
        expect(shouldReapStaleLock(899, 1000, 100, false)).toBe(true)
    })

    test("alive owner dominates regardless of staleness", () => {
        // Even wildly stale, a live owner is never reaped.
        expect(shouldReapStaleLock(0, 1_000_000, 100, true)).toBe(false)
    })
})

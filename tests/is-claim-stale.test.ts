/**
 * Pure-core unit tests for isClaimStale: the stale-claim decision extracted
 * from reapStaleClaims. The function is pure (no IO), so it can be tested
 * directly without any filesystem or lock state.
 *
 * Decision contract: a claim is stale iff the lock is NOT fresh AND the
 * claimedAt age strictly exceeds the TTL (age == ttl is NOT stale).
 */

import { describe, expect, test } from "bun:test"

import { isClaimStale } from "../src/state/tasks.js"

describe("isClaimStale", () => {
    test("fresh lock dominates regardless of age", () => {
        expect(isClaimStale(true, 0, 1000, 100)).toBe(false)
    })

    test("fresh=true with any age is never stale", () => {
        expect(isClaimStale(true, 0, 1_000_000, 1)).toBe(false)
    })

    test("not fresh, age < ttl is not stale", () => {
        expect(isClaimStale(false, 0, 50, 100)).toBe(false)
    })

    test("not fresh, age == ttl is NOT stale (strict >)", () => {
        expect(isClaimStale(false, 0, 100, 100)).toBe(false)
    })

    test("not fresh, age == ttl+1 is stale", () => {
        expect(isClaimStale(false, 0, 101, 100)).toBe(true)
    })

    test("not fresh, age >> ttl is stale", () => {
        expect(isClaimStale(false, 0, 1000, 100)).toBe(true)
    })
})

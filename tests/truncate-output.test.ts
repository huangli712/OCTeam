import { describe, expect, test } from "bun:test"

import { truncateOutput } from "../src/core/utils.js"

// Regression coverage for the end-marker-loss bug: the old head-only cut dropped
// any deliverable marker placed at the END of a member turn exceeding maxBytes,
// so the reducer received a head with no markers and reported the member's
// result as "unavailable / truncated before final markers". The fix preserves
// both head and tail at the same byte budget.

describe("truncateOutput: short input passthrough", () => {
    test("input at or under maxBytes is returned unchanged", () => {
        const text = "x".repeat(8192)
        expect(truncateOutput(text)).toBe(text)
        expect(truncateOutput("short")).toBe("short")
    })

    test("empty string passes through", () => {
        expect(truncateOutput("")).toBe("")
    })
})

describe("truncateOutput: head + tail preservation", () => {
    test("keeps both a head sentinel and a tail sentinel", () => {
        const maxBytes = 8192
        const head = "HEAD_SENTINEL_" + "a".repeat(6000)
        const middle = "m".repeat(4000)
        const tail = "b".repeat(3000) + "_TAIL_SENTINEL"
        const text = head + middle + tail // > maxBytes

        const out = truncateOutput(text, maxBytes)
        expect(out).toContain("HEAD_SENTINEL_")
        expect(out).toContain("_TAIL_SENTINEL")
        expect(out).toContain("truncated")
        // Total bytes must not exceed the budget.
        expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(maxBytes)
    })

    test("the end-marker (the regression scenario) survives truncation", () => {
        // Mirrors the sort-bench prompt convention: deliverable markers pinned
        // to the END of a turn that exceeds 8KB. The old head-only cut dropped
        // all four markers; head+tail must keep them.
        const body = "x".repeat(12000) // well over 8KB
        const markers =
            "\n<!-- SORT_OK: true -->\n" +
            "<!-- TIME_RANDOM: 123.381 -->\n" +
            "<!-- TIME_NEARLY: 30.247 -->\n" +
            "<!-- TIME_REVERSE: 15.229 -->"
        const text = body + markers

        const out = truncateOutput(text, 8192)
        expect(out).toContain("<!-- SORT_OK: true -->")
        expect(out).toContain("<!-- TIME_RANDOM: 123.381 -->")
        expect(out).toContain("<!-- TIME_NEARLY: 30.247 -->")
        expect(out).toContain("<!-- TIME_REVERSE: 15.229 -->")
        expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(8192)
    })

    test("respects a custom maxBytes budget", () => {
        const text = "h".repeat(400) + "MIDDLE" + "t".repeat(400)
        const out = truncateOutput(text, 200)
        expect(out.startsWith("h")).toBe(true)
        expect(out.endsWith("t")).toBe(true)
        expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200)
    })

    test("head and tail never overlap for input just over maxBytes", () => {
        // Boundary: input is exactly maxBytes + 1. Head and tail windows must
        // not overlap (would duplicate content / exceed budget).
        const maxBytes = 8192
        const text = "a".repeat(maxBytes) + "Z" // maxBytes + 1 bytes
        const out = truncateOutput(text, maxBytes)
        expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(maxBytes)
        expect(out).toContain("truncated")
    })
})

describe("truncateOutput: UTF-8 character boundaries", () => {
    test("CJK (3-byte) sequences are never split", () => {
        // Each 你/好/世/界 is 3 UTF-8 bytes. Fill well past the cut point so
        // both head and tail boundaries land inside CJK runs.
        const head = "开".repeat(2000) // 6000 bytes of CJK
        const middle = "m".repeat(4000)
        const tail = "界".repeat(2000) + "END"
        const text = head + middle + tail

        const out = truncateOutput(text, 8192)
        // No stray replacement char / split lead byte => the result must
        // round-trip cleanly and contain only valid CJK at both ends.
        expect(out.startsWith("开")).toBe(true)
        expect(out).toContain("END")
        expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(8192)
    })

    test("emoji (4-byte) sequences are never split", () => {
        const head = "👾".repeat(1500) // 6000 bytes of 4-byte emoji
        const middle = "m".repeat(4000)
        const tail = "🚀".repeat(1500)
        const text = head + middle + tail

        const out = truncateOutput(text, 8192)
        expect(out.startsWith("👾")).toBe(true)
        expect(out.endsWith("🚀")).toBe(true)
        expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(8192)
    })
})

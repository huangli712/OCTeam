/**
 * Regression test: workflow retry_on.regex must resist ReDoS
 * (catastrophic backtracking) attacks.
 *
 * Bug: src/orchestration/workflow/handler.ts shouldRetryTask() runs
 * `new RegExp(step.retryOn.pattern).test(cappedOutput)` synchronously on
 * the event loop. V8 has polynomial-time mitigations for some patterns,
 * but even with those, a nested-quantifier pattern on a 100KB input blocks
 * the event loop for 500ms+. A crafted pattern can block sweep timers,
 * wall-clock timeout enforcement, and other teams' orchestration.
 *
 * The pattern comes from a workflow_file which a member with .octeam/ FS
 * write access can tamper with — so the threat model is hostile input.
 *
 * Fix: (1) reject patterns containing nested quantifiers (the canonical
 * ReDoS signature) before compiling; (2) cap the input at a smaller bound
 * (10KB instead of 100KB) to limit the worst case for patterns that slip
 * through the heuristic; (3) cap pattern length so a giant pattern cannot
 * itself be a vector.
 */

import { describe, expect, test } from "bun:test"

import { shouldRetryTask } from "../src/orchestration/workflow/handler.js"
import type { WorkflowTaskStep } from "../src/core/types/workflow.js"

function stepWithRegex(pattern: string): WorkflowTaskStep {
    return {
        kind: "task",
        member: "x",
        task: "do thing",
        retryOn: { kind: "regex", pattern },
    } as WorkflowTaskStep
}

describe("retry_on.regex resists ReDoS patterns", () => {
    test("nested quantifier pattern (a+)+ is rejected before compilation", () => {
        const s = stepWithRegex("(a+)+b")
        // Use a MATCHING input: if the pattern is compiled and tested,
        // it returns true (match found). If the pattern is REJECTED by
        // the ReDoS guard, shouldRetryTask returns false without compiling.
        const matching = "aaab"
        // Pre-fix: pattern compiles, finds match → returns true.
        // Post-fix: pattern is rejected → returns false.
        const result = shouldRetryTask(s, matching)
        expect(result).toBe(false)
    })

    test("nested quantifier pattern (.+)* is rejected before compilation", () => {
        const s = stepWithRegex("(.+)*b")
        // Input matches if compiled; false if rejected.
        expect(shouldRetryTask(s, "xyzb")).toBe(false)
    })

    test("nested quantifier ([a-z]+)+ is rejected", () => {
        const s = stepWithRegex("([a-z]+)+$")
        // Input "abc" matches if compiled; false if rejected.
        expect(shouldRetryTask(s, "abc")).toBe(false)
    })

    test("bounded nested quantifier (a{1,3})+ is rejected", () => {
        const s = stepWithRegex("(a{1,3})+$")
        // Input "aaa" matches if compiled; false if rejected.
        expect(shouldRetryTask(s, "aaa")).toBe(false)
    })

    test("control: a safe, well-behaved pattern still matches", () => {
        const s = stepWithRegex("error:\\s*(\\w+)")
        const output = "error: something failed"
        expect(shouldRetryTask(s, output)).toBe(true)
    })

    test("control: a safe pattern that does NOT match returns false", () => {
        const s = stepWithRegex("error:\\s*(\\w+)")
        const output = "no errors here"
        expect(shouldRetryTask(s, output)).toBe(false)
    })

    test("control: anchored literal pattern is safe and fast", () => {
        const s = stepWithRegex("^TODO:")
        expect(shouldRetryTask(s, "TODO: fix me")).toBe(true)
        expect(shouldRetryTask(s, "not a todo")).toBe(false)
    })

    test("pattern length cap: excessively long pattern is rejected", () => {
        const longPattern = "a".repeat(300)
        const s = stepWithRegex(longPattern)
        expect(shouldRetryTask(s, "a".repeat(100))).toBe(false)
    })
})

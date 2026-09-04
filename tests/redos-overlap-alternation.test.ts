/**
 * Regression: hasNestedQuantifier only detected nested quantifiers like
 * (a+)+. It missed alternation-overlap patterns like (a|aa)+$ which have
 * exponential backtracking on adversarial input ("aaaaaaaaaaaaaaaaaaaaaaaaaaaa"
 * followed by a non-matching char). 45 such chars + X blocked the event loop
 * for ~500ms with the pre-fix heuristic.
 *
 * The fix extends the heuristic to detect alternation-under-quantifier where
 * any branch is a string-prefix of another (the canonical overlap signature).
 */
import { describe, expect, test } from "bun:test"

import { shouldRetryTask } from "../src/orchestration/workflow/handler.js"
import type { WorkflowTaskStep } from "../src/core/types.js"

function regexStep(pattern: string): WorkflowTaskStep {
    return {
        kind: "task",
        member: "alice",
        task: "t",
        retryOn: { kind: "regex", pattern },
        maxTaskRetries: 1,
        taskAttempts: 0,
        completed: false,
    } as unknown as WorkflowTaskStep
}

describe("shouldRetryTask ReDoS heuristic", () => {
    test("happy path: legitimate regex still matches", () => {
        const step = regexStep("^fail")
        expect(shouldRetryTask(step, "failed to complete")).toBe(true)
    })

    test("happy path: legitimate alternation regex matches", () => {
        const step = regexStep("(foo|bar)")
        expect(shouldRetryTask(step, "send bar now")).toBe(true)
        expect(shouldRetryTask(step, "send baz now")).toBe(false)
    })

    test("happy path: quantified non-overlapping alternation is allowed", () => {
        // (foo|bar)+ — branches share no prefix overlap; legitimate.
        const step = regexStep("(foo|bar)+")
        expect(shouldRetryTask(step, "foofoobar")).toBe(true)
    })

    test("rejects (a+)+ nested quantifier (existing protection)", () => {
        const step = regexStep("(a+)+$")
        const input = "a".repeat(40) + "X"
        const start = Date.now()
        const result = shouldRetryTask(step, input)
        const elapsed = Date.now() - start
        expect(result).toBe(false)
        expect(elapsed).toBeLessThan(100)
    })

    test("rejects (a|aa)+$ overlap-alternation quickly", () => {
        const step = regexStep("(a|aa)+$")
        const input = "a".repeat(45) + "X"
        const start = Date.now()
        const result = shouldRetryTask(step, input)
        const elapsed = Date.now() - start
        expect(result).toBe(false)
        // Pre-fix this took ~500ms (catastrophic backtracking). With the
        // overlap-alternation heuristic it must reject in <100ms.
        expect(elapsed).toBeLessThan(100)
    })

    test("rejects (a|ab)+ overlap-alternation quickly", () => {
        const step = regexStep("(a|ab)+$")
        const input = "ab".repeat(25) + "X"
        const start = Date.now()
        const result = shouldRetryTask(step, input)
        const elapsed = Date.now() - start
        expect(result).toBe(false)
        expect(elapsed).toBeLessThan(100)
    })

    test("rejects (.|.<any>)+ generalized overlap quickly", () => {
        // (a.)+ on partial input — branches a. and a.a overlap on "a" followed
        // by anything. Use a pattern with quantified alternation overlap that
        // does NOT match the input, forcing full backtracking.
        const step = regexStep("(a.|ab)+$")
        const input = "ab".repeat(20) + "X"
        const start = Date.now()
        const result = shouldRetryTask(step, input)
        const elapsed = Date.now() - start
        expect(result).toBe(false)
        expect(elapsed).toBeLessThan(100)
    })
})

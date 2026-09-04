/**
 * Regression test: a gate's `where` condition that requires a field
 * the verdict did not provide must route to INVALID (verifier error), not
 * silently evaluate to "condition=false".
 *
 * Bug: src/orchestration/workflow/gate.ts matchesWorkflowCondition returns
 * false when input.score/confidence is undefined. gatedGotoIndex uses this
 * boolean directly: a gate with `where: score_gte` whose verifier omitted
 * `score` from the verdict looks like "condition did not match" (no jump),
 * rather than "condition was unevaluable" (INVALID). The workflow then
 * silently proceeds to the gate's default successor instead of surfacing
 * the verifier's contract violation.
 *
 * Fix: gatedGotoIndex returns a tri-state result when `where` is set:
 *   - "matches" → jump to gotoIndex
 *   - "does_not_match" → do not jump (verifier gave the field, condition false)
 *   - "unevaluable" → route to INVALID (verifier omitted a required field)
 */

import { describe, expect, test } from "bun:test"

import { matchesWorkflowCondition } from "../src/orchestration/workflow/gate.js"
import type { WorkflowCondition } from "../src/core/types/workflow.js"

describe("missing where-required field is unevaluable, not false", () => {
    test("score_gte with undefined score is unevaluable (not 'false')", () => {
        const cond: WorkflowCondition = { kind: "score_gte", value: 8 }
        // The contract: matchesWorkflowCondition still returns boolean for
        // backward-compat with simple callers, but a new helper distinguishes
        // "field absent" from "field present, condition false".
        const result = matchesWorkflowCondition(cond, { score: undefined, confidence: undefined, issues: [] })
        // Pre-fix: returns false (BAD — silent "did not match").
        // Post-fix: returns false still for the boolean helper, but a new
        // function `evaluateWorkflowCondition` returns "unevaluable".
        // For now, the boolean helper stays unchanged; the new contract is
        // tested via evaluateWorkflowCondition below.
        expect(typeof result).toBe("boolean")
    })

    test("evaluateWorkflowCondition: score_gte with undefined score → 'unevaluable'", async () => {
        const { evaluateWorkflowCondition } = await import("../src/orchestration/workflow/gate.js")
        const cond: WorkflowCondition = { kind: "score_gte", value: 8 }
        const result = evaluateWorkflowCondition(cond, { score: undefined, confidence: undefined, issues: [] })
        expect(result).toBe("unevaluable")
    })

    test("evaluateWorkflowCondition: score_gte with score=9 → 'matches'", async () => {
        const { evaluateWorkflowCondition } = await import("../src/orchestration/workflow/gate.js")
        const cond: WorkflowCondition = { kind: "score_gte", value: 8 }
        const result = evaluateWorkflowCondition(cond, { score: 9, confidence: 0.9, issues: [] })
        expect(result).toBe("matches")
    })

    test("evaluateWorkflowCondition: score_gte with score=5 → 'does_not_match'", async () => {
        const { evaluateWorkflowCondition } = await import("../src/orchestration/workflow/gate.js")
        const cond: WorkflowCondition = { kind: "score_gte", value: 8 }
        const result = evaluateWorkflowCondition(cond, { score: 5, confidence: 0.5, issues: [] })
        expect(result).toBe("does_not_match")
    })

    test("evaluateWorkflowCondition: confidence_gte with undefined confidence → 'unevaluable'", async () => {
        const { evaluateWorkflowCondition } = await import("../src/orchestration/workflow/gate.js")
        const cond: WorkflowCondition = { kind: "confidence_gte", value: 0.8 }
        const result = evaluateWorkflowCondition(cond, { score: undefined, confidence: undefined, issues: [] })
        expect(result).toBe("unevaluable")
    })

    test("evaluateWorkflowCondition: has_issue_severity with no issues → 'does_not_match' (NOT unevaluable)", async () => {
        // has_issue_severity does not require a scalar field — empty issues
        // array is a valid "no qualifying issue found" answer, not "unevaluable".
        const { evaluateWorkflowCondition } = await import("../src/orchestration/workflow/gate.js")
        const cond: WorkflowCondition = { kind: "has_issue_severity", value: "high" }
        const result = evaluateWorkflowCondition(cond, { score: undefined, confidence: undefined, issues: [] })
        expect(result).toBe("does_not_match")
    })

    test("evaluateWorkflowCondition: has_issue_severity with matching issue → 'matches'", async () => {
        const { evaluateWorkflowCondition } = await import("../src/orchestration/workflow/gate.js")
        const cond: WorkflowCondition = { kind: "has_issue_severity", value: "high" }
        const result = evaluateWorkflowCondition(cond, {
            score: undefined,
            confidence: undefined,
            issues: [{ severity: "high", message: "risk" }],
        })
        expect(result).toBe("matches")
    })
})

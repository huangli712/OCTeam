import { describe, expect, test } from "bun:test"

import { matchesWorkflowCondition } from "../src/orchestration/workflow/gate.js"

describe("matchesWorkflowCondition", () => {
    test("matches numeric score and confidence thresholds", () => {
        const verdict = { score: 8, confidence: 0.75, issues: [] }

        expect(matchesWorkflowCondition({ kind: "score_gte", value: 8 }, verdict)).toBe(true)
        expect(matchesWorkflowCondition({ kind: "score_lt", value: 9 }, verdict)).toBe(true)
        expect(matchesWorkflowCondition({ kind: "confidence_gte", value: 0.8 }, verdict)).toBe(false)
    })

    test("matches issue severity at or above the configured threshold", () => {
        const verdict = {
            issues: [
                { severity: "medium" as const, message: "minor mismatch" },
                { severity: "critical" as const },
            ],
        }

        expect(matchesWorkflowCondition({ kind: "has_issue_severity", value: "high" }, verdict)).toBe(true)
        expect(matchesWorkflowCondition({ kind: "has_issue_severity", value: "critical" }, verdict)).toBe(true)
    })
})

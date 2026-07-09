import { describe, expect, test } from "bun:test"

import {
    WORKFLOW_FAILED_REASON_PREFIXES,
    WORKFLOW_REASON_PREFIXES,
    workflowCompleteReason,
    workflowFanoutAllErroredReason,
    workflowFanoutOverToleranceReason,
    workflowGateFailReason,
    workflowInvalidReason,
    workflowJumpLimitReason,
    workflowNoSessionReason,
    workflowOperatorFailReason,
    workflowTimeoutStepReason,
} from "../src/orchestration/reasons.js"
import { runStatusFromReason } from "../src/orchestration/runs.js"

describe("workflow reason builders", () => {
    test("produce the exact legacy strings so persisted records stay readable", () => {
        expect(workflowCompleteReason()).toBe("workflow_complete")
        expect(workflowGateFailReason("bob")).toBe("workflow_failed:bob")
        expect(workflowGateFailReason(undefined)).toBe("workflow_failed:unknown")
        expect(workflowJumpLimitReason("bob")).toBe("workflow_failed:jump_limit:bob")
        expect(workflowNoSessionReason("alice")).toBe("workflow_failed:no_session:alice")
        expect(workflowInvalidReason("INVALID", "bob")).toBe("workflow_invalid:INVALID:bob")
        expect(workflowTimeoutStepReason(3)).toBe("workflow_timeout:step:3")
        expect(workflowFanoutAllErroredReason(2)).toBe("workflow_failed:fanout:2:all_errored")
        expect(workflowFanoutOverToleranceReason(2)).toBe("workflow_failed:fanout:2:over_tolerance")
        expect(workflowOperatorFailReason("operator_reset")).toBe("workflow_failed:operator_reset")
    })

    test("every failure reason is classified as failed by runStatusFromReason", () => {
        const failures = [
            workflowGateFailReason("bob"),
            workflowJumpLimitReason("bob"),
            workflowNoSessionReason("alice"),
            workflowInvalidReason("INVALID", "bob"),
            workflowTimeoutStepReason(3),
            workflowFanoutAllErroredReason(2),
            workflowFanoutOverToleranceReason(2),
            workflowOperatorFailReason("operator_reset"),
        ]
        for (const reason of failures) {
            expect(runStatusFromReason(reason)).toBe("failed")
        }
        expect(runStatusFromReason(workflowCompleteReason())).toBe("completed")
    })

    test("prefix constants cover every failure builder output", () => {
        const samples = [
            workflowGateFailReason("bob"),
            workflowInvalidReason("INVALID", "bob"),
            workflowTimeoutStepReason(3),
        ]
        for (const sample of samples) {
            const matched = WORKFLOW_FAILED_REASON_PREFIXES.some(prefix => sample.startsWith(prefix))
            expect(matched).toBe(true)
        }
        expect(WORKFLOW_REASON_PREFIXES).toContain("workflow_complete")
    })
})

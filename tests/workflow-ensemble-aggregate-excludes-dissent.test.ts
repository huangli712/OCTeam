/**
 * Regression test: ensemble score/confidence aggregation must only
 * consider results that SUPPORT the final verdict, not all results including
 * INVALID and dissenting votes.
 *
 * Bug: src/orchestration/workflow/gate.ts aggregateEnsembleVerdict uses
 * Math.max(...scores) across ALL verifier results, including INVALID and
 * FAIL votes. A minority verifier producing INVALID with a high score
 * (e.g. score:10) can inflate the aggregate score so a `where: score_gte`
 * condition triggers incorrectly. The aggregate should reflect ONLY the
 * verifiers whose verdict matches the final aggregated verdict — anything
 * else lets a dissenting minority control the where-jump decision.
 */

import { describe, expect, test } from "bun:test"

import { aggregateEnsembleVerdict } from "../src/orchestration/workflow/gate.js"
import type { WorkflowGateStep } from "../src/core/types/workflow.js"

function makeEnsembleGate(
    results: Array<{ verdict?: string; score?: number; confidence?: number; parseFailed?: boolean; issues?: unknown[] }>,
    policy: "majority" | "quorum" | "unanimous" = "majority",
    quorum?: number,
): WorkflowGateStep {
    const ensembleResults: Record<string, unknown> = {}
    results.forEach((r, i) => {
        ensembleResults[`v${i}`] = r
    })
    return {
        kind: "gate",
        verifier: "x",
        criteria: "test",
        ensemblePolicy: policy,
        ensembleQuorum: quorum,
        ensembleResults,
    } as unknown as WorkflowGateStep
}

describe("ensemble aggregate score/confidence excludes INVALID and dissenting votes", () => {
    test("majority PASS: aggregate score comes from PASS votes only (INVALID with high score excluded)", () => {
        // 2 PASS verifiers give score=7; 1 INVALID verifier gives score=10.
        // Aggregate score should be max(7, 7) = 7 from the PASS voters — the
        // INVALID verifier's score=10 must NOT contaminate the aggregate.
        const gate = makeEnsembleGate([
            { verdict: "PASS", score: 7, confidence: 0.8 },
            { verdict: "PASS", score: 7, confidence: 0.8 },
            { verdict: "INVALID", score: 10, confidence: 1.0 }, // dissenting
        ], "majority")
        const result = aggregateEnsembleVerdict(gate)
        expect(result.verdict).toBe("PASS")
        expect(result.score).toBe(7) // NOT 10
        expect(result.confidence).toBe(0.8)
    })

    test("majority FAIL: aggregate score comes from FAIL votes only (PASS with high score excluded)", () => {
        // 2 FAIL verifiers give score=4; 1 PASS verifier gives score=9.
        // Aggregate score should be max(4, 4) = 4 from FAIL voters.
        const gate = makeEnsembleGate([
            { verdict: "FAIL", score: 4, confidence: 0.6 },
            { verdict: "FAIL", score: 4, confidence: 0.6 },
            { verdict: "PASS", score: 9, confidence: 0.9 }, // dissenting
        ], "majority")
        const result = aggregateEnsembleVerdict(gate)
        expect(result.verdict).toBe("FAIL")
        expect(result.score).toBe(4) // NOT 9
    })

    test("unanimous PASS: aggregate includes all votes (all support the verdict)", () => {
        // Unanimous: all 3 verifiers vote PASS, so all 3 scores are included.
        const gate = makeEnsembleGate([
            { verdict: "PASS", score: 8, confidence: 0.9 },
            { verdict: "PASS", score: 9, confidence: 0.95 },
            { verdict: "PASS", score: 7, confidence: 0.85 },
        ], "unanimous")
        const result = aggregateEnsembleVerdict(gate)
        expect(result.verdict).toBe("PASS")
        expect(result.score).toBe(9) // max of all PASS scores
        expect(result.confidence).toBe(0.95)
    })

    test("issues aggregation: merged from supporting votes only", () => {
        // 2 FAIL voters each report an issue; 1 PASS voter reports no issue.
        // Aggregate issues should be the 2 FAIL voters' issues only.
        const gate = makeEnsembleGate([
            { verdict: "FAIL", score: 4, issues: [{ severity: "high", message: "risk1" }] },
            { verdict: "FAIL", score: 4, issues: [{ severity: "critical", message: "risk2" }] },
            { verdict: "PASS", score: 9, issues: [] },
        ], "majority")
        const result = aggregateEnsembleVerdict(gate)
        expect(result.verdict).toBe("FAIL")
        expect(result.issues).toHaveLength(2)
        expect(result.issues?.map(i => i.message).sort()).toEqual(["risk1", "risk2"])
    })

    test("control: no where-relevant data when all dissent (verdict INVALID)", () => {
        // When the aggregated verdict is INVALID, score/confidence aggregation
        // is irrelevant (no where-jump fires). Just verify the function still
        // returns a valid INVALID result without error.
        const gate = makeEnsembleGate([
            { verdict: "PASS", score: 10 },
            { verdict: "FAIL", score: 1 },
        ], "majority")
        const result = aggregateEnsembleVerdict(gate)
        expect(result.verdict).toBe("INVALID") // 1P/1F: no majority
    })
})

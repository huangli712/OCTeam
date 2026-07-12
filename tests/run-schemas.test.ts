/**
 * Unit tests for run-schemas.ts — Zod validation schemas for RunRecord /
 * RunEvent / WorkflowRun.
 *
 * These schemas are the persistence boundary: structurally-invalid JSON read
 * back from disk is treated as corrupt (skipped). Tests cover:
 *   - RunRecordSchema: valid minimal / full records, unknown-key stripping,
 *     invalid discriminants.
 *   - RunEventSchema: valid events, invalid kind.
 *   - WorkflowRunSchema superRefine: fanout/join cross-reference integrity,
 *     branch-range bounds, survivor/errored overlap, step index matching.
 */
import { describe, expect, test } from "bun:test"

import { RunEventSchema, RunRecordSchema } from "../src/orchestration/records/run-schemas.js"

// --- helpers ---------------------------------------------------------------

function validRunRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        version: 1,
        runId: "run-1",
        teamRunId: "team-run-1",
        teamName: "alpha",
        type: "parallel",
        reason: "parallel_complete",
        status: "completed",
        startedAt: 1000,
        finishedAt: 2000,
        tokensUsed: 500,
        tokensByMember: { alice: 300, bob: 200 },
        messagesSent: 4,
        memberOutputs: {},
        ...overrides,
    }
}

function wfRunStep(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        index,
        step: index + 1,
        kind: "task",
        completed: false,
        ...overrides,
    }
}

function fanoutStep(index: number, joinIndex: number, branchIds: string[], ranges: Array<{ startIndex: number; endIndex: number }>): Record<string, unknown> {
    return wfRunStep(index, {
        kind: "fanout",
        completed: true,
        fanout: {
            branchIds,
            branchRanges: ranges,
            joinIndex,
            maxErrored: 0,
        },
    })
}

function joinStep(index: number, fanoutIndex: number, branchTailIndices: number[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return wfRunStep(index, {
        kind: "join",
        completed: true,
        join: {
            fanoutIndex,
            branchTailIndices,
            maxErrored: 0,
            ...overrides,
        },
    })
}

function branchStep(index: number, fanoutIndex: number, branchId: string, branchIndex: number, joinIndex: number): Record<string, unknown> {
    return wfRunStep(index, {
        kind: "task",
        completed: true,
        member: "alice",
        branch: { fanoutIndex, branchId, branchIndex, joinIndex },
    })
}

// --- RunRecordSchema -------------------------------------------------------

describe("RunRecordSchema", () => {
    test("minimal valid record parses", () => {
        const rec = validRunRecord()
        const result = RunRecordSchema.safeParse(rec)
        expect(result.success).toBe(true)
    })

    test("full record with all optional fields parses", () => {
        const rec = validRunRecord({
            mode: "isolated",
            currentRound: 3,
            decisionHistory: [{ round: 1, decision: "continue", rationale: "not done", nextActions: ["fix bug"], timestamp: 1500 }],
            approvalHistory: [{ id: "ap-1", kind: "workflow_step", approved: true, requestedAt: 1100, resolvedAt: 1200 }],
            consensusReached: true,
            signoffPolicy: "decider",
            signoffApprovals: { alice: true },
            tasks: [{ id: "t-1", subject: "do work", status: "completed", owner: "alice" }],
        })
        const result = RunRecordSchema.safeParse(rec)
        expect(result.success).toBe(true)
    })

    test("wrong version rejected", () => {
        const result = RunRecordSchema.safeParse(validRunRecord({ version: 2 }))
        expect(result.success).toBe(false)
    })

    test("unknown type rejected", () => {
        const result = RunRecordSchema.safeParse(validRunRecord({ type: "unknown" }))
        expect(result.success).toBe(false)
    })

    test("unknown status rejected", () => {
        const result = RunRecordSchema.safeParse(validRunRecord({ status: "pending" }))
        expect(result.success).toBe(false)
    })

    test("unknown keys stripped (zod default)", () => {
        const rec = validRunRecord({ extraField: "noise" } as Record<string, unknown>)
        const result = RunRecordSchema.safeParse(rec)
        expect(result.success).toBe(true)
        if (result.success) {
            expect(result.data).not.toHaveProperty("extraField")
        }
    })

    test("arena record with scoreboard parses", () => {
        const rec = validRunRecord({
            type: "arena",
            reason: "arena_complete",
            arena: {
                candidates: ["alice", "bob"],
                survivingCandidates: ["alice"],
                evaluator: "carol",
                winner: "alice",
                scoreDirection: "max",
                winnerMetric: "score",
                scoreboard: {
                    scores: [
                        { member: "alice", score: 9, passed: true, rationale: "best" },
                        { member: "bob", score: 5, passed: true },
                    ],
                    rationale: "alice scored higher",
                },
            },
        })
        const result = RunRecordSchema.safeParse(rec)
        expect(result.success).toBe(true)
    })
})

// --- RunEventSchema --------------------------------------------------------

describe("RunEventSchema", () => {
    test("valid dispatched event parses", () => {
        const result = RunEventSchema.safeParse({
            timestamp: 1000,
            kind: "dispatched",
            member: "alice",
            stepIndex: 0,
            correlationId: "corr-1",
        })
        expect(result.success).toBe(true)
    })

    test("valid verdict event with all optional fields parses", () => {
        const result = RunEventSchema.safeParse({
            timestamp: 2000,
            kind: "verdict",
            member: "bob",
            stage: 1,
            round: 0,
            stepIndex: 1,
            correlationId: "corr-2",
            reason: "PASS",
            bytes: 1024,
            detail: "all good",
        })
        expect(result.success).toBe(true)
    })

    test("unknown event kind rejected", () => {
        const result = RunEventSchema.safeParse({ timestamp: 0, kind: "unknown_kind" })
        expect(result.success).toBe(false)
    })

    test("missing timestamp rejected", () => {
        const result = RunEventSchema.safeParse({ kind: "dispatched" })
        expect(result.success).toBe(false)
    })
})

// --- WorkflowRunSchema superRefine ----------------------------------------

describe("WorkflowRunSchema (via RunRecordSchema.workflow)", () => {
    function parseWorkflow(steps: Array<Record<string, unknown>>): { success: boolean; error?: { issues: Array<{ message: string }> } } {
        const result = RunRecordSchema.safeParse(validRunRecord({
            type: "workflow",
            reason: "workflow_complete",
            workflow: { steps },
        }))
        return result as { success: boolean; error?: { issues: Array<{ message: string }> } }
    }

    function expectIssue(result: { success: boolean; error?: { issues: Array<{ message: string }> } }, substring: string): void {
        expect(result.success).toBe(false)
        if (!result.success) {
            const messages = result.error!.issues.map(i => i.message)
            expect(messages.some(m => m.includes(substring))).toBe(true)
        }
    }

    test("linear task+gate workflow parses", () => {
        const result = parseWorkflow([
            wfRunStep(0, { kind: "task", member: "alice", completed: true, output: "done" }),
            wfRunStep(1, { kind: "gate", verifier: "bob", completed: true, verdict: "PASS" }),
        ])
        expect(result.success).toBe(true)
    })

    test("step index mismatch rejected", () => {
        const result = parseWorkflow([
            wfRunStep(0),
            wfRunStep(2, { kind: "task", completed: true }), // step should be 3 (index+1)
        ])
        expectIssue(result, "display step must equal")
    })

    test("fanout without fanout metadata rejected", () => {
        const result = parseWorkflow([
            wfRunStep(0, { kind: "fanout", completed: true }),
            joinStep(1, 0, []),
        ])
        expectIssue(result, "fanout step requires fanout metadata")
    })

    test("fanout joinIndex pointing to non-join rejected", () => {
        const result = parseWorkflow([
            fanoutStep(0, 2, ["b1"], [{ startIndex: 1, endIndex: 1 }]),
            branchStep(1, 0, "b1", 0, 2),
            wfRunStep(2, { kind: "task", completed: true }), // should be join
        ])
        expectIssue(result, "fanout joinIndex must point to a matching join step")
    })

    test("branch step without metadata inside fanout range rejected", () => {
        const result = parseWorkflow([
            fanoutStep(0, 3, ["b1"], [{ startIndex: 1, endIndex: 2 }]),
            branchStep(1, 0, "b1", 0, 3),
            wfRunStep(2, { kind: "task", completed: true }),
            joinStep(3, 0, [2]),
        ])
        expectIssue(result, "branch step requires branch metadata")
    })

    test("valid fanout+join with branch metadata parses", () => {
        const result = parseWorkflow([
            fanoutStep(0, 3, ["b1"], [{ startIndex: 1, endIndex: 2 }]),
            branchStep(1, 0, "b1", 0, 3),
            branchStep(2, 0, "b1", 0, 3),
            joinStep(3, 0, [2]),
        ])
        expect(result.success).toBe(true)
    })

    test("join without join metadata rejected", () => {
        const result = parseWorkflow([
            fanoutStep(0, 1, ["b1"], [{ startIndex: 1, endIndex: 1 }]),
            wfRunStep(1, { kind: "join", completed: true }), // no join metadata
        ])
        // Wait — step 1 is inside the fanout range, not the join itself.
        // The fanout says joinIndex=1, but step 1 has no join metadata.
        expectIssue(result, "join step requires join metadata")
    })

    test("duplicate branch ids rejected", () => {
        const result = parseWorkflow([
            fanoutStep(0, 3, ["b1", "b1"], [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }]),
            branchStep(1, 0, "b1", 0, 3),
            branchStep(2, 0, "b1", 1, 3),
            joinStep(3, 0, [1, 2]),
        ])
        expectIssue(result, "fanout branch ids must be unique")
    })

    test("branch range outside fanout-join span rejected", () => {
        const result = parseWorkflow([
            fanoutStep(0, 3, ["b1"], [{ startIndex: 0, endIndex: 2 }]), // startIndex <= fanout index
            branchStep(1, 0, "b1", 0, 3),
            joinStep(3, 0, [2]),
        ])
        expectIssue(result, "fanout branch range must be between fanout and join")
    })

    test("survivorBranchIds referencing unknown branch rejected", () => {
        const result = parseWorkflow([
            fanoutStep(0, 2, ["b1"], [{ startIndex: 1, endIndex: 1 }]),
            branchStep(1, 0, "b1", 0, 2),
            joinStep(2, 0, [1], { survivorBranchIds: ["unknown"] }),
        ])
        expectIssue(result, "join survivorBranchIds must reference known fanout branches")
    })

    test("survivor and errored overlap rejected", () => {
        const result = parseWorkflow([
            fanoutStep(0, 2, ["b1"], [{ startIndex: 1, endIndex: 1 }]),
            branchStep(1, 0, "b1", 0, 2),
            joinStep(2, 0, [1], { survivorBranchIds: ["b1"], erroredBranchIds: ["b1"] }),
        ])
        expectIssue(result, "join branch cannot be both survivor and errored")
    })

    test("task/gate step with fanout metadata rejected", () => {
        const result = parseWorkflow([
            wfRunStep(0, { kind: "task", member: "alice", completed: true, fanout: { branchIds: ["x"], branchRanges: [{ startIndex: 0, endIndex: 0 }], joinIndex: 0, maxErrored: 0 } }),
            wfRunStep(1, { kind: "task", member: "bob", completed: true }),
        ])
        expectIssue(result, "task/gate step cannot carry fanout metadata")
    })

    test("multi-branch fanout with required_branches parses", () => {
        const result = parseWorkflow([
            fanoutStep(0, 3, ["b1", "b2"], [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }]),
            branchStep(1, 0, "b1", 0, 3),
            branchStep(2, 0, "b2", 1, 3),
            joinStep(3, 0, [1, 2], {
                joinPolicy: "required_branches",
                requiredBranchIds: ["b1"],
                survivorBranchIds: ["b1"],
                erroredBranchIds: ["b2"],
            }),
        ])
        expect(result.success).toBe(true)
    })
})

/**
 * Regression tests for the buildSummary exhaustive-switch guard (P2-1 fix).
 *
 * Background: buildSummary's outer switch over task.type originally had a
 * functional `default` branch that handled parallel/pipeline/consensus via
 * value-checks instead of explicit cases. Adding a `never`-typed exhaustive
 * guard surfaced a latent gap: `consensus` was silently falling through the
 * default and being handled as if it were a parallel task with the "summarize"
 * reduce policy. The guard now forces every OrchestrationType to have an
 * explicit case (or fail to compile) and throws at runtime for any unrecognized
 * type.
 *
 * These tests verify:
 *   1. The consensus case produces a proper summary (concatenation of outputs),
 *      not a silent parallel-style fallback.
 *   2. An unrecognized type triggers the exhaustive guard's throw (defensive —
 *      unreachable in normal operation but fails fast rather than producing a
 *      malformed summary).
 */

import { describe, expect, test } from "bun:test"

import { buildSummary } from "../src/orchestration/records/summary.js"
import type { ActiveTask, ConsensusTask, WorkflowTask } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { makeWorkflowTask } from "./helpers.js"

// buildSummary's consensus case does not access team.directory (only delegate
// and recurse do, via listAllTasks). A minimal cast is sufficient here.
const mockTeam = {} as Team

function makeConsensusTask(opts: Partial<ConsensusTask> = {}): ConsensusTask {
    return {
        type: "consensus",
        startedAt: 0,
        wallClockTimeoutMs: 300_000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        ...opts,
    } as ConsensusTask
}

describe("buildSummary: consensus explicit case (P2-1)", () => {
    test("consensus concatenates member outputs (no parallel-style reduce header)", async () => {
        const task = makeConsensusTask({
            responses: { alice: "agree", bob: "agree" },
            topic: "ship it",
        })
        const summary = await buildSummary(mockTeam, task, "consensus_reached")

        // Head line reflects the consensus type, not parallel.
        expect(summary).toContain("mode=consensus")
        expect(summary).toContain("reason=consensus_reached")
        // Both member outputs are present.
        expect(summary).toContain("by alice:")
        expect(summary).toContain("agree")
        expect(summary).toContain("by bob:")
        // No reduce-policy header leaks in (consensus has no reducePolicy).
        expect(summary).not.toContain("[Reduce policy:")
    })

    test("consensus with empty responses produces head + no candidate block", async () => {
        const task = makeConsensusTask({ responses: {} })
        const summary = await buildSummary(mockTeam, task, "consensus_max_rounds")
        expect(summary).toContain("mode=consensus")
        expect(summary).toContain("reason=consensus_max_rounds")
    })
})

describe("buildSummary: exhaustive guard throws on unknown type (P2-1)", () => {
    test("a future/unrecognized OrchestrationType triggers a throw, not a silent fallback", async () => {
        // Simulate a type that does not exist yet. Cast through unknown so the
        // test compiles despite the discriminant being a closed union.
        const task = {
            type: "future_unknown_type",
            startedAt: 0,
            wallClockTimeoutMs: 300_000,
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            responses: {},
            stages: [],
            currentStageIndex: 0,
            decisionHistory: [],
            decisionParseFailures: 0,
        } as unknown as ActiveTask

        // The exhaustive `default` case assigns task to `never` and throws.
        // Without the guard, this would silently fall into the old default
        // branch and produce a parallel-style summary for an unknown type.
        expect(buildSummary(mockTeam, task, "test")).rejects.toThrow(
            /unhandled OrchestrationType/i,
        )
    })
})

describe("buildSummary: workflow case", () => {
    test("renders a per-step ledger plus completed task-step outputs", async () => {
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "draft", completed: true, output: "alice draft output" },
                { kind: "gate", verifier: "bob", criteria: "ok", onFail: "retry", maxRetries: 1, attempts: 1, completed: true, verdict: "PASS" },
                { kind: "task", member: "carol", task: "polish", completed: true, output: "carol polish output" },
            ],
            responses: { alice: "alice draft output", carol: "carol polish output" },
        })
        const summary = await buildSummary(mockTeam, task, "workflow_complete")

        expect(summary).toContain("mode=workflow")
        expect(summary).toContain("reason=workflow_complete")
        // Step ledger: 1-based numbering, one line per step.
        expect(summary).toContain("1. [task] alice (done)")
        expect(summary).toContain("2. [gate] bob verifies nearest task -> PASS (1 retries)")
        expect(summary).toContain("3. [task] carol (done)")
        // Outputs labeled by step number + member (NOT duplicate ### member headers).
        expect(summary).toContain("by alice")
        expect(summary).toContain("alice draft output")
        expect(summary).toContain("by carol")
        expect(summary).toContain("carol polish output")
    })

    test("renders structured verdict issues[] detail per gate step", async () => {
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "impl", completed: true, output: "impl output" },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "ok",
                    completed: true,
                    verdict: "PASS",
                    score: 7,
                    confidence: 0.85,
                    issues: [
                        { severity: "high", message: "missing edge case for empty input" },
                        { severity: "low", message: "typo in docstring" },
                        { severity: "critical" },
                    ],
                },
            ],
            responses: { alice: "impl output" },
        })
        const summary = await buildSummary(mockTeam, task, "workflow_complete")

        // Compact inline metrics preserved.
        expect(summary).toContain("score=7")
        expect(summary).toContain("confidence=0.85")
        expect(summary).toContain("issues=3")
        // Per-issue detail lines, severity-sorted (critical first, then high, then low).
        expect(summary).toContain("critical")
        expect(summary).toContain("missing edge case for empty input")
        expect(summary).toContain("typo in docstring")
    })

    test("with no completed task steps produces head + ledger only", async () => {
        const task = makeWorkflowTask({
            steps: [{ kind: "task", member: "alice", task: "draft", completed: false }],
            responses: {},
        })
        const summary = await buildSummary(mockTeam, task, "workflow_failed:bob")
        expect(summary).toContain("mode=workflow")
        expect(summary).toContain("1. [task] alice")
        expect(summary).not.toContain("### Step")
    })

    test("renders fanout branch outputs grouped under the fanout", async () => {
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "lead", task: "setup", completed: true, output: "setup output" },
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "docs"],
                        branchRanges: [{ startIndex: 2, endIndex: 3 }, { startIndex: 4, endIndex: 5 }],
                        joinIndex: 6,
                        maxErrored: 1,
                    },
                },
                {
                    kind: "task",
                    member: "alice",
                    task: "api impl",
                    completed: true,
                    output: "api output",
                    branch: { fanoutIndex: 1, branchId: "api", branchIndex: 0, joinIndex: 6 },
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "api ok",
                    targetStepIndex: 2,
                    completed: true,
                    verdict: "PASS",
                    branch: { fanoutIndex: 1, branchId: "api", branchIndex: 0, joinIndex: 6 },
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "docs impl",
                    completed: true,
                    output: "docs output",
                    branch: { fanoutIndex: 1, branchId: "docs", branchIndex: 1, joinIndex: 6 },
                },
                {
                    kind: "gate",
                    verifier: "dave",
                    criteria: "docs ok",
                    targetStepIndex: 4,
                    completed: true,
                    verdict: "FAIL",
                    branch: { fanoutIndex: 1, branchId: "docs", branchIndex: 1, joinIndex: 6 },
                },
                {
                    kind: "join",
                    completed: true,
                    join: {
                        fanoutIndex: 1,
                        branchTailIndices: [3, 5],
                        maxErrored: 1,
                        survivorBranchIds: ["api"],
                        erroredBranchIds: ["docs"],
                        joinedOutput: "api output",
                    },
                },
            ],
            responses: { lead: "setup output", alice: "api output", carol: "docs output" },
        })
        const summary = await buildSummary(mockTeam, task, "workflow_complete")

        expect(summary).toContain("2. [fanout] branches api, docs -> join step 7")
        expect(summary).toContain("  - Branch api [completed] steps 3-4")
        expect(summary).toContain("  - Branch docs [errored] steps 5-6")
        expect(summary).toContain("7. [join] fanout step 2 branches api:completed, docs:errored")
        expect(summary).toContain("### Fanout Step 2 Branch api [completed]")
        expect(summary).toContain("by alice")
        expect(summary).toContain("api output")
        expect(summary).toContain("### Fanout Step 2 Branch docs [errored]")
        expect(summary).toContain("by carol")
        expect(summary).toContain("docs output")
    })

    test("unknown future workflow step kind throws instead of rendering as a gate", async () => {
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "draft", completed: true, output: "draft" },
                { kind: "future_step_kind", completed: false },
            ] as unknown as WorkflowTask["steps"],
        })

        let thrown: unknown
        try {
            await buildSummary(mockTeam, task, "workflow_complete")
        } catch (error) {
            thrown = error
        }

        expect(thrown).toBeInstanceOf(Error)
        if (!(thrown instanceof Error)) throw new Error("expected workflow step kind error")
        expect(thrown.message).toMatch(/unhandled WorkflowStepKind/i)
    })
})

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

import { buildSummary } from "../src/orchestration/summary.js"
import type { ActiveTask, ConsensusTask, WorkflowTask } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"

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
        expect(summary).toContain("### alice")
        expect(summary).toContain("agree")
        expect(summary).toContain("### bob")
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
        await expect(buildSummary(mockTeam, task, "test")).rejects.toThrow(
            /unhandled OrchestrationType/i,
        )
    })
})

describe("buildSummary: workflow case", () => {
    function makeWorkflowTask(opts: Partial<WorkflowTask> = {}): WorkflowTask {
        return {
            type: "workflow",
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
        } as WorkflowTask
    }

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
        expect(summary).toContain("2. [gate] bob -> PASS (1 retries)")
        expect(summary).toContain("3. [task] carol (done)")
        // Outputs labeled by step number + member (NOT duplicate ### member headers).
        expect(summary).toContain("### Step 1 - alice")
        expect(summary).toContain("alice draft output")
        expect(summary).toContain("### Step 3 - carol")
        expect(summary).toContain("carol polish output")
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
})

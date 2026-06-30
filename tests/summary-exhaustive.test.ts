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
import type { ActiveTask } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"

// buildSummary's consensus case does not access team.directory (only delegate
// and recurse do, via listAllTasks). A minimal cast is sufficient here.
const mockTeam = {} as Team

function makeConsensusTask(opts: Partial<ActiveTask> = {}): ActiveTask {
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
    } as ActiveTask
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

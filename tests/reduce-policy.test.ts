import { describe, expect, test } from "bun:test"

import { buildSummary } from "../src/orchestration/summary.js"
import type { ActiveTask } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"

// For parallel/pipeline, buildSummary's default branch does not access
// team.directory (only delegate does, via listAllTasks). A minimal cast is
// sufficient for these unit tests.
const mockTeam = {} as Team

function makeParallelTask(opts: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
        startedAt: 0,
        wallClockTimeoutMs: 300000,
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

// NOTE (#4): the [Reduce policy: X] header these tests assert is no longer
// necessarily what the master receives. When a real reducer member runs, the
// header becomes that reducer's PROMPT and the master gets task.reducedResult
// verbatim (see reducer.test.ts). These tests validate the reducer-prompt /
// legacy-fallback construction path (reducedResult unset, reducerMember unset).

describe("buildSummary reduce_policy (parallel)", () => {
    test("summarize (default): concatenates outputs without reduce header", async () => {
        const task = makeParallelTask({
            responses: { alice: "answer A", bob: "answer B" },
        })
        const summary = await buildSummary(mockTeam, task, "test")
        expect(summary).toContain("### alice")
        expect(summary).toContain("answer A")
        expect(summary).toContain("### bob")
        expect(summary).toContain("answer B")
        expect(summary).not.toContain("[Reduce policy:")
    })

    test("summarize explicit: same as default", async () => {
        const task = makeParallelTask({
            responses: { alice: "answer A" },
            reducePolicy: "summarize",
        })
        const summary = await buildSummary(mockTeam, task, "test")
        expect(summary).toContain("### alice")
        expect(summary).not.toContain("[Reduce policy:")
    })

    test("select: includes select guidance and candidate count", async () => {
        const task = makeParallelTask({
            responses: { alice: "answer A", bob: "answer B" },
            reducePolicy: "select",
        })
        const summary = await buildSummary(mockTeam, task, "test")
        expect(summary).toContain("[Reduce policy: SELECT]")
        expect(summary).toContain("Selection criteria:")
        expect(summary).toContain("Select the single best")
        expect(summary).toContain("2 candidates")
    })

    test("select with reduceSelect: injects method-neutral criteria + anti-bias", async () => {
        const task = makeParallelTask({
            responses: { alice: "drift 0.1", bob: "drift 1e-6", carol: "drift 1e-11" },
            reducePolicy: "select",
            reduceSelect: "smallest absolute ENERGY_DRIFT value",
        })
        const summary = await buildSummary(mockTeam, task, "test")
        expect(summary).toContain("Selection criteria: smallest absolute ENERGY_DRIFT value")
        // anti-bias instruction always present (reducer is often a contestant)
        expect(summary).toContain("do NOT favor a candidate because it matches your own")
    })

    test("select without reduceSelect: falls back to default criteria + still anti-bias", async () => {
        const task = makeParallelTask({
            responses: { alice: "answer A" },
            reducePolicy: "select",
        })
        const summary = await buildSummary(mockTeam, task, "test")
        expect(summary).toContain("Selection criteria: the best overall answer")
        expect(summary).toContain("do NOT favor a candidate because it matches your own")
    })

    test("merge: includes merge guidance", async () => {
        const task = makeParallelTask({
            responses: { alice: "answer A", bob: "answer B" },
            reducePolicy: "merge",
        })
        const summary = await buildSummary(mockTeam, task, "test")
        expect(summary).toContain("[Reduce policy: MERGE]")
        expect(summary).toContain("Merge them into a single")
        expect(summary).toContain("2 solutions")
    })

    test("rubric with custom rubric: includes rubric text", async () => {
        const task = makeParallelTask({
            responses: { alice: "answer A", bob: "answer B" },
            reducePolicy: "rubric",
            reduceRubric: "accuracy (50%), style (50%)",
        })
        const summary = await buildSummary(mockTeam, task, "test")
        expect(summary).toContain("[Reduce policy: RUBRIC]")
        expect(summary).toContain("accuracy (50%), style (50%)")
        expect(summary).toContain("Score each candidate")
    })

    test("rubric without reduceRubric: falls back to default rubric", async () => {
        const task = makeParallelTask({
            responses: { alice: "answer A" },
            reducePolicy: "rubric",
        })
        const summary = await buildSummary(mockTeam, task, "test")
        expect(summary).toContain("[Reduce policy: RUBRIC]")
        expect(summary).toContain("correctness") // default rubric content
    })

    test("select with single candidate: still includes guidance", async () => {
        const task = makeParallelTask({
            responses: { alice: "only answer" },
            reducePolicy: "select",
        })
        const summary = await buildSummary(mockTeam, task, "test")
        expect(summary).toContain("[Reduce policy: SELECT]")
        expect(summary).toContain("1 candidates")
    })
})

describe("buildSummary reduce_policy isolation (pipeline ignores it)", () => {
    test("pipeline with reducePolicy=select: still concatenates (no reduce header)", async () => {
        const task = makeParallelTask({
            type: "pipeline",
            responses: { alice: "stage 1 output", bob: "stage 2 output" },
            reducePolicy: "select", // should be IGNORED for pipeline
        })
        const summary = await buildSummary(mockTeam, task, "test")
        expect(summary).not.toContain("[Reduce policy:")
        expect(summary).toContain("### alice")
        expect(summary).toContain("### bob")
        expect(summary).toContain("stage 1 output")
    })

    test("pipeline without reducePolicy: baseline regression", async () => {
        const task = makeParallelTask({
            type: "pipeline",
            responses: { alice: "stage 1 output" },
        })
        const summary = await buildSummary(mockTeam, task, "test")
        expect(summary).toContain("### alice")
        expect(summary).toContain("stage 1 output")
        expect(summary).not.toContain("[Reduce policy:")
    })
})

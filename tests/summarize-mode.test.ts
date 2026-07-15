/**
 * Unit tests for renderers.ts — per-mode summary renderers.
 *
 * Each function takes an ActiveTask variant + a head string and returns
 * formatted text. Tests verify output structure, key content, and edge cases
 * (empty responses, missing optional fields, reduce policies).
 *
 * summarizeDelegate and summarizeRecurse require disk I/O (listAllTasks);
 * they are tested with real tmp directories.
 */
import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import type { ActiveTask } from "../src/core/types.js"
import {
    summarizeArbitrate,
    summarizeArena,
    summarizeConsensus,
    summarizeDelegate,
    summarizeLoop,
    summarizeParallel,
    summarizePipeline,
    summarizeRecurse,
    summarizeRoute,
    summarizeTollgate,
    summarizeWorkflow,
} from "../src/orchestration/records/renderers.js"
import { makeTeam, makeWorkflowTask, tmpRoot } from "./helpers.js"

const HEAD = "mode=test reason=test_complete tokens=0 messages=0"

// --- helpers ----------------------------------------------------------------

function baseTask(overrides: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "parallel",
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
        ...overrides,
    } as ActiveTask
}

// --- summarizeParallel ------------------------------------------------------

describe("summarizeParallel", () => {
    test("summarize policy (default) concatenates member outputs", () => {
        const task = baseTask({ responses: { alice: "result A", bob: "result B" } })
        const summary = summarizeParallel(task, HEAD)
        expect(summary).toContain(HEAD)
        expect(summary).toContain("### alice")
        expect(summary).toContain("result A")
        expect(summary).toContain("### bob")
        expect(summary).toContain("result B")
    })

    test("select policy renders selection guidance", () => {
        const task = baseTask({
            responses: { alice: "ans A", bob: "ans B" },
            reducePolicy: "select",
            reduceSelect: "fastest execution",
        })
        const summary = summarizeParallel(task, HEAD)
        expect(summary).toContain("[Reduce policy: SELECT]")
        expect(summary).toContain("Selection criteria: fastest execution")
        expect(summary).toContain("2 candidates")
    })

    test("merge policy renders merge guidance", () => {
        const task = baseTask({
            responses: { alice: "sol A", bob: "sol B" },
            reducePolicy: "merge",
        })
        const summary = summarizeParallel(task, HEAD)
        expect(summary).toContain("[Reduce policy: MERGE]")
        expect(summary).toContain("2 solutions")
    })

    test("rubric policy renders rubric", () => {
        const task = baseTask({
            responses: { alice: "sol A", bob: "sol B" },
            reducePolicy: "rubric",
            reduceRubric: "speed (50%), correctness (50%)",
        })
        const summary = summarizeParallel(task, HEAD)
        expect(summary).toContain("[Reduce policy: RUBRIC]")
        expect(summary).toContain("Rubric: speed (50%), correctness (50%)")
    })

    test("reducedResult present delivers it verbatim", () => {
        const task = baseTask({
            responses: { alice: "raw A", bob: "raw B" },
            reducePolicy: "merge",
            reducedResult: "MERGED RESULT",
        })
        const summary = summarizeParallel(task, HEAD)
        expect(summary).toContain("MERGED RESULT")
        expect(summary).not.toContain("### alice")
    })

    test("empty responses produces head only", () => {
        const task = baseTask({ responses: {} })
        const summary = summarizeParallel(task, HEAD)
        expect(summary).toContain(HEAD)
    })
})

// --- summarizeConsensus -----------------------------------------------------

describe("summarizeConsensus", () => {
    test("concatenates member outputs", () => {
        const task = baseTask({ type: "consensus", responses: { alice: "agree", bob: "agree" } })
        const summary = summarizeConsensus(task, HEAD)
        expect(summary).toContain("### alice")
        expect(summary).toContain("agree")
        expect(summary).toContain("### bob")
    })
})

// --- summarizePipeline ------------------------------------------------------

describe("summarizePipeline", () => {
    test("concatenates stage outputs in order", () => {
        const task = baseTask({ type: "pipeline", responses: { alice: "stage1 out", bob: "stage2 out" } })
        const summary = summarizePipeline(task, HEAD)
        expect(summary).toContain("by alice:")
        expect(summary).toContain("stage1 out")
        expect(summary).toContain("by bob:")
        expect(summary).toContain("stage2 out")
    })
})

// --- summarizeLoop ----------------------------------------------------------

describe("summarizeLoop", () => {
    test("renders decision history and member outputs", () => {
        const task = baseTask({
            type: "loop",
            currentRound: 2,
            decisionHistory: [
                { round: 1, decision: "continue", rationale: "not done", nextActions: ["fix bug"], timestamp: 1000 },
                { round: 2, decision: "done", rationale: "all tests pass", nextActions: [], timestamp: 2000 },
            ],
            responses: { alice: "code output" },
        })
        const summary = summarizeLoop(task, HEAD)
        expect(summary).toContain("rounds=2")
        expect(summary).toContain("final: done")
        expect(summary).toContain("round 1: continue")
        expect(summary).toContain("round 2: done")
        expect(summary).toContain("### alice")
        expect(summary).toContain("code output")
    })

    test("empty history shows n/a for final", () => {
        const task = baseTask({ type: "loop", currentRound: 0, decisionHistory: [], responses: {} })
        const summary = summarizeLoop(task, HEAD)
        expect(summary).toContain("final: n/a")
        expect(summary).toContain("rounds=0")
    })
})

// --- summarizeRoute ---------------------------------------------------------

describe("summarizeRoute", () => {
    test("renders target outputs and router rationale", () => {
        const task = baseTask({
            type: "route",
            routeTargets: ["alice", "bob"],
            routeDecisionRationale: "input is a coding task",
            responses: { alice: "code A", bob: "code B" },
        }) as Extract<ActiveTask, { type: "route" }>
        const summary = summarizeRoute(task, HEAD)
        expect(summary).toContain("Router rationale: input is a coding task")
        expect(summary).toContain("by alice:")
        expect(summary).toContain("code A")
        expect(summary).toContain("by bob:")
    })

    test("no rationale omits rationale line", () => {
        const task = baseTask({
            type: "route",
            routeTargets: ["alice"],
            responses: { alice: "result" },
        }) as Extract<ActiveTask, { type: "route" }>
        const summary = summarizeRoute(task, HEAD)
        expect(summary).not.toContain("Router rationale")
        expect(summary).toContain("by alice:")
    })
})

// --- summarizeArbitrate -----------------------------------------------------

describe("summarizeArbitrate", () => {
    test("renders ruling and disputant positions", () => {
        const task = baseTask({
            type: "arbitrate",
            disputants: ["alice", "bob"],
            arbitrationRuling: "use approach A",
            arbitrationRationale: "simpler and faster",
            responses: { alice: "approach A", bob: "approach B" },
        }) as Extract<ActiveTask, { type: "arbitrate" }>
        const summary = summarizeArbitrate(task, HEAD)
        expect(summary).toContain("Ruling: use approach A")
        expect(summary).toContain("Rationale: simpler and faster")
        expect(summary).toContain("by alice:")
        expect(summary).toContain("by bob:")
    })

    test("no ruling shows (none)", () => {
        const task = baseTask({
            type: "arbitrate",
            disputants: ["alice"],
            responses: { alice: "position" },
        }) as Extract<ActiveTask, { type: "arbitrate" }>
        const summary = summarizeArbitrate(task, HEAD)
        expect(summary).toContain("Ruling: (none)")
    })
})

// --- summarizeTollgate ------------------------------------------------------

describe("summarizeTollgate", () => {
    test("renders gate rows and completed outputs", () => {
        const task = baseTask({
            type: "tollgate",
            gatedStages: [
                { member: "alice", task: "impl", completed: true, verifier: "bob", criteria: "ok", verdict: "PASS", attempts: 0, invalidAttempts: 0 },
                { member: "carol", task: "test", completed: false, verifier: "bob", criteria: "ok", attempts: 1, invalidAttempts: 0 },
            ],
            responses: { alice: "impl output" },
        }) as Extract<ActiveTask, { type: "tollgate" }>
        const summary = summarizeTollgate(task, HEAD)
        expect(summary).toContain("0. [PASS] alice -> verified by bob")
        expect(summary).toContain("1. [pending] carol -> verified by bob")
        expect(summary).toContain("1 retries")
        expect(summary).toContain("by alice:")
        expect(summary).toContain("impl output")
        // carol is not completed, so no output section
        expect(summary).not.toContain("by carol:")
    })

    test("no completed gates omits output section", () => {
        const task = baseTask({
            type: "tollgate",
            gatedStages: [
                { member: "alice", task: "impl", completed: false, verifier: "bob", criteria: "ok", attempts: 0, invalidAttempts: 0 },
            ],
            responses: {},
        }) as Extract<ActiveTask, { type: "tollgate" }>
        const summary = summarizeTollgate(task, HEAD)
        expect(summary).toContain("Gates:")
        expect(summary).not.toContain("###")
    })
})

// --- summarizeWorkflow ------------------------------------------------------

describe("summarizeWorkflow", () => {
    test("renders step ledger and task outputs", () => {
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "draft", completed: true, output: "draft output" },
                { kind: "gate", verifier: "bob", criteria: "ok", completed: true, verdict: "PASS" },
                { kind: "task", member: "carol", task: "polish", completed: true, output: "polish output" },
            ],
        }) as Extract<ActiveTask, { type: "workflow" }>
        const summary = summarizeWorkflow(task, HEAD)
        expect(summary).toContain("Steps:")
        expect(summary).toContain("1.")
        expect(summary).toContain("2.")
        expect(summary).toContain("3.")
        expect(summary).toContain("### Step 1 - alice")
        expect(summary).toContain("draft output")
        expect(summary).toContain("### Step 3 - carol")
        expect(summary).toContain("polish output")
    })

    test("no steps produces head only", () => {
        const task = makeWorkflowTask({ steps: [] }) as Extract<ActiveTask, { type: "workflow" }>
        const summary = summarizeWorkflow(task, HEAD)
        expect(summary).toBe(HEAD)
    })
})

// --- summarizeArena ---------------------------------------------------------

describe("summarizeArena", () => {
    test("renders winner, scoreboard, and candidates", () => {
        const task = baseTask({
            type: "arena",
            task: "impl",
            candidates: ["alice", "bob"],
            evaluatorMember: "carol",
            scoreDirection: "max",
            winnerMetric: "score",
            winner: "alice",
            scoreboard: {
                scores: [
                    { member: "alice", score: 9, passed: true, rationale: "best" },
                    { member: "bob", score: 5, passed: true },
                ],
            },
        }) as Extract<ActiveTask, { type: "arena" }>
        const summary = summarizeArena(task, HEAD)
        expect(summary).toContain("Arena winner: alice")
        expect(summary).toContain("Scoreboard:")
        expect(summary).toContain("alice: score=9")
        expect(summary).toContain("bob: score=5")
        expect(summary).toContain("Candidates: alice, bob")
        expect(summary).toContain("evaluator: carol")
    })

    test("no winner renders no-winner line", () => {
        const task = baseTask({
            type: "arena",
            task: "impl",
            candidates: ["alice", "bob"],
            evaluatorMember: "carol",
            scoreDirection: "max",
            winnerMetric: "score",
        }) as Extract<ActiveTask, { type: "arena" }>
        const summary = summarizeArena(task, HEAD)
        expect(summary).toContain("Arena winner: no winner selected")
    })

    test("min score direction sorts ascending", () => {
        const task = baseTask({
            type: "arena",
            task: "impl",
            candidates: ["alice", "bob"],
            evaluatorMember: "carol",
            scoreDirection: "min",
            winnerMetric: "latency",
            winner: "bob",
            scoreboard: {
                scores: [
                    { member: "alice", metrics: { latency: 100 }, passed: true },
                    { member: "bob", metrics: { latency: 50 }, passed: true },
                ],
            },
        }) as Extract<ActiveTask, { type: "arena" }>
        const summary = summarizeArena(task, HEAD)
        expect(summary).toContain("Arena winner: bob")
        // bob (50) should appear before alice (100) in min-sorted order
        const bobIdx = summary.indexOf("bob: latency=50")
        const aliceIdx = summary.indexOf("alice: latency=100")
        expect(bobIdx).toBeGreaterThan(-1)
        expect(aliceIdx).toBeGreaterThan(-1)
        expect(bobIdx).toBeLessThan(aliceIdx)
    })
})

// --- summarizeDelegate ------------------------------------------------------

describe("summarizeDelegate", () => {
    test("renders task list from disk", async () => {
        const root = tmpRoot("sum-del")
        const team = makeTeam({ directory: root, teamName: "alpha" })
        // Write a minimal task file directly
        const tasksDir = join(root, "tasks")
        const { mkdirSync } = await import("node:fs")
        mkdirSync(tasksDir, { recursive: true })
        const taskId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify({
            version: 1,
            id: taskId,
            subject: "do work",
            description: "desc",
            status: "completed",
            owner: "alice",
            blockedBy: [],
            createdAt: 0,
            updatedAt: 0,
        }))
        const summary = await summarizeDelegate(team, HEAD)
        expect(summary).toContain(HEAD)
        expect(summary).toContain("[completed]")
        expect(summary).toContain("do work")
        expect(summary).toContain("@alice")
    })
})

// --- summarizeRecurse -------------------------------------------------------

describe("summarizeRecurse", () => {
    test("renders root result and task tree", async () => {
        const root = tmpRoot("sum-rec")
        const team = makeTeam({ directory: root, teamName: "alpha" })
        const { mkdirSync } = await import("node:fs")
        const tasksDir = join(root, "tasks")
        mkdirSync(tasksDir, { recursive: true })
        const rootId = "11111111-1111-1111-1111-111111111111"
        const childId = "22222222-2222-2222-2222-222222222222"
        writeFileSync(join(tasksDir, `${rootId}.json`), JSON.stringify({
            version: 1, id: rootId, subject: "root goal", description: "d",
            status: "completed", blockedBy: [], createdAt: 0, updatedAt: 0,
            depth: 0, result: "FINAL ROOT RESULT",
        }))
        writeFileSync(join(tasksDir, `${childId}.json`), JSON.stringify({
            version: 1, id: childId, subject: "child task", description: "d",
            status: "completed", blockedBy: [rootId], createdAt: 0, updatedAt: 0,
            depth: 1, result: "child result",
        }))
        const task = baseTask({
            type: "recurse",
            rootTaskId: rootId,
        }) as Extract<ActiveTask, { type: "recurse" }>
        const summary = await summarizeRecurse(team, task, HEAD)
        expect(summary).toContain("Root result:")
        expect(summary).toContain("FINAL ROOT RESULT")
        expect(summary).toContain("Task tree:")
        expect(summary).toContain("root goal")
        expect(summary).toContain("child task")
        // Depth indentation: root at depth 0 (no indent), child at depth 1 (2 spaces)
        expect(summary).toContain("- [completed] root goal")
        expect(summary).toContain("  - [completed] child task")
    })
})

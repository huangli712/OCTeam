import { describe, expect, test } from "bun:test"

import { buildSummary } from "../src/orchestration/summary.js"
import {
    allReadOnlyStagesReportNoIssues,
    allMembersAgree,
} from "../src/orchestration/handlers.js"
import { buildUpstreamContext } from "../src/orchestration/dispatch.js"
import type { ActiveTask, Stage } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"

const mockTeam = {} as Team

function makeTask(opts: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "loop",
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
    }
}

// --- bug① loop summary includes member outputs ---

describe("bug① loop summary includes responses (work product)", () => {
    test("loop summary contains both decisionHistory AND member outputs", async () => {
        const task = makeTask({
            type: "loop",
            currentRound: 2,
            decisionHistory: [
                { round: 1, decision: "continue", rationale: "needs work", nextActions: [], timestamp: 1 },
                { round: 2, decision: "done", rationale: "looks good", nextActions: [], timestamp: 2 },
            ],
            responses: { coder: "function add(a,b){return a+b}", reviewer: "LGTM" },
        })
        const summary = await buildSummary(mockTeam, task, "loop_complete:decider_done")
        // decision log still present
        expect(summary).toContain("round 1: continue")
        expect(summary).toContain("final: done")
        // AND the actual work product (was missing before the fix)
        expect(summary).toContain("### coder")
        expect(summary).toContain("function add(a,b)")
        expect(summary).toContain("### reviewer")
    })

    test("loop summary with no responses falls back to decisions only", async () => {
        const task = makeTask({
            type: "loop",
            currentRound: 1,
            decisionHistory: [
                { round: 1, decision: "done", rationale: "ok", nextActions: [], timestamp: 1 },
            ],
            responses: {},
        })
        const summary = await buildSummary(mockTeam, task, "loop_complete:decider_done")
        expect(summary).toContain("final: done")
        expect(summary).not.toContain("###")
    })
})

// --- bug② all completed upstream injected, capped ---

describe("bug② buildUpstreamContext (all completed upstream, capped)", () => {
    const stages: Stage[] = [
        { member: "a", task: "ta", completed: true },
        { member: "b", task: "tb", completed: true },
        { member: "c", task: "tc", completed: false },
    ]

    test("injects ALL completed prior stages, not just the immediate predecessor", () => {
        const responses = { a: "output-A", b: "output-B" }
        // stage index 2 (c): both a and b are completed upstream
        const ctx = buildUpstreamContext(stages, responses, 2)
        expect(ctx).toContain("[Output from a]")
        expect(ctx).toContain("output-A")
        expect(ctx).toContain("[Output from b]")
        expect(ctx).toContain("output-B")
    })

    test("skips incomplete and missing-output stages", () => {
        const responses = { a: "output-A" } // b has no output
        const ctx = buildUpstreamContext(stages, responses, 2)
        expect(ctx).toContain("output-A")
        expect(ctx).not.toContain("[Output from b]")
    })

    test("empty when no completed upstream (first stage)", () => {
        expect(buildUpstreamContext(stages, { a: "x" }, 0)).toBe("")
    })

    test("total cap: stops adding once over budget and marks truncation", () => {
        const big = "x".repeat(20000)
        const responses = { a: big, b: big } // 2×20k truncated to 2×~8k > 32k after a couple
        const manyStages: Stage[] = [
            { member: "a", task: "", completed: true },
            { member: "b", task: "", completed: true },
            { member: "c", task: "", completed: true },
            { member: "d", task: "", completed: true },
            { member: "e", task: "", completed: true },
        ]
        const r: Record<string, string> = {}
        for (const s of manyStages) r[s.member] = big
        const ctx = buildUpstreamContext(manyStages, r, 5)
        expect(ctx).toContain("upstream context truncated at")
        expect(ctx.length).toBeLessThan(40000) // bounded, not 5×~8k unbounded
    })
})

// --- bug③ structured <no_issues/> tag (i18n, no false-match) ---

describe("bug③ allReadOnlyStagesReportNoIssues (structured tag)", () => {
    function loopTask(responses: Record<string, string>): ActiveTask {
        return makeTask({
            type: "loop",
            stages: [
                { member: "rev", task: "review", action: "read_only", completed: true },
            ],
            responses,
        })
    }

    test("fires on explicit <no_issues/> tag", () => {
        expect(allReadOnlyStagesReportNoIssues(loopTask({ rev: "All checked. <no_issues/>" }))).toBe(true)
    })

    test("fires on Chinese <无问题/> tag (i18n)", () => {
        expect(allReadOnlyStagesReportNoIssues(loopTask({ rev: "审查完毕。<无问题/>" }))).toBe(true)
    })

    test("does NOT false-match a negated-context English sentence", () => {
        // old keyword heuristic matched "no issues" substring here → wrong exit
        expect(
            allReadOnlyStagesReportNoIssues(loopTask({ rev: "there are no issues with X, but major bugs in Y" })),
        ).toBe(false)
    })

    test("does NOT fire without the tag", () => {
        expect(allReadOnlyStagesReportNoIssues(loopTask({ rev: "found 3 problems" }))).toBe(false)
    })

    test("all read_only stages must emit the tag", () => {
        const task = makeTask({
            type: "loop",
            stages: [
                { member: "r1", task: "", action: "read_only", completed: true },
                { member: "r2", task: "", action: "read_only", completed: true },
            ],
            responses: { r1: "<no_issues/>", r2: "still has bugs" },
        })
        expect(allReadOnlyStagesReportNoIssues(task)).toBe(false)
    })

    test("no read_only stages → false", () => {
        const task = makeTask({
            type: "loop",
            stages: [{ member: "m", task: "", action: "modify", completed: true }],
            responses: { m: "<no_issues/>" },
        })
        expect(allReadOnlyStagesReportNoIssues(task)).toBe(false)
    })
})

// --- bug④ bilingual consensus tag ---

describe("bug④ allMembersAgree (bilingual tag)", () => {
    test("agrees on English <consensus>", () => {
        expect(
            allMembersAgree({
                alice: '<consensus>{"agreed": true}</consensus>',
                bob: '<consensus>{"agreed": true}</consensus>',
            }),
        ).toBe(true)
    })

    test("agrees on Chinese <共识> (was never recognized before)", () => {
        expect(
            allMembersAgree({
                alice: '<共识>{"agreed": true}</共识>',
                bob: '<共识>{"agreed": true}</共识>',
            }),
        ).toBe(true)
    })

    test("mixed English + Chinese tags both recognized", () => {
        expect(
            allMembersAgree({
                alice: '<consensus>{"agreed": true}</consensus>',
                bob: '<共识>{"agreed": true}</共识>',
            }),
        ).toBe(true)
    })

    test("one member disagreeing → false", () => {
        expect(
            allMembersAgree({
                alice: '<共识>{"agreed": true}</共识>',
                bob: '<consensus>{"agreed": false}</consensus>',
            }),
        ).toBe(false)
    })

    test("missing tag → false", () => {
        expect(allMembersAgree({ alice: '<共识>{"agreed": true}</共识>', bob: "I agree" })).toBe(false)
    })
})

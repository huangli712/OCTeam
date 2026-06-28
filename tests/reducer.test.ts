import { describe, expect, test } from "bun:test"

import { buildSummary } from "../src/orchestration/summary.js"
import { maybeTriggerReduce } from "../src/orchestration/signoff.js"
import type { ActiveTask, MemberState } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { PluginContext } from "../src/core/context.js"

const mockTeam = {} as Team
const mockCtx = {} as PluginContext // never touched by the early-return branches

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
    }
}

function makeTeam(opts: {
    activeTask?: ActiveTask
    members?: Array<Partial<MemberState> & Pick<MemberState, "name">>
}): Team {
    const members: MemberState[] = (opts.members ?? []).map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: true,
        turnCount: 0,
        sessionId: m.sessionId,
    }))
    return {
        version: 1,
        teamRunId: "r",
        teamName: "t",
        status: "busy",
        leadSessionId: "ses_lead",
        members,
        bounds: {} as any,
        createdAt: 0,
        activeTask: opts.activeTask,
        mutex: new AsyncMutex(),
        directory: "/tmp/x",
    } as unknown as Team
}

// --- buildSummary delivers reducedResult verbatim (#4) ---

describe("buildSummary: reducedResult verbatim", () => {
    test("once reducedResult is set, it is delivered verbatim (no [Reduce policy:] header)", async () => {
        const task = makeParallelTask({
            reducePolicy: "select",
            responses: { alice: "A", bob: "B" },
            reducedResult: "THE CHOSEN ANSWER",
        })
        const summary = await buildSummary(mockTeam, task, "parallel_isolated_reduced:select")
        expect(summary).toContain("THE CHOSEN ANSWER")
        expect(summary).not.toContain("[Reduce policy:")
        expect(summary).not.toContain("### alice")
        expect(summary).toContain("mode=parallel") // head still present
    })

    test("without reducedResult, the select header path is unchanged (legacy fallback)", async () => {
        const task = makeParallelTask({
            reducePolicy: "select",
            responses: { alice: "A", bob: "B" },
        })
        const summary = await buildSummary(mockTeam, task, "test")
        expect(summary).toContain("[Reduce policy: SELECT]")
        expect(summary).toContain("### alice")
        expect(summary).not.toContain("THE CHOSEN ANSWER")
    })

    test("empty-string reducedResult still delivered verbatim (presence, not truthiness)", async () => {
        const task = makeParallelTask({ reducePolicy: "merge", responses: { a: "x", b: "y" }, reducedResult: "" })
        const summary = await buildSummary(mockTeam, task, "r")
        expect(summary).not.toContain("[Reduce policy:")
    })
})

// --- maybeTriggerReduce early-return truth table (no dispatch) ---

describe("maybeTriggerReduce: no-reduce conditions (legacy fallback)", () => {
    test("summarize policy → false (never reduces)", async () => {
        const team = makeTeam({
            activeTask: makeParallelTask({ reducePolicy: "summarize", responses: { a: "1", b: "2" }, reducerMember: "a" }),
            members: [{ name: "a", sessionId: "s" }, { name: "b", sessionId: "s2" }],
        })
        expect(await maybeTriggerReduce(mockCtx, team)).toBe(false)
    })

    test("no reducerMember named → false (legacy delivery)", async () => {
        const team = makeTeam({
            activeTask: makeParallelTask({ reducePolicy: "select", responses: { a: "1", b: "2" } }),
            members: [{ name: "a", sessionId: "s" }, { name: "b", sessionId: "s2" }],
        })
        expect(await maybeTriggerReduce(mockCtx, team)).toBe(false)
    })

    test("reducerMember has no live session → false", async () => {
        const team = makeTeam({
            activeTask: makeParallelTask({ reducePolicy: "select", responses: { a: "1", b: "2" }, reducerMember: "a" }),
            members: [{ name: "a" /* no sessionId */ }, { name: "b", sessionId: "s2" }],
        })
        expect(await maybeTriggerReduce(mockCtx, team)).toBe(false)
    })

    test("N<=1 candidates → false (nothing to reduce)", async () => {
        const team = makeTeam({
            activeTask: makeParallelTask({ reducePolicy: "select", responses: { a: "1" }, reducerMember: "a" }),
            members: [{ name: "a", sessionId: "s" }],
        })
        expect(await maybeTriggerReduce(mockCtx, team)).toBe(false)
    })

    test("already reduceStage → true (idempotent, no re-dispatch)", async () => {
        const team = makeTeam({
            activeTask: makeParallelTask({
                reducePolicy: "select",
                responses: { a: "1", b: "2" },
                reducerMember: "a",
                reduceStage: true,
            }),
            members: [{ name: "a", sessionId: "s" }, { name: "b", sessionId: "s2" }],
        })
        expect(await maybeTriggerReduce(mockCtx, team)).toBe(true)
    })

    test("non-parallel task → false", async () => {
        const team = makeTeam({
            activeTask: makeParallelTask({ type: "pipeline", reducePolicy: "select", responses: { a: "1", b: "2" }, reducerMember: "a" }),
            members: [{ name: "a", sessionId: "s" }],
        })
        expect(await maybeTriggerReduce(mockCtx, team)).toBe(false)
    })
})

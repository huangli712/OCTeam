/**
 * H41 (2026-07-28 audit): reduce reducer-error fallback bypasses signoff.
 *
 * Bug: handleReduceIdle (reduce.ts:74-101) when the reducer itself is
 * errored, falls back to the parallel non-reduce delivery path and calls
 * finishRun directly at line 98 — WITHOUT calling maybeTriggerSignoff.
 * The normal reduce completion path (line 123-126) DOES call signoff.
 * So a parallel task configured with signoffPolicy + a reducer can
 * deliver unreviewed raw mapper outputs when the reducer errors.
 *
 * Fix: the partial-delivery finishRun in the fallback path must be
 * preceded by maybeTriggerSignoff, matching the normal path.
 */
import { describe, expect, test } from "bun:test"

import { handleReduceIdle } from "../src/orchestration/modes/reduce.js"
import type { ActiveTask, MemberState } from "../src/core/types.js"
import { makeCtx, makeTeam, type DispatchCall } from "./helpers.js"

function makeParallelTask(opts: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        reducePolicy: "summarize",
        signoffPolicy: "none",
        ...opts,
    } as ActiveTask
}

describe("H41: reducer-errored fallback honors signoff", () => {
    test("reducer errored + signoffPolicy set → signoff triggered before finishRun", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeParallelTask({
            mode: "isolated",
            reduceStage: true,
            reducerMember: "alice",
            reducePolicy: "summarize",
            signoffPolicy: "all", // require signoff
            responses: { alice: "ALICE_RAW", bob: "BOB_RAW" },
            maxErroredMembers: 1,
        })
        // alice (reducer) is errored; bob is a healthy mapper.
        const alice: Partial<MemberState> = { name: "alice", sessionId: "ses_alice", status: "errored" }
        const bob: Partial<MemberState> = { name: "bob", sessionId: "ses_bob", status: "idle" }
        const reviewer: Partial<MemberState> = { name: "reviewer", sessionId: "ses_rev", status: "idle" }
        const team = makeTeam({
            activeTask: task,
            members: [alice, bob, reviewer] as MemberState[],
        })

        // Simulate alice (the errored reducer) idling.
        const aliceMember = team.members.find(m => m.name === "alice")!
        await handleReduceIdle(ctx, team, aliceMember)

        // On UNFIXED code: finishRun fires directly → team.status = "idle",
        // activeTask cleared, no signoff dispatch.
        // On FIXED code: maybeTriggerSignoff fires first → signoffStage set,
        // reviewer dispatched, activeTask preserved.
        expect(team.activeTask).toBeDefined()
        expect(task.signoffStage).toBe(true)
        // Reviewer should have been dispatched.
        expect(calls.some(c => c.sessionId === "ses_rev")).toBe(true)
    })

    test("reducer errored + signoffPolicy=none → finishRun directly (control)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeParallelTask({
            mode: "isolated",
            reduceStage: true,
            reducerMember: "alice",
            reducePolicy: "summarize",
            signoffPolicy: "none", // no signoff required
            responses: { alice: "ALICE_RAW", bob: "BOB_RAW" },
            maxErroredMembers: 1,
        })
        const alice: Partial<MemberState> = { name: "alice", sessionId: "ses_alice", status: "errored" }
        const bob: Partial<MemberState> = { name: "bob", sessionId: "ses_bob", status: "idle" }
        const team = makeTeam({
            activeTask: task,
            members: [alice, bob] as MemberState[],
        })

        const aliceMember = team.members.find(m => m.name === "alice")!
        await handleReduceIdle(ctx, team, aliceMember)

        // No signoff → finishRun directly.
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
    })
})

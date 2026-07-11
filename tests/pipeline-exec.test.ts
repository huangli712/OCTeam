import { describe, expect, test } from "bun:test"

import { processIdle } from "../src/orchestration/idle.js"
import type { ActiveTask, Stage } from "../src/core/types.js"
import { makeCtx, makeTeam, type DispatchCall } from "./helpers.js"

// --- fixtures (pipeline execution path) ---
/**
 * Stub PluginContext. `messages` returns a single user+assistant turn whose
 * assistant text is `outputs[sessionId]` so processIdle Step 4 captures it.
 * `promptAsync` records each dispatch for assertion.
 */

function makePipelineTask(opts: Partial<ActiveTask> & { stages: Stage[] }): ActiveTask {
    return {
        type: "pipeline",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        signoffPolicy: "none",
        ...opts,
    } as ActiveTask
}

// --- stage progression ---

describe("handlePipelineIdle (via processIdle): stage progression", () => {
    test("a non-final stage completes -> advances and dispatches next with upstream context", async () => {
        const calls: DispatchCall[] = []
        const task = makePipelineTask({
            stages: [
                { member: "alice", task: "do step 1", completed: false },
                { member: "bob", task: "do step 2", completed: false },
            ],
            currentStageIndex: 0,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ outputs: { ses_alice: "alice's stage-1 result" }, calls })

        await processIdle(ctx, team, team.members[0], "ses_alice")

        // Stage 0 marked complete, index advanced to stage 1.
        expect(task.stages[0].completed).toBe(true)
        expect(task.currentStageIndex).toBe(1)
        // Stage-1 member dispatched with its own task PLUS the upstream output.
        const bobCall = calls.find(c => c.sessionId === "ses_bob")
        expect(bobCall).toBeDefined()
        expect(bobCall!.text).toContain("do step 2")
        expect(bobCall!.text).toContain("alice's stage-1 result")
        expect(team.members.find(m => m.name === "bob")!.status).toBe("running")
        // The run stays live (not the final stage).
        expect(team.activeTask).toBeDefined()
    })

    test("the final stage completes -> delivers pipeline_complete and idles", async () => {
        const calls: DispatchCall[] = []
        const task = makePipelineTask({
            stages: [{ member: "alice", task: "the only step", completed: false }],
            currentStageIndex: 0,
        })
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const ctx = makeCtx({ outputs: { ses_alice: "final pipeline output" }, calls })

        await processIdle(ctx, team, team.members[0], "ses_alice")

        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("pipeline_complete")
    })

    test("a stray idle from a non-current-stage member does NOT advance the pipeline", async () => {
        const calls: DispatchCall[] = []
        const task = makePipelineTask({
            stages: [
                { member: "alice", task: "step 1", completed: false },
                { member: "bob", task: "step 2", completed: false },
            ],
            currentStageIndex: 0,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        // bob is the stage-1 member; its idle while stage 0 is current is a stray.
        const ctx = makeCtx({ outputs: { ses_bob: "bob jumped ahead" }, calls })

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.currentStageIndex).toBe(0)
        expect(task.stages[0].completed).toBe(false)
        // No downstream dispatch happened from the stray idle.
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)
        expect(team.activeTask).toBeDefined()
    })
})


// --- human-approval gate ---

describe("handlePipelineIdle (via processIdle): human-approval gate", () => {
    test("humanApproval=true pauses after a stage completes before dispatching the next", async () => {
        const calls: DispatchCall[] = []
        const task = makePipelineTask({
            stages: [
                { member: "alice", task: "step 1", completed: false },
                { member: "bob", task: "step 2", completed: false },
            ],
            currentStageIndex: 0,
            humanApproval: true,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ outputs: { ses_alice: "alice's result" }, calls })

        await processIdle(ctx, team, team.members[0], "ses_alice")

        // Stage 0 marked complete, but pipeline paused for approval.
        expect(task.stages[0].completed).toBe(true)
        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest).toBeDefined()
        expect(task.approvalRequest!.kind).toBe("pipeline_stage")
        // Stage 1 NOT dispatched (paused).
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(false)
        // Leader notified of the approval request.
        expect(calls.some(c => c.sessionId === "ses_lead")).toBe(true)
        // Run stays live.
        expect(team.activeTask).toBeDefined()
    })
})

// --- signoff gate ---

describe("handlePipelineIdle (via processIdle): signoff gate", () => {
    test("all stages complete with signoffPolicy=decider triggers signoff (no direct delivery)", async () => {
        const calls: DispatchCall[] = []
        const task = makePipelineTask({
            stages: [{ member: "alice", task: "the only step", completed: false }],
            currentStageIndex: 0,
            signoffPolicy: "decider",
            signoffDecider: "bob",
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob", status: "idle" },
            ],
        })
        const ctx = makeCtx({ outputs: { ses_alice: "final output" }, calls })

        await processIdle(ctx, team, team.members[0], "ses_alice")

        // Signoff stage triggered.
        expect(task.signoffStage).toBe(true)
        // Decider dispatched with review prompt.
        const bobCall = calls.find(c => c.sessionId === "ses_bob")
        expect(bobCall).toBeDefined()
        // NOT directly delivered as pipeline_complete.
        expect(calls.some(c => c.sessionId === "ses_lead" && c.text.includes("pipeline_complete"))).toBe(false)
        // Run stays live (signoff pending).
        expect(team.activeTask).toBeDefined()
    })
})

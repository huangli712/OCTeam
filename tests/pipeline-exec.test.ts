import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { processIdle } from "../src/orchestration/idle.js"
import type { ActiveTask, MemberState, Stage } from "../src/core/types.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { Team } from "../src/state/store.js"
import { type DispatchCall, makeCtx } from "./helpers.js"

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

function makeTeam(opts: {
    activeTask?: ActiveTask
    members?: Array<Partial<MemberState> & Pick<MemberState, "name">>
}): Team {
    const members: MemberState[] = (opts.members ?? []).map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: m.initialized ?? true,
        turnCount: m.turnCount ?? 0,
        sessionId: m.sessionId,
        agent: m.agent,
        isMaster: m.isMaster,
    }))
    return {
        version: 1,
        teamRunId: "test-run",
        teamName: "test-team",
        status: "busy",
        leadSessionId: "ses_lead",
        members,
        bounds: {
            maxMembers: 8,
            maxParallelMembers: 4,
            maxMessagesPerRun: 100,
            maxWallClockMinutes: 30,
            maxMemberTurns: 50,
            maxTasks: 200,
            messagePayloadMaxBytes: 32768,
            messageUnreadMaxBytes: 1048576,
        },
        createdAt: 0,
        activeTask: opts.activeTask,
        mutex: new AsyncMutex(),
        directory: mkdtempSync(join(tmpdir(), "octeam-pipe-")),
    } as unknown as Team
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

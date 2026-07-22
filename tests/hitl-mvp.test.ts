import { describe, expect, test } from 'bun:test';

import type { ActiveTask, GatedStage, LoopTask, MemberState, PipelineTask, Stage, TollgateTask } from "../src/core/types.js"
import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import { handleTollgateIdle } from "../src/orchestration/modes/tollgate.js"
import { teamApproveTool, teamRejectTool } from "../src/tools/control/approve.js"
import { teamProgressTool } from "../src/tools/query/progress.js"
import { loadTeamState, saveTeamState, type Team } from "../src/state/store.js"
import { type DispatchCall, makeCtx, makeHitlLifecycle, makeMember, makeState, makeToolContext, tmpRoot } from './helpers.js';

const { setupTeam } = makeHitlLifecycle()

async function setActiveTask(team: Team, task: ActiveTask): Promise<void> {
    await team.mutex.runExclusive(async () => {
        team.status = "busy"
        team.activeTask = task
        await saveTeamState(team)
    })
}

function baseTaskFields(): Pick<ActiveTask, "startedAt" | "wallClockTimeoutMs" | "tokensUsed" | "tokensByMember" | "messagesSent" | "responses" | "currentStageIndex" | "decisionHistory" | "decisionParseFailures" | "runId"> {
    return {
        startedAt: Date.now(),
        wallClockTimeoutMs: 300_000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
    }
}

function pipelineTask(stages: Stage[]): PipelineTask {
    return {
        type: "pipeline",
        ...baseTaskFields(),
        stages,
        signoffPolicy: "none",
        humanApproval: true,
    }
}

function gate(opts: Partial<GatedStage> & Pick<GatedStage, "member" | "verifier">): GatedStage {
    return {
        member: opts.member,
        verifier: opts.verifier,
        task: opts.task ?? "produce artifact",
        completed: opts.completed ?? false,
        criteria: opts.criteria ?? "must be correct",
        reference: opts.reference,
        verdict: opts.verdict,
        attempts: opts.attempts ?? 0,
        invalidAttempts: opts.invalidAttempts ?? 0,
    }
}

function tollgateTask(stages: GatedStage[]): TollgateTask {
    return {
        type: "tollgate",
        ...baseTaskFields(),
        stages: [],
        gatedStages: stages,
        tollgatePhase: "verify",
        signoffPolicy: "none",
        humanApproval: true,
    }
}

function loopTask(stages: Stage[]): LoopTask {
    return {
        type: "loop",
        ...baseTaskFields(),
        stages,
        deciderMember: "bob",
        currentRound: 1,
        maxRounds: 3,
        humanApproval: true,
    }
}

const PASS = '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>'
const DONE = '<decision>{"decision":"done","rationale":"all checks pass","nextActions":[]}</decision>'

describe("HITL MVP: pipeline", () => {
    test("pauses before the next stage and team_approve resumes it", async () => {
        const root = tmpRoot("hitl-pipeline-approve")
        const sid = "ses_hitl_pipe_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [makeMember("alice", "ses_alice"), makeMember("bob", "ses_bob")])
        const task = pipelineTask([
            { member: "alice", task: "draft", completed: false },
            { member: "bob", task: "review", completed: false },
        ])
        await setActiveTask(team, task)
        const ctx = makeCtx({ storageRoot: root, outputs: { ses_alice: "draft output" }, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await processIdle(ctx, team, team.members[0], "ses_alice")

        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest?.kind).toBe("pipeline_stage")
        expect(calls.some(call => call.sessionId === "ses_bob")).toBe(false)
        expect(calls.some(call => call.sessionId === sid && call.text.includes("team_approve"))).toBe(true)
        const progress = await teamProgressTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))
        expect(progress).toContain("Awaiting approval: pipeline_stage")

        const approvalId = task.approvalRequest?.id
        expect(approvalId).toBeDefined()
        const result = await teamApproveTool(ctx).execute({ team_id: "alpha", approval_id: approvalId }, makeToolContext(sid))

        expect(result).toContain("Approved")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.activeTask?.approvalStage).toBeUndefined()
        expect(after.activeTask?.currentStageIndex).toBe(1)
        expect(calls.some(call => call.sessionId === "ses_bob" && call.text.includes("review"))).toBe(true)
    })

    test("team_reject fails the paused pipeline", async () => {
        const root = tmpRoot("hitl-pipeline-reject")
        const sid = "ses_hitl_pipe_reject_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [makeMember("alice", "ses_alice"), makeMember("bob", "ses_bob")])
        const task = pipelineTask([
            { member: "alice", task: "draft", completed: false },
            { member: "bob", task: "review", completed: false },
        ])
        await setActiveTask(team, task)
        const ctx = makeCtx({ storageRoot: root, outputs: { ses_alice: "bad draft" }, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await processIdle(ctx, team, team.members[0], "ses_alice")
        const result = await teamRejectTool(ctx).execute({ team_id: "alpha", feedback: "needs rewrite" }, makeToolContext(sid))

        expect(result).toContain("Rejected")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.status).toBe("failed")
        expect(after.activeTask).toBeUndefined()
        expect(calls.some(call => call.sessionId === "ses_bob")).toBe(false)
    })
})

describe("HITL MVP: tollgate", () => {
    test("pauses after PASS and team_approve dispatches the next producer", async () => {
        const root = tmpRoot("hitl-tollgate-approve")
        const sid = "ses_hitl_toll_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
            makeMember("dave", "ses_dave"),
            makeMember("eve", "ses_eve"),
        ])
        const task = tollgateTask([
            gate({ member: "alice", verifier: "bob" }),
            gate({ member: "dave", verifier: "eve", task: "integrate" }),
        ])
        task.responses = { alice: "artifact", bob: PASS }
        await setActiveTask(team, task)
        const ctx = makeCtx({ storageRoot: root, outputs: {}, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await handleTollgateIdle(ctx, team, team.members[1])

        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest?.kind).toBe("tollgate_gate")
        expect(calls.some(call => call.sessionId === "ses_dave")).toBe(false)

        const approvalId = task.approvalRequest?.id
        expect(approvalId).toBeDefined()
        const result = await teamApproveTool(ctx).execute({ team_id: "alpha", approval_id: approvalId }, makeToolContext(sid))

        expect(result).toContain("Approved")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.activeTask?.currentStageIndex).toBe(1)
        expect(calls.some(call => call.sessionId === "ses_dave" && call.text.includes("integrate"))).toBe(true)
    })

    test("pauses in produce phase before verifier dispatch (single-gate)", async () => {
        const root = tmpRoot("hitl-tollgate-produce-pause")
        const sid = "ses_hitl_toll_produce_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const task = tollgateTask([gate({ member: "alice", verifier: "bob" })])
        task.tollgatePhase = "produce"
        task.responses = { alice: "<!-- DRIFT: 4.1391e-5 -->" }
        await setActiveTask(team, task)
        const ctx = makeCtx({ storageRoot: root, outputs: {}, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await handleTollgateIdle(ctx, team, team.members[0])

        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest?.kind).toBe("tollgate_gate")
        expect(calls.some(call => call.sessionId === "ses_bob")).toBe(false)

        const approvalId = task.approvalRequest?.id
        expect(approvalId).toBeDefined()
        const result = await teamApproveTool(ctx).execute({ team_id: "alpha", approval_id: approvalId }, makeToolContext(sid))

        expect(result).toContain("Approved")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.activeTask?.approvalStage).toBeUndefined()
        expect(after.activeTask?.type === "tollgate" ? after.activeTask.tollgatePhase : undefined).toBe("verify")
        expect(calls.some(call => call.sessionId === "ses_bob")).toBe(true)
    })
})

describe("HITL MVP: loop", () => {
    test("pauses on decider done; approve finishes and reject continues", async () => {
        const root = tmpRoot("hitl-loop-approve")
        const sid = "ses_hitl_loop_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [makeMember("alice", "ses_alice"), makeMember("bob", "ses_bob")])
        const task = loopTask([
            { member: "alice", task: "write", completed: true },
            { member: "bob", task: "decide", action: "read_only", completed: false },
        ])
        task.currentStageIndex = 1
        await setActiveTask(team, task)
        const ctx = makeCtx({ storageRoot: root, outputs: { ses_bob: DONE }, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest?.kind).toBe("loop_done")
        const approvalId = task.approvalRequest?.id
        expect(approvalId).toBeDefined()

        const result = await teamApproveTool(ctx).execute({ team_id: "alpha", approval_id: approvalId }, makeToolContext(sid))

        expect(result).toContain("Approved")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.status).toBe("idle")
        expect(after.activeTask).toBeUndefined()
        // T8: the human-approved path must deliver the final decision in its
        // summary. Reordering push before deliver makes summarizeLoop render
        // "final: done" instead of "final: n/a".
        const summaryCall = calls.find(c => c.text.includes("loop_complete:human_approved"))
        expect(summaryCall).toBeDefined()
        expect(summaryCall!.text).toContain("[final]")
        expect(summaryCall!.text).toContain("round 1: done")
    })

    test("rejecting loop done continues the next round", async () => {
        const root = tmpRoot("hitl-loop-reject")
        const sid = "ses_hitl_loop_reject_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [makeMember("alice", "ses_alice"), makeMember("bob", "ses_bob")])
        const task = loopTask([
            { member: "alice", task: "write", completed: true },
            { member: "bob", task: "decide", action: "read_only", completed: false },
        ])
        task.currentStageIndex = 1
        await setActiveTask(team, task)
        const ctx = makeCtx({ storageRoot: root, outputs: { ses_bob: DONE }, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await processIdle(ctx, team, team.members[1], "ses_bob")
        const result = await teamRejectTool(ctx).execute({ team_id: "alpha", feedback: "missing edge case" }, makeToolContext(sid))

        expect(result).toContain("Rejected")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.status).toBe("busy")
        expect(after.activeTask?.currentRound).toBe(2)
        expect(after.activeTask?.currentStageIndex).toBe(0)
        expect(calls.some(call => call.sessionId === "ses_alice" && call.text.includes("missing edge case"))).toBe(true)
    })
})

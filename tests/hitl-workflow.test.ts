/**
 * HITL tests for team_workflow (Wave 3 T6). Mirrors hitl-mvp.test.ts: a
 * workflow with human_approval=true pauses after a step completes (before the
 * next step) with kind="workflow_step"; team_approve advances, team_reject
 * fails the run with workflow_human_rejected.
 */
import { describe, expect, test } from 'bun:test';

import type { ActiveTask, WorkflowStep, WorkflowTask } from "../src/core/types.js"
import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import { teamApproveTool, teamRejectTool } from "../src/tools/control/approve.js"
import { teamProgressTool } from "../src/tools/query/progress.js"
import { loadTeamState, saveTeamState, type Team } from "../src/state/store.js"
import { type DispatchCall, makeCtx, makeHitlLifecycle, makeMember, makeToolContext, tmpRoot } from './helpers.js';

const { setupTeam } = makeHitlLifecycle()

async function setActiveTask(team: Team, task: ActiveTask): Promise<void> {
    await team.mutex.runExclusive(async () => {
        team.status = "busy"
        team.activeTask = task
        await saveTeamState(team)
    })
}

function workflowTask(steps: WorkflowStep[]): WorkflowTask {
    return {
        type: "workflow",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300_000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        signoffPolicy: "none",
        humanApproval: true,
        steps,
    } as WorkflowTask
}

describe("HITL: team_workflow", () => {
    test("pauses after a task step completes and team_approve advances to the next step", async () => {
        const root = tmpRoot("hitl-wf-approve")
        const sid = "ses_hitl_wf_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const task = workflowTask([
            { kind: "task", member: "alice", task: "draft", completed: false },
            { kind: "task", member: "bob", task: "polish", completed: false },
        ])
        await setActiveTask(team, task)
        const ctx = makeCtx({ storageRoot: root, outputs: { ses_alice: "draft output" }, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await processIdle(ctx, team, team.members[0], "ses_alice")

        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest?.kind).toBe("workflow_step")
        // Next step's member NOT dispatched while paused.
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(false)
        expect(calls.some(c => c.sessionId === sid && c.text.includes("team_approve"))).toBe(true)
        const approvalCall = calls.find(c => c.sessionId === sid && c.text.includes("Human approval required"))
        expect(approvalCall?.text).toContain("workflow_step (step 1)")
        expect(approvalCall?.text).toContain("Next: step 2 (task) by bob")
        const progress = await teamProgressTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))
        expect(progress).toContain("Awaiting approval: workflow_step")

        const approvalId = task.approvalRequest?.id
        expect(approvalId).toBeDefined()
        const result = await teamApproveTool(ctx).execute({ team_id: "alpha", approval_id: approvalId }, makeToolContext(sid))

        expect(result).toContain("Approved")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.activeTask?.approvalStage).toBeUndefined()
        expect(after.activeTask?.currentStageIndex).toBe(1)
        expect(calls.some(c => c.sessionId === "ses_bob" && c.text.includes("polish"))).toBe(true)
    })

    test("team_reject fails the paused workflow with workflow_human_rejected", async () => {
        const root = tmpRoot("hitl-wf-reject")
        const sid = "ses_hitl_wf_reject_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const task = workflowTask([
            { kind: "task", member: "alice", task: "draft", completed: false },
            { kind: "task", member: "bob", task: "polish", completed: false },
        ])
        await setActiveTask(team, task)
        const ctx = makeCtx({ storageRoot: root, outputs: { ses_alice: "draft output" }, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await processIdle(ctx, team, team.members[0], "ses_alice")
        const result = await teamRejectTool(ctx).execute({ team_id: "alpha", feedback: "redo this step" }, makeToolContext(sid))

        expect(result).toContain("Rejected")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.status).toBe("failed")
        expect(after.activeTask).toBeUndefined()
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(false)
    })

    test("invalid approval_id is rejected", async () => {
        const root = tmpRoot("hitl-wf-bad-id")
        const sid = "ses_hitl_wf_bad_id"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const task = workflowTask([
            { kind: "task", member: "alice", task: "draft", completed: false },
            { kind: "task", member: "bob", task: "polish", completed: false },
        ])
        await setActiveTask(team, task)
        const ctx = makeCtx({ storageRoot: root, outputs: { ses_alice: "draft output" }, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await processIdle(ctx, team, team.members[0], "ses_alice")
        expect(task.approvalStage).toBe(true)

        // Approve with a WRONG approval_id → must be rejected
        const result = await teamApproveTool(ctx).execute({ team_id: "alpha", approval_id: "bogus-id-that-does-not-match" }, makeToolContext(sid))
        expect(result).toContain("does not match")

        // Task is still paused — bob was NOT dispatched
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(false)
    })

    test("duplicate approval (second approve after first succeeds) is rejected", async () => {
        const root = tmpRoot("hitl-wf-dup")
        const sid = "ses_hitl_wf_dup"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const task = workflowTask([
            { kind: "task", member: "alice", task: "draft", completed: false },
            { kind: "task", member: "bob", task: "polish", completed: false },
        ])
        await setActiveTask(team, task)
        const ctx = makeCtx({ storageRoot: root, outputs: { ses_alice: "draft output" }, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await processIdle(ctx, team, team.members[0], "ses_alice")
        const approvalId = task.approvalRequest?.id
        expect(approvalId).toBeDefined()

        // First approve succeeds
        const result1 = await teamApproveTool(ctx).execute({ team_id: "alpha", approval_id: approvalId }, makeToolContext(sid))
        expect(result1).toContain("Approved")

        // Second approve — no pending approval left
        const result2 = await teamApproveTool(ctx).execute({ team_id: "alpha", approval_id: approvalId }, makeToolContext(sid))
        expect(result2).toContain("no pending")
    })
})

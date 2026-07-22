import { describe, expect, test } from 'bun:test';

import type { ArbitrateTask, MemberState } from "../src/core/types.js"
import { handleArbitrateIdle } from "../src/orchestration/modes/arbitrate.js"
import { teamApproveTool, teamRejectTool } from "../src/tools/control/approve.js"
import { loadTeamState, saveTeamState, type Team } from "../src/state/store.js"
import { type DispatchCall, makeCtx, makeHitlLifecycle, makeMember, makeState, makeToolContext, tmpRoot } from './helpers.js';

const RULING = '<ruling>{"decision":"ship Friday","rationale":"risk is low"}</ruling>'

const { setupTeam } = makeHitlLifecycle()

async function setArbitrateTask(team: Team, task: ArbitrateTask): Promise<void> {
    await team.mutex.runExclusive(async () => {
        team.status = "busy"
        team.activeTask = task
        await saveTeamState(team)
    })
}

function arbitrateTask(): ArbitrateTask {
    return {
        type: "arbitrate",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300_000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: { arbiter: RULING },
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        task: "Should we ship on Friday?",
        arbiterMember: "arbiter",
        disputants: ["alice", "bob"],
        arbitrationStage: true,
        hitlPhase: "post",    // existing tests verify the post-ruling pause point
        maxRounds: 1,
        currentRound: 1,
        signoffPolicy: "none",
        humanApproval: true,
        approvalHistory: [],
    }
}

describe("HITL arbitrate ruling approval", () => {
    test("pauses after ruling and team_approve delivers", async () => {
        const root = tmpRoot("hitl-arb-approve")
        const sid = "ses_hitl_arb_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("arbiter", "ses_arbiter"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const task = arbitrateTask()
        await setArbitrateTask(team, task)
        const ctx = makeCtx({ storageRoot: root, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await handleArbitrateIdle(ctx, team)

        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest?.kind).toBe("arbitrate_ruling")
        expect(task.arbitrationRuling).toBe("ship Friday")
        expect(calls.some(call => call.sessionId === sid && call.text.includes("team_approve"))).toBe(true)

        const result = await teamApproveTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))

        expect(result).toContain("Approved")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.status).toBe("idle")
        expect(after.activeTask).toBeUndefined()
        expect(calls.some(call => call.text.includes("arbitrate_complete"))).toBe(true)
    })

    test("team_reject fails the ruled arbitrate", async () => {
        const root = tmpRoot("hitl-arb-reject")
        const sid = "ses_hitl_arb_reject_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("arbiter", "ses_arbiter"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const task = arbitrateTask()
        await setArbitrateTask(team, task)
        const ctx = makeCtx({ storageRoot: root, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await handleArbitrateIdle(ctx, team)
        const result = await teamRejectTool(ctx).execute({ team_id: "alpha", feedback: "unacceptable" }, makeToolContext(sid))

        expect(result).toContain("Rejected")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.status).toBe("failed")
        expect(after.activeTask).toBeUndefined()
    })
})

describe("HITL arbitrate pre-ruling approval (default hitlPhase)", () => {
    test("pauses before arbiter dispatch when hitlPhase is 'pre'", async () => {
        const root = tmpRoot("hitl-arb-pre")
        const sid = "ses_hitl_arb_pre_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("arbiter", "ses_arbiter"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const task: ArbitrateTask = {
            ...arbitrateTask(),
            hitlPhase: "pre",
            arbitrationStage: false,   // Phase A->B transition moment: debate done
            responses: {},             // arbiter not dispatched yet
            currentRound: 1,
            maxRounds: 1,
        }
        await setArbitrateTask(team, task)
        const ctx = makeCtx({ storageRoot: root, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await handleArbitrateIdle(ctx, team)

        // HITL pause triggered, arbiter NOT dispatched
        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest?.kind).toBe("arbitrate_ruling")
        expect(task.arbitrationStage).toBe(true)            // transitioned past Phase A
        expect(calls.some(c => c.sessionId === "ses_arbiter")).toBe(false)
        // Leader notified
        expect(calls.some(c => c.sessionId === sid && c.text.includes("team_approve"))).toBe(true)

        const result = await teamApproveTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))
        expect(result).toContain("Approved")
        // After approve, arbiter dispatched
        expect(calls.some(c => c.sessionId === "ses_arbiter")).toBe(true)
    })

    test("team_reject fails the pre-ruling arbitrate", async () => {
        const root = tmpRoot("hitl-arb-pre-reject")
        const sid = "ses_hitl_arb_pre_reject_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("arbiter", "ses_arbiter"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const task: ArbitrateTask = {
            ...arbitrateTask(),
            hitlPhase: "pre",
            arbitrationStage: false,
            responses: {},
            currentRound: 1,
            maxRounds: 1,
        }
        await setArbitrateTask(team, task)
        const ctx = makeCtx({ storageRoot: root, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await handleArbitrateIdle(ctx, team)
        const result = await teamRejectTool(ctx).execute({ team_id: "alpha", feedback: "redo debate" }, makeToolContext(sid))

        expect(result).toContain("Rejected")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.status).toBe("failed")
        expect(after.activeTask).toBeUndefined()
    })

    test("pauses at both points when hitlPhase is 'both'", async () => {
        const root = tmpRoot("hitl-arb-both")
        const sid = "ses_hitl_arb_both_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("arbiter", "ses_arbiter"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        // Pre-ruling: simulate Phase A->B transition
        const task: ArbitrateTask = {
            ...arbitrateTask(),
            hitlPhase: "both",
            arbitrationStage: false,
            responses: {},
            currentRound: 1,
            maxRounds: 1,
        }
        await setArbitrateTask(team, task)
        const ctx = makeCtx({ storageRoot: root, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        // Drive Phase A->B: first pause (pre-ruling)
        await handleArbitrateIdle(ctx, team)
        expect(task.approvalStage).toBe(true)
        expect(calls.some(c => c.sessionId === "ses_arbiter")).toBe(false)

        // Approve pre-ruling -> arbiter dispatched
        await teamApproveTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))
        expect(calls.some(c => c.sessionId === "ses_arbiter")).toBe(true)

        // Simulate arbiter response + second idle -> second pause (post-ruling)
        await team.mutex.runExclusive(async () => {
            task.responses.arbiter = RULING
            task.approvalStage = undefined
            task.approvalRequest = undefined
            await saveTeamState(team)
        })
        await handleArbitrateIdle(ctx, team)
        expect(task.approvalStage).toBe(true)
        expect(task.arbitrationRuling).toBe("ship Friday")

        // Approve post-ruling -> finishRun delivers
        await teamApproveTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.status).toBe("idle")
        expect(after.activeTask).toBeUndefined()
    })
})

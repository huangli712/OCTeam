import { afterEach, describe, expect, test } from "bun:test"

import type { MemberState, RouteBranch, RouteTask } from "../src/core/types.js"
import { handleRouteIdle } from "../src/orchestration/modes/route.js"
import { teamApproveTool, teamRejectTool } from "../src/tools/approve.js"
import { initTeamState, loadTeamState, saveTeamState, type Team } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { makeCtx, makeMember, makeState, makeToolContext, tmpRoot, type DispatchCall } from "./helpers.js"

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

async function setupTeam(root: string, sid: string, members: MemberState[]): Promise<Team> {
    tracked.push(sid)
    for (const member of members) {
        if (member.sessionId) tracked.push(member.sessionId)
    }
    await initTeamState(root, makeState("alpha", sid, members, Date.now()), sid)
    await rebuildSessionIndex(root, `${root}__user_unused`)
    return loadTeamState(root, "alpha", sid)
}

async function setRouteTask(team: Team, task: RouteTask): Promise<void> {
    await team.mutex.runExclusive(async () => {
        team.status = "busy"
        team.activeTask = task
        await saveTeamState(team)
    })
}

function routeTask(branches: RouteBranch[]): RouteTask {
    return {
        type: "route",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300_000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {
            router: '<route>{"branch":"support","rationale":"billing"}</route>',
        },
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        task: "route this request",
        routerMember: "router",
        routeBranches: branches,
        routeStage: false,
        signoffPolicy: "none",
        humanApproval: true,
        approvalHistory: [],
    }
}

describe("HITL route decision approval", () => {
    test("router decision pauses before branch fan-out and team_approve dispatches the selected branch", async () => {
        const root = tmpRoot("hitl-route-approve")
        const sid = "ses_hitl_route_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("router", "ses_router"),
            makeMember("sales", "ses_sales"),
            makeMember("support", "ses_support"),
        ])
        const task = routeTask([
            { name: "sales", member: "sales", task: "sell" },
            { name: "support", member: "support", task: "help" },
        ])
        await setRouteTask(team, task)
        const ctx = makeCtx({ storageRoot: root, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await handleRouteIdle(ctx, team)

        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest?.kind).toBe("route_decision")
        expect(task.routeStage).toBe(true)
        expect(task.routeTargets).toEqual(["support"])
        expect(calls.some(call => call.sessionId === "ses_support")).toBe(false)
        expect(calls.some(call => call.sessionId === sid && call.text.includes("team_approve"))).toBe(true)

        const result = await teamApproveTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))

        expect(result).toContain("Approved")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.activeTask?.approvalStage).toBeUndefined()
        expect(calls.some(call => call.sessionId === "ses_support" && call.text.includes("help"))).toBe(true)
        expect(calls.some(call => call.sessionId === "ses_sales")).toBe(false)
    })

    test("team_reject fails the route before branch fan-out", async () => {
        const root = tmpRoot("hitl-route-reject")
        const sid = "ses_hitl_route_reject_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("router", "ses_router"),
            makeMember("support", "ses_support"),
        ])
        const task = routeTask([{ name: "support", member: "support", task: "help" }])
        await setRouteTask(team, task)
        const ctx = makeCtx({ storageRoot: root, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await handleRouteIdle(ctx, team)
        const result = await teamRejectTool(ctx).execute({ team_id: "alpha", feedback: "wrong branch" }, makeToolContext(sid))

        expect(result).toContain("Rejected")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.status).toBe("failed")
        expect(after.activeTask).toBeUndefined()
        expect(calls.some(call => call.sessionId === "ses_support")).toBe(false)
    })
})

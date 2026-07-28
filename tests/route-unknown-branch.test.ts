/**
 * H47 (2026-07-28 audit): route silently accepts partial unknown branch.
 *
 * Bug: handleRouteIdle (route.ts:90) filters known branches via
 *   selected = branches.filter(b => decision.targets.includes(b.name))
 * If decision.targets = ["known", "typo"], only "known" is dispatched and
 * "typo" is silently dropped — the router's required work is lost without
 * feedback. Only when selected.length === 0 (all unknown) does the run fail.
 *
 * Fix: detect unknown targets and fail the run with a descriptive reason
 * so the operator knows the router emitted an invalid branch name.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"

import { handleRouteIdle } from "../src/orchestration/modes/route.js"
import type { MemberState, RouteBranch, RouteTask } from "../src/core/types.js"
import { initTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { type DispatchCall, cleanupTmpRoots, makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

function makeRouteTask(opts: Partial<RouteTask> = {}): RouteTask {
    return {
        type: "route",
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
        runId: crypto.randomUUID(),
        routerMember: "router",
        routeStage: false,
        signoffPolicy: "none",
        task: "route-input",
        ...opts,
    } as RouteTask
}

const LEAD = "ses_h47_lead"

describe("H47: route rejects partial unknown branch names", () => {
    afterEach(() => {
        unindexSession(LEAD)
    })

    test("decision with one known + one unknown target → fail (not silent partial dispatch)", async () => {
        const root = tmpRoot("h47-partial-unknown")
        const branches: RouteBranch[] = [
            { name: "sales", member: "alice" },
            { name: "support", member: "bob" },
        ]
        const task = makeRouteTask({
            routeBranches: branches,
            routerMember: "router",
            // Router decision includes a known target ("sales") AND an unknown one ("typo").
            responses: {
                router: '<route>{"branches": ["sales", "typo"], "rationale": "mixed"}</route>',
            },
        })
        const members: MemberState[] = [
            { name: "router", sessionId: "ses_router", status: "idle", initialized: true, turnCount: 0 } as MemberState,
            { name: "alice", sessionId: "ses_alice", status: "idle", initialized: true, turnCount: 0 } as MemberState,
            { name: "bob", sessionId: "ses_bob", status: "idle", initialized: true, turnCount: 0 } as MemberState,
        ]
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const team = await initTeamState(
            root,
            makeState("h47-team", LEAD, members, Date.now()),
            LEAD,
        )
        team.activeTask = task
        team.status = "busy"

        await team.mutex.runExclusive(async () => {
            await handleRouteIdle(ctx, team)
        })

        // On UNFIXED code: "sales" dispatched, "typo" silently dropped,
        // run proceeds (routeStage=true). The router's partial work is lost.
        // On FIXED code: run fails with a descriptive reason naming the
        // unknown target.
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
    })

    test("decision with all-known targets → normal dispatch (control)", async () => {
        const root = tmpRoot("h47-all-known")
        const branches: RouteBranch[] = [
            { name: "sales", member: "alice" },
            { name: "support", member: "bob" },
        ]
        const task = makeRouteTask({
            routeBranches: branches,
            routerMember: "router",
            responses: {
                router: '<route>{"branches": ["sales", "support"], "rationale": "both"}</route>',
            },
        })
        const members: MemberState[] = [
            { name: "router", sessionId: "ses_router", status: "idle", initialized: true, turnCount: 0 } as MemberState,
            { name: "alice", sessionId: "ses_alice", status: "idle", initialized: true, turnCount: 0 } as MemberState,
            { name: "bob", sessionId: "ses_bob", status: "idle", initialized: true, turnCount: 0 } as MemberState,
        ]
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const team = await initTeamState(
            root,
            makeState("h47-team-ctrl", LEAD, members, Date.now()),
            LEAD,
        )
        team.activeTask = task
        team.status = "busy"

        await team.mutex.runExclusive(async () => {
            await handleRouteIdle(ctx, team)
        })

        // Normal: both targets dispatched, routeStage=true.
        expect(team.status).toBe("busy")
        expect(task.routeStage).toBe(true)
    })
})

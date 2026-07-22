/**
 * Resume-dispatch regression tests for team_resume Phase 3: route mode (Phase A and Phase B).
 * Split from resume-dispatch-branches.test.ts; drives resumeDispatch directly.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import type { ActiveTask } from "../src/core/types.js";
import {
    initTeamState,
    loadTeamState,
    saveTeamState,
} from "../src/state/store.js";
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js";
import { resumeDispatch } from "../src/orchestration/lifecycle/resume.js";
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeTask, tmpRoot } from './helpers.js';


const tracked: string[] = [];
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid);
});
afterAll(cleanupTmpRoots)

/** Commit a task as the active task on a freshly-loaded failed team, indexed. */
async function setup(
    root: string,
    sid: string,
    task: ActiveTask,
    members: ReturnType<typeof makeMember>[],
): Promise<ReturnType<typeof loadTeamState>> {
    const state = makeState("alpha", sid, members, Date.now());
    await initTeamState(root, state, sid);
    const team = await loadTeamState(root, "alpha", sid);
    await team.mutex.runExclusive(async () => {
        team.activeTask = task;
        await saveTeamState(team);
    });
    await rebuildSessionIndex(root, `${root}__unused`);
    return team;
}

describe("resumeDispatch: route Phase A with NO captured router output", () => {
    test("router has no response → the router is re-dispatched (not a target)", async () => {
        const root = tmpRoot("rdb-route-router");
        const sid = "ses_rdb_route_router";
        tracked.push(sid);
        // routeStage not set, router has produced nothing yet → re-dispatch router.
        const task = makeTask({
            type: "route",
            routerMember: "router",
            routeStage: false,
            task: "classify this ticket",
            routeBranches: [
                { name: "sales", member: "alice" },
                { name: "support", member: "bob" },
            ],
            responses: {},
        });
        const team = await setup(root, sid, task, [
            makeMember("router", "ses_router"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ]);

        const dispatched: { id: string; text: string }[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push({ id: req.path.id, text: (req.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "") });
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // Only the router is re-dispatched with the routing prompt; no targets yet.
        expect(dispatched.map((d) => d.id)).toEqual(["ses_router"]);
        expect(dispatched[0].text).toContain("classify this ticket");
        expect(team.activeTask).toBeDefined();
    });
});

describe("resumeDispatch: route Phase B target re-dispatch", () => {
    test("routeStage set + a target lacks a response → only that target is re-dispatched", async () => {
        const root = tmpRoot("rdb-route-targets");
        const sid = "ses_rdb_route_targets";
        tracked.push(sid);
        // Phase B: router decided (routeStage=true, targets alice+bob). alice
        // responded pre-crash; bob did not → re-dispatch only bob.
        const task = makeTask({
            type: "route",
            routerMember: "router",
            routeStage: true,
            routeTargets: ["alice", "bob"],
            task: "the routed input",
            routeBranches: [
                { name: "sales", member: "alice", task: "handle sale" },
                { name: "support", member: "bob", task: "handle support" },
            ],
            responses: {
                router: '<route>{"branches":["sales","support"]}</route>',
                alice: "alice-done",
            },
        });
        const team = await setup(root, sid, task, [
            makeMember("router", "ses_router"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ]);

        const dispatched: { id: string; text: string }[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push({ id: req.path.id, text: (req.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "") });
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // Only bob (no response) is re-dispatched with his branch task; alice is skipped.
        expect(dispatched.map((d) => d.id)).toEqual(["ses_bob"]);
        expect(dispatched[0].text).toBe("handle support");
        expect(team.activeTask).toBeDefined();
    });

    test("routeStage set + ALL targets responded → barrier re-driven (delivers, no re-dispatch)", async () => {
        const root = tmpRoot("rdb-route-barrier");
        const sid = "ses_rdb_route_barrier";
        tracked.push(sid);
        // Phase B zero-dispatch: both targets already responded → handleRouteIdle
        // re-drives the barrier and delivers.
        const task = makeTask({
            type: "route",
            routerMember: "router",
            routeStage: true,
            routeTargets: ["alice", "bob"],
            task: "the routed input",
            routeBranches: [
                { name: "sales", member: "alice" },
                { name: "support", member: "bob" },
            ],
            responses: {
                router: '<route>{"branches":["sales","support"]}</route>',
                alice: "A",
                bob: "B",
            },
        });
        const team = await setup(root, sid, task, [
            { ...makeMember("router", "ses_router"), status: "idle" },
            { ...makeMember("alice", "ses_alice"), status: "idle" },
            { ...makeMember("bob", "ses_bob"), status: "idle" },
        ]);

        const dispatched: string[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push(req.path.id);
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // No target re-dispatched; only the leader receives the route_complete summary.
        expect(dispatched).toEqual([sid]);
        expect(team.status).toBe("idle");
        expect(team.activeTask).toBeUndefined();
    });
});

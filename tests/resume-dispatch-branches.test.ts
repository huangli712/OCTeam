/**
 * Coverage-gap regression tests for resumeDispatch (src/tools/dispatch.ts) — the
 * 9-way per-mode re-dispatch switch used by team_resume Phase 3.
 *
 * GAP CLOSED: existing resume tests cover parallel, pipeline (advance), delegate,
 * recurse, route Phase-A-with-captured-router, arbitrate, tollgate, and the
 * signoff/reduce pre-checks. The following branches had NO direct test (verified
 * against the bun --coverage uncovered-line set for tools/dispatch.ts):
 *   - reduce sub-stage where the reducer ALREADY responded → handleReduceIdle
 *     (dispatch.ts:78-79)
 *   - consensus re-dispatch loop: round < maxRounds AND a member lacks a
 *     response → that member is re-dispatched (dispatch.ts:138-154)
 *   - pipeline/loop ALL-COMPLETE crash edge: currentStageIndex >= stages.length
 *     → deliver + clear (dispatch.ts:161-165)
 *   - loop mid-stage resume → advanceToStage (the loop half of the shared case)
 *   - route Phase A with NO captured router output → router re-dispatched
 *     (dispatch.ts:199-216)
 *   - route Phase B (routeStage set) → targets without responses re-dispatched
 *     (dispatch.ts:222-237)
 *
 * These drive resumeDispatch directly (mirrors resume-signoff-reduce.test.ts),
 * which is exactly what team_resume Phase 3 calls under the mutex.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { ActiveTask } from "../src/core/types.js";
import {
    initTeamState,
    loadTeamState,
    saveTeamState,
} from "../src/state/store.js";
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js";
import { resumeDispatch } from "../src/orchestration/lifecycle/resume.js";
import { makeCtx, makeMember, makeState, makeTask, tmpRoot } from "./helpers.js";


const tracked: string[] = [];
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid);
});

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

describe("resumeDispatch: reduce sub-stage where reducer ALREADY responded", () => {
    test("reducer has a response → handleReduceIdle runs (NOT a re-dispatch)", async () => {
        const root = tmpRoot("rdb-reduce-responded");
        const sid = "ses_rdb_reduce";
        tracked.push(sid);
        // reduceStage set, reducer bob HAS produced output → the resume path must
        // re-drive handleReduceIdle to capture+continue, not re-dispatch bob.
        const task = makeTask({
            type: "parallel",
            reducePolicy: "merge",
            reducerMember: "bob",
            reduceStage: true,
            responses: { alice: "a", dave: "d", bob: "MERGED RESULT" },
        });
        const alice = makeMember("alice", "ses_alice");
        const bob = makeMember("bob", "ses_bob");
        const dave = makeMember("dave", "ses_dave");
        const team = await setup(root, sid, task, [alice, bob, dave]);

        const dispatched: string[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push(req.path.id);
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // handleReduceIdle captured the reducer's result and delivered to leader;
        // bob was NOT re-dispatched. The leader (sid) receives the summary.
        expect(dispatched).not.toContain("ses_bob");
        expect(team.activeTask).toBeUndefined();
        expect(team.status).toBe("idle");
    });
});

describe("resumeDispatch: consensus re-dispatch loop", () => {
    test("round < maxRounds + a member lacks a response → that member is re-dispatched", async () => {
        const root = tmpRoot("rdb-consensus-redispatch");
        const sid = "ses_rdb_consensus";
        tracked.push(sid);
        // currentRound (0) < maxRounds (2); alice answered, bob did not →
        // resume must re-dispatch ONLY bob with the consensus round prompt.
        const task = makeTask({
            type: "consensus",
            topic: "ship or wait",
            currentRound: 0,
            maxRounds: 2,
            responses: { alice: "agree" },
        });
        const alice = makeMember("alice", "ses_alice");
        const bob = makeMember("bob", "ses_bob");
        const team = await setup(root, sid, task, [alice, bob]);

        const dispatched: { id: string; text: string }[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push({ id: req.path.id, text: (req.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "") });
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // Only bob re-dispatched (alice already responded), carrying the consensus prompt.
        expect(dispatched.map((d) => d.id)).toEqual(["ses_bob"]);
        expect(dispatched[0].text).toContain("Consensus Round");
        expect(dispatched[0].text).toContain("ship or wait");
        // Run stays live (still collecting this round).
        expect(team.activeTask).toBeDefined();
    });
});

describe("resumeDispatch: pipeline/loop all-complete crash edge", () => {
    test("currentStageIndex >= stages.length → delivers + clears (no dispatch)", async () => {
        const root = tmpRoot("rdb-pipeline-allcomplete");
        const sid = "ses_rdb_pipe_done";
        tracked.push(sid);
        // Crash happened AFTER the last stage completed but BEFORE delivery:
        // currentStageIndex (2) == stages.length (2).
        const task = makeTask({
            type: "pipeline",
            stages: [
                { member: "alice", task: "s1", completed: true },
                { member: "bob", task: "s2", completed: true },
            ],
            currentStageIndex: 2,
            responses: { alice: "A", bob: "B" },
        });
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ]);

        const dispatched: string[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push(req.path.id);
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // No member re-dispatched; only the leader receives the completion summary.
        expect(dispatched).toEqual([sid]);
        expect(team.status).toBe("idle");
        expect(team.activeTask).toBeUndefined();
    });

    test("loop mid-stage resume → advanceToStage dispatches the current stage member", async () => {
        const root = tmpRoot("rdb-loop-midstage");
        const sid = "ses_rdb_loop_mid";
        tracked.push(sid);
        // Loop crashed at stage index 1 (bob's stage) within the round.
        const task = makeTask({
            type: "loop",
            stages: [
                { member: "alice", task: "code", completed: true },
                { member: "bob", task: "review", completed: false },
            ],
            currentStageIndex: 1,
            currentRound: 1,
            maxRounds: 3,
            deciderMember: "bob",
            responses: { alice: "ALICE_LOOP_OUTPUT" },
        });
        const team = await setup(root, sid, task, [
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

        // Only bob (current stage) is re-dispatched, with upstream context injected.
        expect(dispatched.map((d) => d.id)).toEqual(["ses_bob"]);
        expect(dispatched[0].text).toContain("review");
        expect(dispatched[0].text).toContain("ALICE_LOOP_OUTPUT");
        expect(team.activeTask).toBeDefined();
    });
});

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

describe("resumeDispatch: workflow all-complete crash edge", () => {
    test("all steps completed pre-crash -> delivers + clears (no re-dispatch)", async () => {
        const root = tmpRoot("rdb-wf-allcomplete");
        const sid = "ses_rdb_wf_done";
        tracked.push(sid);
        // Crash happened AFTER the last step completed but BEFORE delivery:
        // every step completed; currentStageIndex is past the end.
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "do work",
                    completed: true,
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "ok",
                    onFail: "fail",
                    maxRetries: 0,
                    attempts: 0,
                    completed: true,
                    verdict: "PASS",
                },
            ],
            currentStageIndex: 2,
            responses: {
                alice: "A",
                bob: '<verdict>{"result":"PASS","rationale":"","diff":""}</verdict>',
            },
        });
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ]);

        const dispatched: string[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push(req.path.id);
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // No member re-dispatched; only the leader receives workflow_complete.
        expect(dispatched).toEqual([sid]);
        expect(team.status).toBe("idle");
        expect(team.activeTask).toBeUndefined();
    });
});

describe("resumeDispatch: workflow fanout active frontier", () => {
    test("one branch already responded and one active branch is missing -> re-dispatches only the missing branch", async () => {
        const root = tmpRoot("rdb-wf-fanout-missing");
        const sid = "ses_rdb_wf_fanout_missing";
        tracked.push(sid);
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "tests"],
                        branchRanges: [
                            { startIndex: 1, endIndex: 1 },
                            { startIndex: 2, endIndex: 2 },
                        ],
                        joinIndex: 3,
                        maxErrored: 0,
                    },
                },
                {
                    kind: "task",
                    member: "alice",
                    task: "build api branch",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "api",
                        branchIndex: 0,
                        joinIndex: 3,
                    },
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "build test branch",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "tests",
                        branchIndex: 1,
                        joinIndex: 3,
                    },
                },
                {
                    kind: "join",
                    completed: false,
                    join: {
                        fanoutIndex: 0,
                        branchTailIndices: [1, 2],
                        maxErrored: 0,
                    },
                },
            ],
            currentStageIndex: 1,
            activeStepIndices: [1, 2],
            responses: { alice: "api branch output" },
        });
        const team = await setup(root, sid, task, [
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

        const wfTask = team.activeTask as Extract<
            ActiveTask,
            { type: "workflow" }
        >;
        expect(wfTask.steps?.[1].completed).toBe(true);
        expect(wfTask.steps?.[1].output).toBe("api branch output");
        expect(wfTask.steps?.[2].completed).toBe(false);
        expect(dispatched.map((d) => d.id)).toEqual(["ses_bob"]);
        expect(dispatched[0].text).toContain("build test branch");
    });

    test("missing branch actor during resume degrades that branch and advances survivors", async () => {
        const root = tmpRoot("rdb-wf-fanout-missing-actor");
        const sid = "ses_rdb_wf_fanout_missing_actor";
        tracked.push(sid);
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "tests"],
                        branchRanges: [
                            { startIndex: 1, endIndex: 1 },
                            { startIndex: 2, endIndex: 2 },
                        ],
                        joinIndex: 3,
                        maxErrored: 1,
                    },
                },
                {
                    kind: "task",
                    member: "alice",
                    task: "build api branch",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "api",
                        branchIndex: 0,
                        joinIndex: 3,
                    },
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "build test branch",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "tests",
                        branchIndex: 1,
                        joinIndex: 3,
                    },
                },
                {
                    kind: "join",
                    completed: false,
                    join: {
                        fanoutIndex: 0,
                        branchTailIndices: [1, 2],
                        maxErrored: 1,
                    },
                },
            ],
            currentStageIndex: 1,
            activeStepIndices: [1, 2],
            responses: {},
        });
        const team = await setup(root, sid, task, [
            makeMember("alice"),
            makeMember("bob", "ses_bob"),
        ]);

        const dispatched: { id: string; text: string }[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push({ id: req.path.id, text: (req.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "") });
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        const wfTask = team.activeTask as Extract<
            ActiveTask,
            { type: "workflow" }
        >;
        // api branch degraded (alice has no live session)
        expect(wfTask.steps?.[1].skipped).toBe(true);
        expect(wfTask.steps?.[3].join?.erroredBranchIds).toEqual(["api"]);
        // tests branch actor still dispatched (resume continued past degradation)
        expect(dispatched.map((d) => d.id)).toEqual(["ses_bob"]);
        expect(dispatched[0].text).toContain("build test branch");
    });

    test("all active branches already responded -> re-drives the ready join and downstream step", async () => {
        const root = tmpRoot("rdb-wf-fanout-join");
        const sid = "ses_rdb_wf_fanout_join";
        tracked.push(sid);
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "tests"],
                        branchRanges: [
                            { startIndex: 1, endIndex: 1 },
                            { startIndex: 2, endIndex: 2 },
                        ],
                        joinIndex: 3,
                        maxErrored: 0,
                    },
                },
                {
                    kind: "task",
                    member: "alice",
                    task: "build api branch",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "api",
                        branchIndex: 0,
                        joinIndex: 3,
                    },
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "build test branch",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "tests",
                        branchIndex: 1,
                        joinIndex: 3,
                    },
                },
                {
                    kind: "join",
                    completed: false,
                    join: {
                        fanoutIndex: 0,
                        branchTailIndices: [1, 2],
                        maxErrored: 0,
                    },
                },
                {
                    kind: "task",
                    member: "dave",
                    task: "integrate branch results",
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            activeStepIndices: [1, 2],
            responses: {
                alice: "api branch output",
                bob: "test branch output",
            },
        });
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
            makeMember("dave", "ses_dave"),
        ]);

        const dispatched: { id: string; text: string }[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push({ id: req.path.id, text: (req.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "") });
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        const wfTask = team.activeTask as Extract<
            ActiveTask,
            { type: "workflow" }
        >;
        expect(wfTask.steps?.[1].output).toBe("api branch output");
        expect(wfTask.steps?.[2].output).toBe("test branch output");
        expect(wfTask.steps?.[3].completed).toBe(true);
        expect(wfTask.steps?.[3].join?.joinedOutput).toContain(
            "api branch output",
        );
        expect(wfTask.steps?.[3].join?.joinedOutput).toContain(
            "test branch output",
        );
        expect(dispatched.map((d) => d.id)).toEqual(["ses_dave"]);
        expect(dispatched[0].text).toContain("integrate branch results");
    });

    test("reduce join waiting for reducer response resumes by re-dispatching the reducer", async () => {
        const root = tmpRoot("rdb-wf-fanout-reduce-waiting");
        const sid = "ses_rdb_wf_fanout_reduce_waiting";
        tracked.push(sid);
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "tests"],
                        branchRanges: [
                            { startIndex: 1, endIndex: 1 },
                            { startIndex: 2, endIndex: 2 },
                        ],
                        joinIndex: 3,
                        maxErrored: 0,
                        joinPolicy: "reduce",
                        reducerMember: "rachel",
                    },
                },
                {
                    kind: "task",
                    member: "alice",
                    task: "build api branch",
                    completed: true,
                    output: "api branch output",
                    branch: {
                        fanoutIndex: 0,
                        branchId: "api",
                        branchIndex: 0,
                        joinIndex: 3,
                    },
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "build test branch",
                    completed: true,
                    output: "test branch output",
                    branch: {
                        fanoutIndex: 0,
                        branchId: "tests",
                        branchIndex: 1,
                        joinIndex: 3,
                    },
                },
                {
                    kind: "join",
                    completed: false,
                    dispatchedAt: 12345,
                    join: {
                        fanoutIndex: 0,
                        branchTailIndices: [1, 2],
                        maxErrored: 0,
                        joinPolicy: "reduce",
                        reducerMember: "rachel",
                    },
                },
                {
                    kind: "task",
                    member: "dave",
                    task: "integrate branch results",
                    completed: false,
                },
            ],
            currentStageIndex: 3,
            activeStepIndices: [3],
            responses: {
                alice: "api branch output",
                bob: "test branch output",
            },
        });
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
            makeMember("rachel", "ses_rachel"),
            makeMember("dave", "ses_dave"),
        ]);

        const dispatched: { id: string; text: string }[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push({ id: req.path.id, text: (req.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "") });
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        const wfTask = team.activeTask as Extract<
            ActiveTask,
            { type: "workflow" }
        >;
        expect(wfTask.steps?.[3].completed).toBe(false);
        expect(wfTask.activeStepIndices).toEqual([3]);
        expect(dispatched.map((d) => d.id)).toEqual(["ses_rachel"]);
        expect(dispatched[0].text).toContain("api branch output");
        expect(dispatched[0].text).toContain("test branch output");
        expect(dispatched.some((d) => d.id === "ses_dave")).toBe(false);
    });

    test("reduce join ignores a stale reducer response from an earlier step on resume", async () => {
        // Given: reducer rachel ran an earlier task step and left a stale response; the reduce join is waiting.
        const root = tmpRoot("rdb-wf-fanout-reduce-stale");
        const sid = "ses_rdb_wf_fanout_reduce_stale";
        tracked.push(sid);
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "task",
                    member: "rachel",
                    task: "prepare",
                    completed: true,
                    output: "rachel earlier output",
                },
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "tests"],
                        branchRanges: [
                            { startIndex: 2, endIndex: 2 },
                            { startIndex: 3, endIndex: 3 },
                        ],
                        joinIndex: 4,
                        maxErrored: 0,
                        joinPolicy: "reduce",
                        reducerMember: "rachel",
                    },
                },
                {
                    kind: "task",
                    member: "alice",
                    task: "build api branch",
                    completed: true,
                    output: "api branch output",
                    branch: {
                        fanoutIndex: 1,
                        branchId: "api",
                        branchIndex: 0,
                        joinIndex: 4,
                    },
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "build test branch",
                    completed: true,
                    output: "test branch output",
                    branch: {
                        fanoutIndex: 1,
                        branchId: "tests",
                        branchIndex: 1,
                        joinIndex: 4,
                    },
                },
                {
                    kind: "join",
                    completed: false,
                    dispatchedAt: 12345,
                    join: {
                        fanoutIndex: 1,
                        branchTailIndices: [2, 3],
                        maxErrored: 0,
                        joinPolicy: "reduce",
                        reducerMember: "rachel",
                    },
                },
                {
                    kind: "task",
                    member: "dave",
                    task: "integrate branch results",
                    completed: false,
                },
            ],
            currentStageIndex: 4,
            activeStepIndices: [4],
            // Stale: rachel ran step 1 earlier; resume must NOT treat this as the reducer result.
            responses: { rachel: "rachel earlier output" },
        });
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
            makeMember("rachel", "ses_rachel"),
            makeMember("dave", "ses_dave"),
        ]);

        const dispatched: { id: string; text: string }[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push({ id: req.path.id, text: (req.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "") });
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        const wfTask = team.activeTask as Extract<
            ActiveTask,
            { type: "workflow" }
        >;
        // The join must not have completed using the stale "rachel earlier output".
        expect(wfTask.steps?.[4].completed).toBe(false);
        expect(wfTask.steps?.[4].join?.joinedOutput).toBeUndefined();
        // The reducer is re-dispatched (its response was stale, not a fresh reduce turn).
        expect(dispatched.map((d) => d.id)).toEqual(["ses_rachel"]);
        expect(dispatched.some((d) => d.id === "ses_dave")).toBe(false);
    });

    test("captured branch gate PASS mid-fanout resumes and re-dispatches only the missing sibling branch", async () => {
        const root = tmpRoot("rdb-wf-fanout-gate-mid");
        const sid = "ses_rdb_wf_fanout_gate_mid";
        tracked.push(sid);
        const passVerdict =
            '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>';
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "tests"],
                        branchRanges: [
                            { startIndex: 1, endIndex: 2 },
                            { startIndex: 3, endIndex: 4 },
                        ],
                        joinIndex: 5,
                        maxErrored: 0,
                    },
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "build api branch",
                    completed: true,
                    output: "api branch output",
                    branch: {
                        fanoutIndex: 0,
                        branchId: "api",
                        branchIndex: 0,
                        joinIndex: 5,
                    },
                },
                {
                    kind: "gate",
                    verifier: "erin",
                    criteria: "api passes",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "api",
                        branchIndex: 0,
                        joinIndex: 5,
                    },
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "build test branch",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "tests",
                        branchIndex: 1,
                        joinIndex: 5,
                    },
                },
                {
                    kind: "gate",
                    verifier: "eve",
                    criteria: "tests pass",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "tests",
                        branchIndex: 1,
                        joinIndex: 5,
                    },
                },
                {
                    kind: "join",
                    completed: false,
                    join: {
                        fanoutIndex: 0,
                        branchTailIndices: [2, 4],
                        maxErrored: 0,
                    },
                },
                {
                    kind: "task",
                    member: "dave",
                    task: "integrate branch results",
                    completed: false,
                },
            ],
            currentStageIndex: 2,
            activeStepIndices: [2, 3],
            responses: { bob: "api branch output", erin: passVerdict },
        });
        const team = await setup(root, sid, task, [
            makeMember("bob", "ses_bob"),
            makeMember("erin", "ses_erin"),
            makeMember("carol", "ses_carol"),
            makeMember("eve", "ses_eve"),
            makeMember("dave", "ses_dave"),
        ]);

        const dispatched: { id: string; text: string }[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push({ id: req.path.id, text: (req.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "") });
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        const wfTask = team.activeTask as Extract<
            ActiveTask,
            { type: "workflow" }
        >;
        expect(wfTask.steps?.[2].completed).toBe(true);
        expect(wfTask.steps?.[2].verdict).toBe("PASS");
        expect(wfTask.steps?.[5].completed).toBe(false);
        expect(wfTask.activeStepIndices).toEqual([3]);
        expect(dispatched.map((d) => d.id)).toEqual(["ses_carol"]);
        expect(dispatched[0].text).toContain("build test branch");
        expect(dispatched[0].text).not.toContain("api branch output");
        expect(dispatched.some((d) => d.id === "ses_dave")).toBe(false);
    });

    test("captured branch gate PASS with on_pass_goto resumes and jumps within that branch", async () => {
        // Given: the api branch gate has a captured PASS, while a sibling branch is already complete.
        const root = tmpRoot("rdb-wf-fanout-branch-goto");
        const sid = "ses_rdb_wf_fanout_branch_goto";
        tracked.push(sid);
        const passVerdict =
            '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>';
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "tests"],
                        branchRanges: [
                            { startIndex: 1, endIndex: 4 },
                            { startIndex: 5, endIndex: 5 },
                        ],
                        joinIndex: 6,
                        maxErrored: 0,
                    },
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "build api branch",
                    completed: true,
                    output: "api branch output",
                    branch: {
                        fanoutIndex: 0,
                        branchId: "api",
                        branchIndex: 0,
                        joinIndex: 6,
                    },
                },
                {
                    kind: "gate",
                    verifier: "erin",
                    criteria: "api passes",
                    onPassGoto: 4,
                    jumpCount: 0,
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "api",
                        branchIndex: 0,
                        joinIndex: 6,
                    },
                },
                {
                    kind: "task",
                    member: "grace",
                    task: "api intermediate step",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "api",
                        branchIndex: 0,
                        joinIndex: 6,
                    },
                },
                {
                    kind: "task",
                    member: "frank",
                    task: "api final step",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "api",
                        branchIndex: 0,
                        joinIndex: 6,
                    },
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "build test branch",
                    completed: true,
                    output: "tests branch output",
                    branch: {
                        fanoutIndex: 0,
                        branchId: "tests",
                        branchIndex: 1,
                        joinIndex: 6,
                    },
                },
                {
                    kind: "join",
                    completed: false,
                    join: {
                        fanoutIndex: 0,
                        branchTailIndices: [4, 5],
                        maxErrored: 0,
                    },
                },
                {
                    kind: "task",
                    member: "dave",
                    task: "integrate branch results",
                    completed: false,
                },
            ],
            currentStageIndex: 2,
            activeStepIndices: [2],
            responses: {
                bob: "api branch output",
                erin: passVerdict,
                carol: "tests branch output",
            },
        });
        const team = await setup(root, sid, task, [
            makeMember("bob", "ses_bob"),
            makeMember("erin", "ses_erin"),
            makeMember("grace", "ses_grace"),
            makeMember("frank", "ses_frank"),
            makeMember("carol", "ses_carol"),
            makeMember("dave", "ses_dave"),
        ]);

        const dispatched: { id: string; text: string }[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push({ id: req.path.id, text: (req.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "") });
        } });

        // When: resume re-drives the captured branch gate verdict.
        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // Then: the branch-local goto skips the intermediate api task and dispatches only the api final step.
        const wfTask = team.activeTask as Extract<
            ActiveTask,
            { type: "workflow" }
        >;
        expect(wfTask.steps?.[2].completed).toBe(true);
        expect(wfTask.steps?.[2].verdict).toBe("PASS");
        expect(wfTask.steps?.[2].jumpCount).toBe(1);
        expect(wfTask.steps?.[3].skipped).toBe(true);
        expect(wfTask.steps?.[6].completed).toBe(false);
        expect(dispatched.map((d) => d.id)).toEqual(["ses_frank"]);
        expect(dispatched[0].text).toContain("api final step");
        expect(dispatched.some((d) => d.id === "ses_grace")).toBe(false);
        expect(dispatched.some((d) => d.id === "ses_carol")).toBe(false);
        expect(dispatched.some((d) => d.id === "ses_dave")).toBe(false);
        expect(team.activeTask).toBeDefined();
    });
});

describe("resumeDispatch: workflow mid-task-step crash", () => {
    test("current task step's actor has no response -> re-dispatched with its task", async () => {
        const root = tmpRoot("rdb-wf-midtask");
        const sid = "ses_rdb_wf_midtask";
        tracked.push(sid);
        // Crashed at step 0 (alice's task), alice has produced nothing yet.
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "draft the design",
                    completed: false,
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "ok",
                    onFail: "fail",
                    maxRetries: 0,
                    attempts: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 0,
            responses: {},
        });
        const team = await setup(root, sid, task, [
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

        expect(dispatched.map((d) => d.id)).toEqual(["ses_alice"]);
        expect(dispatched[0].text).toContain("draft the design");
        expect(team.activeTask).toBeDefined();
    });

    test("current task actor already responded -> handler re-run and advances", async () => {
        const root = tmpRoot("rdb-wf-midtask-captured");
        const sid = "ses_rdb_wf_midtask_captured";
        tracked.push(sid);
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "draft the design",
                    completed: false,
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "polish",
                    completed: false,
                },
            ],
            currentStageIndex: 0,
            responses: { alice: "captured draft" },
        });
        const team = await setup(root, sid, task, [
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

        if (task.type !== "workflow") throw new Error("expected workflow task");
        expect(task.steps?.[0].completed).toBe(true);
        expect(task.steps?.[0].output).toBe("captured draft");
        expect(dispatched.map((d) => d.id)).toEqual(["ses_bob"]);
        expect(dispatched[0].text).toContain("polish");
    });
});

describe("resumeDispatch: workflow mid-gate-step crash with captured verdict", () => {
    test("current gate's verifier already responded -> handler re-run (delivers, no re-dispatch)", async () => {
        const root = tmpRoot("rdb-wf-midgate");
        const sid = "ses_rdb_wf_midgate";
        tracked.push(sid);
        // Crashed at the gate (step 1) AFTER bob rendered a PASS verdict but
        // before the handler processed it: bob's response is captured.
        const passVerdict =
            '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>';
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "do work",
                    completed: true,
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "ok",
                    onFail: "fail",
                    maxRetries: 0,
                    attempts: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice's work", bob: passVerdict },
        });
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ]);

        const dispatched: string[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push(req.path.id);
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // The captured PASS verdict is processed (no re-dispatch of bob); the
        // leader receives workflow_complete.
        expect(dispatched).toEqual([sid]);
        expect(team.status).toBe("idle");
        expect(team.activeTask).toBeUndefined();
    });

    test("multi-target gate with captured PASS resumes and dispatches the next step", async () => {
        const root = tmpRoot("rdb-wf-midgate-targets");
        const sid = "ses_rdb_wf_midgate_targets";
        tracked.push(sid);
        const passVerdict =
            '<verdict>{"result":"PASS","rationale":"all match","diff":""}</verdict>';
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "api",
                    completed: true,
                    output: "api output",
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "tests",
                    completed: true,
                    output: "tests output",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "consistent",
                    targetStepIndices: [0, 1],
                    onFail: "fail",
                    maxRetries: 0,
                    attempts: 0,
                    completed: false,
                },
                {
                    kind: "task",
                    member: "dave",
                    task: "publish",
                    completed: false,
                },
            ],
            currentStageIndex: 2,
            responses: {
                alice: "api output",
                carol: "tests output",
                bob: passVerdict,
            },
        });
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
            makeMember("carol", "ses_carol"),
            makeMember("dave", "ses_dave"),
        ]);

        const dispatched: { id: string; text: string }[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push({ id: req.path.id, text: (req.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "") });
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        expect(dispatched.map((d) => d.id)).toEqual(["ses_dave"]);
        expect(dispatched[0].text).toContain("publish");
        expect(dispatched[0].text).toContain("api output");
        expect(dispatched[0].text).toContain("tests output");
        expect(team.activeTask).toBeDefined();
    });
});

// --- workflow resume edge cases (P0/P1/step-controls corner coverage) ---
//
// The earlier workflow resume tests cover all-complete, mid-task, mid-gate
// (single + multi-target) with PASS. The following cases were NOT covered and
// exercise resume after a crash at delicate state-machine boundaries:
//   1. goto-after-restart: a captured PASS that should drive an on_pass_goto
//      jump, not linear advance (verifies resume path runs the goto engine).
//   2. approval-pause-mid-restart: the run crashed WHILE paused on an
//      approval_before/approval_after step — resume must re-notify the leader
//      and NOT dispatch/advance past the pause.
//   3. retry/jump counter recovery: a gate carrying attempts/jumpCount from a
//      pre-crash partial run must continue accumulating on resume, NOT reset.

describe("resumeDispatch: workflow goto-after-restart", () => {
    test("a captured PASS with on_pass_goto jumps instead of advancing linearly", async () => {
        const root = tmpRoot("rdb-wf-goto");
        const sid = "ses_rdb_wf_goto";
        tracked.push(sid);
        // Crash happened at the gate (step 1) AFTER bob rendered a PASS but
        // before the handler ran the on_pass_goto jump. On resume the captured
        // PASS must drive the jump to step 3 (skipping step 2), NOT advance
        // linearly to step 2.
        const passVerdict =
            '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>';
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "impl",
                    completed: true,
                    output: "impl",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "ok",
                    onPassGoto: 3,
                    jumpCount: 0,
                    completed: false,
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "intermediate",
                    completed: false,
                },
                {
                    kind: "task",
                    member: "dave",
                    task: "final",
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "impl", bob: passVerdict },
        });
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
            makeMember("carol", "ses_carol"),
            makeMember("dave", "ses_dave"),
        ]);

        const dispatched: { id: string; text: string }[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push({ id: req.path.id, text: (req.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "") });
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // The captured PASS triggered on_pass_goto -> dave (step 3); carol (step 2) skipped.
        expect(dispatched.map((d) => d.id)).toEqual(["ses_dave"]);
        expect(dispatched[0].text).toContain("final");
        expect(dispatched.some((c) => c.id === "ses_carol")).toBe(false);
        const wfTask = team.activeTask as Extract<
            ActiveTask,
            { type: "workflow" }
        >;
        expect(wfTask.steps?.[1].completed).toBe(true);
        expect(wfTask.steps?.[1].jumpCount).toBe(1);
        expect(wfTask.steps?.[2].skipped).toBe(true);
    });

    test("a captured FAIL with on_fail_goto jumps instead of failing the run", async () => {
        const root = tmpRoot("rdb-wf-failgoto");
        const sid = "ses_rdb_wf_failgoto";
        tracked.push(sid);
        const failVerdict =
            '<verdict>{"result":"FAIL","rationale":"bad","diff":"fix"}</verdict>';
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "impl",
                    completed: true,
                    output: "impl",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "ok",
                    onFail: "fail",
                    onFailGoto: 2,
                    jumpCount: 0,
                    completed: false,
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "recovery",
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "impl", bob: failVerdict },
        });
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
            makeMember("carol", "ses_carol"),
        ]);

        const dispatched: { id: string; text: string }[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push({ id: req.path.id, text: (req.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "") });
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // The captured FAIL triggered on_fail_goto -> carol (recovery), not workflow_failed.
        expect(dispatched.map((d) => d.id)).toEqual(["ses_carol"]);
        expect(dispatched[0].text).toContain("recovery");
        expect(team.activeTask).toBeDefined();
    });
});

describe("resumeDispatch: workflow approval-pause-mid-restart", () => {
    test("approval_before pause survives restart: leader re-notified, step NOT dispatched", async () => {
        const root = tmpRoot("rdb-wf-approve-before");
        const sid = "ses_rdb_wf_ab";
        tracked.push(sid);
        // Crash happened WHILE paused before dispatching step 1 (approval_before).
        // The step has NOT been dispatched (no response), approvalBeforeGranted is set.
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "step 0",
                    completed: true,
                    output: "done",
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "step 1",
                    approvalBefore: true,
                    approvalBeforeGranted: true,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            humanApproval: true,
            approvalStage: true,
            approvalRequest: {
                id: "approval-1",
                kind: "workflow_step",
                requestedAt: Date.now() - 1000,
                summary: "Before step 2 (task) by bob",
                stage: 1,
            },
            responses: { alice: "done" },
        });
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ]);

        const dispatched: string[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push(req.path.id);
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // resumeApprovalStage re-notifies the leader (sid) and returns; bob is NOT dispatched.
        expect(dispatched).toEqual([sid]);
        expect(dispatched).not.toContain("ses_bob");
        // The pause is still active — leader must team_approve to proceed.
        const wfTask = team.activeTask as Extract<
            ActiveTask,
            { type: "workflow" }
        >;
        expect(wfTask.approvalStage).toBe(true);
    });

    test("approval_after pause survives restart: leader re-notified, next step NOT dispatched", async () => {
        const root = tmpRoot("rdb-wf-approve-after");
        const sid = "ses_rdb_wf_aa";
        tracked.push(sid);
        // Crash happened WHILE paused after step 0 completed (approval_after).
        // The next step (1) must NOT be dispatched on resume.
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "step 0",
                    approvalAfter: true,
                    completed: true,
                    output: "done",
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "step 1",
                    completed: false,
                },
            ],
            currentStageIndex: 0,
            humanApproval: true,
            approvalStage: true,
            approvalRequest: {
                id: "approval-2",
                kind: "workflow_step",
                requestedAt: Date.now() - 1000,
                summary: "After step 1 (task) by alice",
                stage: 0,
            },
            responses: { alice: "done" },
        });
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ]);

        const dispatched: string[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push(req.path.id);
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        expect(dispatched).toEqual([sid]);
        expect(dispatched).not.toContain("ses_bob");
        const wfTask = team.activeTask as Extract<
            ActiveTask,
            { type: "workflow" }
        >;
        expect(wfTask.approvalStage).toBe(true);
    });
});

describe("resumeDispatch: workflow retry/jump counter recovery", () => {
    test("a captured FAIL continues accumulating attempts (does NOT reset to 0)", async () => {
        const root = tmpRoot("rdb-wf-retry-count");
        const sid = "ses_rdb_wf_rc";
        tracked.push(sid);
        // Pre-crash the gate already burned one retry attempt (attempts=1,
        // maxRetries=2). Crash happened at the gate after the second FAIL was
        // captured but before the handler bumped attempts. Resume must bump
        // attempts 1->2 and re-dispatch the producer, NOT reset attempts to 0
        // (which would grant an extra free retry).
        const failVerdict =
            '<verdict>{"result":"FAIL","rationale":"bad","diff":"fix"}</verdict>';
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "impl",
                    completed: true,
                    output: "impl",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "ok",
                    onFail: "retry",
                    maxRetries: 2,
                    attempts: 1,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "impl", bob: failVerdict },
        });
        const team = await setup(root, sid, task, [
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

        const wfTask = team.activeTask as Extract<
            ActiveTask,
            { type: "workflow" }
        >;
        // attempts continued from the pre-crash value (1 -> 2), within budget.
        expect(wfTask.steps?.[1].attempts).toBe(2);
        // Producer (alice) re-dispatched for the retry; not failed.
        expect(dispatched.map((d) => d.id)).toEqual(["ses_alice"]);
        expect(dispatched[0].text).toContain("Gate FAILED");
        expect(dispatched[0].text).toContain("attempt 2/2");
    });

    test("a captured FAIL after retry exhaustion terminates (attempts already over cap)", async () => {
        const root = tmpRoot("rdb-wf-retry-exhausted");
        const sid = "ses_rdb_wf_re";
        tracked.push(sid);
        // Pre-crash: attempts=2, maxRetries=2 (cap reached). The captured FAIL
        // on resume must terminate the run (attempts would exceed cap), NOT
        // grant a third retry.
        const failVerdict =
            '<verdict>{"result":"FAIL","rationale":"bad","diff":"fix"}</verdict>';
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "impl",
                    completed: true,
                    output: "impl",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "ok",
                    onFail: "retry",
                    maxRetries: 2,
                    attempts: 2,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "impl", bob: failVerdict },
        });
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ]);

        const dispatched: string[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push(req.path.id);
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // Run failed; alice NOT re-dispatched; leader notified with workflow_failed.
        expect(team.status).toBe("failed");
        expect(team.activeTask).toBeUndefined();
        expect(dispatched).toContain(sid);
    });

    test("a gate with a prior jumpCount continues counting (does NOT reset)", async () => {
        const root = tmpRoot("rdb-wf-jump-count");
        const sid = "ses_rdb_wf_jc";
        tracked.push(sid);
        // Pre-crash the gate already used one jump (jumpCount=1). Crash after
        // a FAIL was captured. on_fail_goto should jump AGAIN (jumpCount 1->2)
        // rather than resetting the counter.
        const failVerdict =
            '<verdict>{"result":"FAIL","rationale":"bad","diff":"fix"}</verdict>';
        const task = makeTask({
            type: "workflow",
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "impl",
                    completed: true,
                    output: "impl",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "ok",
                    onFail: "fail",
                    onFailGoto: 0,
                    jumpCount: 1,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "impl", bob: failVerdict },
        });
        const team = await setup(root, sid, task, [
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

        const wfTask = team.activeTask as Extract<
            ActiveTask,
            { type: "workflow" }
        >;
        // jumpCount continued from the pre-crash value (1 -> 2), within the default cap of 3.
        expect(wfTask.steps?.[1].jumpCount).toBe(2);
        expect(wfTask.steps?.[0].completed).toBe(false);
        expect(dispatched.map((d) => d.id)).toEqual(["ses_alice"]);
    });
});

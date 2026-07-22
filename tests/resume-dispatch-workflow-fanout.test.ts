/**
 * Resume-dispatch regression tests for team_resume Phase 3: workflow all-complete and fanout frontier.
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

/**
 * Resume-dispatch regression tests for team_resume Phase 3: workflow goto, approval, retry, and counter recovery.
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

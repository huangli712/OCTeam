/**
 * Workflow handler execution tests (TDD RED→GREEN for Wave 2 T2).
 *
 * Mirrors the pipeline-exec.test.ts stub-ctx harness: makeCtx captures member
 * outputs and records promptAsync dispatches; makeTeam/buildWorkflowTask fixture
 * the state. Drives the handler via processIdle (the real idle entry point) so
 * identity validation (getExpectedMember), output capture, and dispatch all run.
 */
import { afterAll, describe, expect, test } from "bun:test";

import { processIdle } from "../src/orchestration/lifecycle/idle.js";
import type { WorkflowGateStep, WorkflowStep } from "../src/core/types.js";
import { cleanupTmpRoots, makeCtx, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js";

function gateStepAt(steps: readonly WorkflowStep[] | undefined, index: number): WorkflowGateStep {
    const step = steps?.[index];
    if (step?.kind !== "gate") throw new Error(`Expected gate step at index ${index}`);
    return step;
}

afterAll(cleanupTmpRoots);

const PASS_VERDICT =
    '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>';
const FAIL_VERDICT =
    '<verdict>{"result":"FAIL","rationale":"wrong","diff":"off by one"}</verdict>';
const INVALID_VERDICT =
    '<verdict>{"result":"INVALID","rationale":"cannot run tests","diff":""}</verdict>';
const HIGH_SCORE_PASS_VERDICT =
    '<verdict>{"result":"PASS","rationale":"excellent","diff":"","score":9,"confidence":0.9}</verdict>';
const LOW_SCORE_PASS_VERDICT =
    '<verdict>{"result":"PASS","rationale":"barely","diff":"","score":5,"confidence":0.5}</verdict>';
const HIGH_SEVERITY_FAIL_VERDICT =
    '<verdict>{"result":"FAIL","rationale":"risky","diff":"fix risk","score":4,"issues":[{"severity":"high","message":"risk"}]}</verdict>';

describe("handleWorkflowIdle (via processIdle): conditional jumps", () => {
    test("on_pass_goto forward skips intermediate steps", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "build",
                    completed: true,
                    output: "build output",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "build ok",
                    onPassGoto: 3,
                    jumpCount: 0,
                    completed: false,
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "polish",
                    completed: false,
                },
                {
                    kind: "task",
                    member: "dave",
                    task: "package",
                    completed: false,
                },
            ],
            currentStageIndex: 1,
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: PASS_VERDICT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(gateStepAt(task.steps, 1).jumpCount).toBe(1);
        expect(task.steps![2].completed).toBe(true);
        expect(task.steps![2].skipped).toBe(true);
        expect(task.currentStageIndex).toBe(3);
        const daveCall = calls.find((c) => c.sessionId === "ses_dave");
        expect(daveCall).toBeDefined();
        expect(daveCall!.text).toContain("package");
        expect(daveCall!.text).toContain("[Workflow jump: on_pass]");
        expect(daveCall!.text).toContain("Verdict: PASS");
        expect(daveCall!.text).toContain("Rationale: ok");
        // carol was skipped, never dispatched
        expect(calls.some((c) => c.sessionId === "ses_carol")).toBe(false);
    });

    test("on_fail_goto backward resets and re-dispatches the target", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "impl",
                    completed: true,
                    output: "first impl",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "ok",
                    onFail: "fail",
                    onFailGoto: 0,
                    jumpCount: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: FAIL_VERDICT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(gateStepAt(task.steps, 1).jumpCount).toBe(1);
        expect(task.steps![0].completed).toBe(false);
        expect(task.steps![0].output).toBeUndefined();
        expect(task.currentStageIndex).toBe(0);
        const aliceCall = calls.find((c) => c.sessionId === "ses_alice");
        expect(aliceCall).toBeDefined();
        expect(aliceCall!.text).toContain("impl");
        expect(aliceCall!.text).toContain("[Workflow jump: on_fail]");
        expect(aliceCall!.text).toContain("Verdict: FAIL");
        expect(aliceCall!.text).toContain("Rationale: wrong");
        expect(aliceCall!.text).toContain("Diff: off by one");
        expect(team.activeTask).toBeDefined();
    });

    test("on_invalid_goto jumps instead of terminating", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "impl",
                    completed: true,
                    output: "impl output",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "ok",
                    onInvalid: "fail",
                    onInvalidGoto: 2,
                    jumpCount: 0,
                    completed: false,
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "fallback",
                    completed: false,
                },
            ],
            currentStageIndex: 1,
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: INVALID_VERDICT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(gateStepAt(task.steps, 1).jumpCount).toBe(1);
        expect(task.currentStageIndex).toBe(2);
        const carolCall = calls.find((c) => c.sessionId === "ses_carol");
        expect(carolCall).toBeDefined();
        expect(carolCall!.text).toContain("fallback");
        expect(carolCall!.text).toContain(
            "[Workflow jump: on_invalid:INVALID]",
        );
        expect(carolCall!.text).toContain("Verdict: INVALID");
        expect(carolCall!.text).toContain("Rationale: cannot run tests");
        expect(team.activeTask).toBeDefined();
    });

    test("max_jumps exceeded terminates as workflow_failed:jump_limit", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
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
                    maxJumps: 1,
                    jumpCount: 1,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: FAIL_VERDICT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(team.status).toBe("failed");
        expect(team.activeTask).toBeUndefined();
        const leaderCall = calls.find((c) => c.sessionId === "ses_lead");
        expect(leaderCall).toBeDefined();
        expect(leaderCall!.text).toContain("workflow_failed:jump_limit");
    });

    test("on_pass_goto with where only jumps when the structured score matches", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
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
                    where: { kind: "score_gte", value: 8 },
                    jumpCount: 0,
                    completed: false,
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "fallback polish",
                    completed: false,
                },
                {
                    kind: "task",
                    member: "dave",
                    task: "premium polish",
                    completed: false,
                },
            ],
            currentStageIndex: 1,
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: HIGH_SCORE_PASS_VERDICT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(gateStepAt(task.steps, 1).score).toBe(9);
        expect(gateStepAt(task.steps, 1).confidence).toBe(0.9);
        expect(task.currentStageIndex).toBe(3);
        expect(task.steps![2].skipped).toBe(true);
        const daveCall = calls.find((c) => c.sessionId === "ses_dave");
        expect(daveCall).toBeDefined();
        expect(daveCall!.text).toContain("premium polish");
        expect(daveCall!.text).toContain("when:score_gte");
    });

    test("on_pass_goto with where falls back to linear advance when the score does not match", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
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
                    where: { kind: "score_gte", value: 8 },
                    jumpCount: 0,
                    completed: false,
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "fallback polish",
                    completed: false,
                },
                {
                    kind: "task",
                    member: "dave",
                    task: "premium polish",
                    completed: false,
                },
            ],
            currentStageIndex: 1,
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: LOW_SCORE_PASS_VERDICT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(task.currentStageIndex).toBe(2);
        expect(calls.some((c) => c.sessionId === "ses_dave")).toBe(false);
        const carolCall = calls.find((c) => c.sessionId === "ses_carol");
        expect(carolCall).toBeDefined();
        expect(carolCall!.text).toContain("fallback polish");
    });

    test("on_fail_goto with where jumps on high-severity issues", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
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
                    where: { kind: "has_issue_severity", value: "high" },
                    jumpCount: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: HIGH_SEVERITY_FAIL_VERDICT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(gateStepAt(task.steps, 1).issues).toEqual([
            { severity: "high", message: "risk" },
        ]);
        expect(task.currentStageIndex).toBe(0);
        const aliceCall = calls.find((c) => c.sessionId === "ses_alice");
        expect(aliceCall).toBeDefined();
        expect(aliceCall!.text).toContain("when:has_issue_severity");
    });
});

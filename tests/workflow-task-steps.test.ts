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
import { advanceWorkflowStep } from "../src/orchestration/workflow/engine.js";
import { cleanupTmpRoots, makeCtx, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js";

afterAll(cleanupTmpRoots);

describe("handleWorkflowIdle (via processIdle): task steps", () => {
    test("a non-final task step completes -> advances and dispatches the next task with upstream context", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "do step 1",
                    completed: false,
                    dispatchedAt: Date.now() - 10,
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "do step 2",
                    completed: false,
                },
            ],
            currentStageIndex: 0,
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_alice: "alice's step-1 result" }, calls: calls });

        await processIdle(ctx, team, team.members[0], "ses_alice");

        expect(task.steps![0].completed).toBe(true);
        expect(task.steps![0].output).toContain("alice's step-1 result");
        expect(task.steps![0].completedAt).toBeNumber();
        expect(task.steps![0].durationMs).toBeGreaterThanOrEqual(0);
        expect(task.steps![1].startedAt).toBeNumber();
        expect(task.currentStageIndex).toBe(1);
        const bobCall = calls.find((c) => c.sessionId === "ses_bob");
        expect(bobCall).toBeDefined();
        expect(bobCall!.text).toContain("do step 2");
        expect(bobCall!.text).toContain("alice's step-1 result");
        expect(team.members.find((m) => m.name === "bob")!.status).toBe(
            "running",
        );
        expect(team.activeTask).toBeDefined();
    });

    test("the final task step completes -> delivers workflow_complete and idles", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "the only step",
                    completed: false,
                },
            ],
            currentStageIndex: 0,
        });
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
        });
        const ctx = makeCtx({ outputs: { ses_alice: "final workflow output" }, calls: calls });

        await processIdle(ctx, team, team.members[0], "ses_alice");

        expect(team.status).toBe("idle");
        expect(team.activeTask).toBeUndefined();
        const leaderCall = calls.find((c) => c.sessionId === "ses_lead");
        expect(leaderCall).toBeDefined();
        expect(leaderCall!.text).toContain("workflow_complete");
    });

    test("a stray idle from a non-current member does NOT advance the workflow", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "step 1",
                    completed: false,
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "step 2",
                    completed: false,
                },
            ],
            currentStageIndex: 0,
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: "bob jumped ahead" }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(task.currentStageIndex).toBe(0);
        expect(task.steps![0].completed).toBe(false);
        expect(calls.some((c) => c.sessionId === "ses_alice")).toBe(false);
        expect(team.activeTask).toBeDefined();
    });

    test("a later task step receives the prior step's own output snapshot", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "draft",
                    completed: true,
                    output: "step-1 snapshot",
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "polish",
                    completed: false,
                },
            ],
            currentStageIndex: 0,
            responses: { alice: "latest alice response should not be used" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: {}, calls: calls });

        await advanceWorkflowStep(ctx, team);

        const bobCall = calls.find((c) => c.sessionId === "ses_bob");
        expect(bobCall).toBeDefined();
        expect(bobCall!.text).toContain("step-1 snapshot");
        expect(bobCall!.text).not.toContain(
            "latest alice response should not be used",
        );
    });

    test("a task with explicit inputs receives only those upstream outputs", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "public",
                    completed: true,
                    output: "public output",
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "secret",
                    completed: true,
                    output: "secret output",
                    exposeOutput: false,
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "combine selected input",
                    completed: false,
                    inputs: [1],
                },
            ],
            currentStageIndex: 2,
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        });
        const ctx = makeCtx({ outputs: {}, calls: calls });

        await advanceWorkflowStep(ctx, team);

        const carolCall = calls.find((c) => c.sessionId === "ses_carol");
        expect(carolCall).toBeDefined();
        expect(carolCall!.text).toContain("secret output");
        expect(carolCall!.text).not.toContain("public output");
    });

    test("a missing next-step session fails explicitly instead of stalling", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "step 1",
                    completed: false,
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "step 2",
                    completed: false,
                },
            ],
            currentStageIndex: 0,
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_alice: "done" }, calls: calls });

        await processIdle(ctx, team, team.members[0], "ses_alice");

        expect(team.status).toBe("failed");
        expect(team.activeTask).toBeUndefined();
        const leaderCall = calls.find((c) => c.sessionId === "ses_lead");
        expect(leaderCall).toBeDefined();
        expect(leaderCall!.text).toContain("workflow_failed:no_session:bob");
    });
});

/**
 * A2: task step auto-retry tests.
 *
 * Task steps with retry_on auto-retry when the output matches a condition
 * (empty, output_contains, output_not_contains, regex). Tests cover:
 *   - each condition type triggers retry
 *   - taskAttempts counter increments
 *   - exhaustion falls through to normal completion
 *   - non-matching output does not retry
 */
import { describe, expect, test } from "bun:test";

import { processIdle } from "../src/orchestration/lifecycle/idle.js";
import { makeCtx, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js";


describe("workflow task retry_on", () => {
    test("retry_on empty with empty output re-dispatches task and increments taskAttempts", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "do work",
                    retryOn: { kind: "empty" },
                    maxTaskRetries: 2,
                    taskAttempts: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 0,
        });
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
        });
        const ctx = makeCtx({ outputs: { ses_alice: "   " }, calls: calls });

        await processIdle(ctx, team, team.members[0], "ses_alice");

        expect(task.steps![0].taskAttempts).toBe(1);
        expect(task.steps![0].completed).toBe(false);
        // task should be re-dispatched with nudge
        const redispatch = calls.find((c) => c.sessionId === "ses_alice");
        expect(redispatch).toBeDefined();
        expect(redispatch!.text).toContain("Auto-retry attempt 1/2");
    });

    test("retry_on output_contains triggers retry when pattern present", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "do work",
                    retryOn: { kind: "output_contains", pattern: "ERROR" },
                    maxTaskRetries: 1,
                    taskAttempts: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 0,
        });
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
        });
        const ctx = makeCtx({ outputs: { ses_alice: "ERROR: something broke" }, calls: calls });

        await processIdle(ctx, team, team.members[0], "ses_alice");

        expect(task.steps![0].taskAttempts).toBe(1);
        expect(task.steps![0].completed).toBe(false);
        const redispatch = calls.find((c) => c.sessionId === "ses_alice");
        expect(redispatch).toBeDefined();
    });

    test("retry_on regex triggers retry when pattern matches", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "do work",
                    retryOn: { kind: "regex", pattern: "^fail" },
                    maxTaskRetries: 1,
                    taskAttempts: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 0,
        });
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
        });
        const ctx = makeCtx({ outputs: { ses_alice: "failed to complete" }, calls: calls });

        await processIdle(ctx, team, team.members[0], "ses_alice");

        expect(task.steps![0].taskAttempts).toBe(1);
        expect(task.steps![0].completed).toBe(false);
    });

    test("retry_on output_not_contains triggers retry when pattern absent", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "do work",
                    retryOn: { kind: "output_not_contains", pattern: "DONE" },
                    maxTaskRetries: 1,
                    taskAttempts: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 0,
        });
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
        });
        const ctx = makeCtx({ outputs: { ses_alice: "work in progress" }, calls: calls });

        await processIdle(ctx, team, team.members[0], "ses_alice");

        expect(task.steps![0].taskAttempts).toBe(1);
        expect(task.steps![0].completed).toBe(false);
    });

    test("retry_on empty with non-empty output does not retry", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "do work",
                    retryOn: { kind: "empty" },
                    maxTaskRetries: 2,
                    taskAttempts: 0,
                    completed: false,
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "next step",
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
        const ctx = makeCtx({ outputs: { ses_alice: "real output here" }, calls: calls });

        await processIdle(ctx, team, team.members[0], "ses_alice");

        expect(task.steps![0].taskAttempts).toBe(0);
        expect(task.steps![0].completed).toBe(true);
        // workflow should advance to bob
        const bobDispatch = calls.find((c) => c.sessionId === "ses_bob");
        expect(bobDispatch).toBeDefined();
    });

    test("retry_on exhausts max_task_retries -> falls through to normal completion", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "do work",
                    retryOn: { kind: "empty" },
                    maxTaskRetries: 1,
                    taskAttempts: 1,
                    completed: false,
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "next step",
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
        const ctx = makeCtx({ outputs: { ses_alice: "" }, calls: calls });

        await processIdle(ctx, team, team.members[0], "ses_alice");

        // taskAttempts was 1, incremented to 2, exceeds maxTaskRetries=1
        // -> falls through to normal completion
        expect(task.steps![0].taskAttempts).toBe(2);
        expect(task.steps![0].completed).toBe(true);
        // workflow should advance to bob
        const bobDispatch = calls.find((c) => c.sessionId === "ses_bob");
        expect(bobDispatch).toBeDefined();
    });
});

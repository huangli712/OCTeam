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
import { readRunEvents } from "../src/orchestration/records/runs.js";
import { cleanupTmpRoots, makeCtx, makeTeam, makeWorkflowTask, type DispatchCall, waitForEvent } from "./helpers.js";

afterAll(cleanupTmpRoots);

const PASS_VERDICT =
    '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>';
const FAIL_VERDICT =
    '<verdict>{"result":"FAIL","rationale":"wrong","diff":"off by one"}</verdict>';
const INVALID_VERDICT =
    '<verdict>{"result":"INVALID","rationale":"cannot run tests","diff":""}</verdict>';

describe("handleWorkflowIdle (via processIdle): gate steps", () => {
    test("a gate PASS -> marks the gate complete and advances to the next task", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
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
                    criteria: "passes tests",
                    onFail: "retry",
                    maxRetries: 0,
                    attempts: 0,
                    completed: false,
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "follow-up work",
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice's work output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: PASS_VERDICT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(task.steps![1].completed).toBe(true);
        expect(task.steps![1].verdict).toBe("PASS");
        expect(task.currentStageIndex).toBe(2);
        const carolCall = calls.find((c) => c.sessionId === "ses_carol");
        expect(carolCall).toBeDefined();
        expect(carolCall!.text).toContain("follow-up work");
    });

    test("the final gate PASS -> delivers workflow_complete", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
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
                    criteria: "passes tests",
                    onFail: "fail",
                    maxRetries: 0,
                    attempts: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice's work output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: PASS_VERDICT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(team.status).toBe("idle");
        expect(team.activeTask).toBeUndefined();
        const leaderCall = calls.find((c) => c.sessionId === "ses_lead");
        expect(leaderCall).toBeDefined();
        expect(leaderCall!.text).toContain("workflow_complete");
    });

    test("a gate FAIL with onFail='fail' -> fails the run immediately", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
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
                    criteria: "passes tests",
                    onFail: "fail",
                    maxRetries: 0,
                    attempts: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice's work output" },
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
        expect(leaderCall!.text).toContain("workflow_failed");
    });

    test("a gate FAIL with onFail='retry' retries the preceding task, then fails on exhaust", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
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
                    criteria: "passes tests",
                    onFail: "retry",
                    maxRetries: 1,
                    attempts: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice's work output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });

        // First FAIL: within retries (attempts 0 -> 1, maxRetries 1) -> re-dispatch alice.
        let ctx = makeCtx({ outputs: { ses_bob: FAIL_VERDICT }, calls: calls });
        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(task.steps![1].attempts).toBe(1);
        expect(task.steps![0].completed).toBe(false);
        expect(task.responses.alice).toBeUndefined();
        expect(task.responses.bob).toBeUndefined();
        expect(task.currentStageIndex).toBe(0);
        const retryCall = calls.find((c) => c.sessionId === "ses_alice");
        expect(retryCall).toBeDefined();
        expect(retryCall!.text).toContain("Gate FAILED");
        await waitForEvent(team.directory, task.runId!, "retry");
        const events = await readRunEvents(team.directory, task.runId!);
        const retryEvent = events.find((e) => e.kind === "retry");
        expect(retryEvent?.stage).toBe(1);
        expect(retryEvent?.detail).toContain("workflow step 2");
        expect(team.activeTask).toBeDefined();
        expect(task.steps![0].dispatchedAt).toBeNumber();

        // alice re-runs the task -> completes again -> advances back to the gate.
        ctx = makeCtx({ outputs: { ses_alice: "alice's revised output" }, calls: calls });
        await processIdle(ctx, team, team.members[0], "ses_alice");
        expect(task.currentStageIndex).toBe(1);

        // Second FAIL: attempts 1 -> 2 > maxRetries 1 -> fail the run.
        // Bob's second verification idle arrives AFTER the gate retried alice
        // (a real dispatchToMember appends a new user+assistant turn to bob's
        // session history). Mirror that growth so captureMemberOutput's
        // lastCapturedMsgCount guard recognises a fresh turn (length 2 -> 4)
        // and captures the FAIL verdict. A fixed-length outputs mock would be
        // skipped as a no-new-turn stale idle, leaving responses.bob unset.
        ctx = makeCtx({
            calls: calls,
            messages: async (req: unknown) => {
                const path = (req as { path: { id: string } }).path
                const text = path.id === "ses_bob" ? FAIL_VERDICT : ""
                return {
                    data: [
                        // Turn 1 (preserved from the first verification).
                        { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
                        { info: { role: "assistant" }, parts: [{ type: "text", text: FAIL_VERDICT }] },
                        // Turn 2 (appended by the retry dispatch).
                        { info: { role: "user" }, parts: [{ type: "text", text: "retry" }] },
                        ...(text ? [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }] : []),
                    ],
                }
            },
        });
        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(team.status).toBe("failed");
        expect(team.activeTask).toBeUndefined();
        const leaderCall = calls.find((c) => c.sessionId === "ses_lead");
        expect(leaderCall).toBeDefined();
        expect(leaderCall!.text).toContain("workflow_failed");
    });

    test("a gate FAIL with onFail='skip' skips the gate and dispatches the next task", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "do work",
                    completed: true,
                    output: "usable producer output",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "optional check",
                    onFail: "skip",
                    completed: false,
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "continue",
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
        const ctx = makeCtx({ outputs: { ses_bob: FAIL_VERDICT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(task.steps![1].completed).toBe(true);
        expect(task.steps![1].skipped).toBe(true);
        expect(task.currentStageIndex).toBe(2);
        const carolCall = calls.find((c) => c.sessionId === "ses_carol");
        expect(carolCall).toBeDefined();
        expect(carolCall!.text).toContain("continue");
        expect(carolCall!.text).toContain("usable producer output");
        expect(team.activeTask).toBeDefined();
    });

    test("a gate INVALID with onInvalid='retry_verifier' refreshes the verifier step dispatchedAt on each retry", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
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
                    criteria: "passes tests",
                    onFail: "fail",
                    attempts: 0,
                    onInvalid: "retry_verifier",
                    maxInvalidRetries: 1,
                    invalidAttempts: 0,
                    startedAt: 1000,
                    dispatchedAt: 1000,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice's work output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: INVALID_VERDICT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(task.steps![1].invalidAttempts).toBe(1);
        expect(task.responses.bob).toBeUndefined();
        expect(task.steps![1].dispatchedAt).toBeNumber();
        expect(task.steps![1].startedAt).toBe(task.steps![1].dispatchedAt);
    });

    test("a gate verdict that fails to parse -> fails the run as workflow_invalid", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
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
                    criteria: "passes tests",
                    onFail: "retry",
                    maxRetries: 2,
                    attempts: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice's work output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: "I cannot decide, no verdict tag" }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(team.status).toBe("failed");
        expect(team.activeTask).toBeUndefined();
        const leaderCall = calls.find((c) => c.sessionId === "ses_lead");
        expect(leaderCall).toBeDefined();
        expect(leaderCall!.text).toContain("workflow_invalid");
    });

    test("a gate INVALID verdict does not retry the target producer", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "do work",
                    completed: true,
                    output: "alice output",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "passes tests",
                    onFail: "retry",
                    maxRetries: 2,
                    attempts: 0,
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
        const ctx = makeCtx({ outputs: { ses_bob: INVALID_VERDICT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(team.status).toBe("failed");
        expect(task.steps![1].attempts).toBe(0);
        expect(calls.some((c) => c.sessionId === "ses_alice")).toBe(false);
        const leaderCall = calls.find((c) => c.sessionId === "ses_lead");
        expect(leaderCall).toBeDefined();
        expect(leaderCall!.text).toContain("workflow_invalid");
    });

    test("a gate target_step verifies the selected previous task step", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "draft",
                    completed: true,
                    output: "selected step output",
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "other",
                    completed: true,
                    output: "nearest task output",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    targetStepIndex: 0,
                    criteria: "check draft",
                    completed: false,
                },
            ],
            currentStageIndex: 2,
            responses: {
                alice: "latest alice response",
                carol: "latest carol response",
            },
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

        const bobCall = calls.find((c) => c.sessionId === "ses_bob");
        expect(bobCall).toBeDefined();
        expect(bobCall!.text).toContain("workflow step 1");
        expect(bobCall!.text).toContain("selected step output");
        expect(bobCall!.text).not.toContain("nearest task output");
        expect(bobCall!.text).not.toContain("latest alice response");
    });

    test("on_invalid=retry_verifier re-dispatches the verifier then fails on exhaust", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "do work",
                    completed: true,
                    output: "alice output",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "passes tests",
                    onFail: "fail",
                    onInvalid: "retry_verifier",
                    maxInvalidRetries: 1,
                    invalidAttempts: 0,
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

        // First INVALID: within retries (0 -> 1) -> re-dispatch bob, NOT alice.
        let ctx = makeCtx({ outputs: { ses_bob: INVALID_VERDICT }, calls: calls });
        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(task.steps![1].invalidAttempts).toBe(1);
        expect(task.steps![0].completed).toBe(true);
        expect(task.currentStageIndex).toBe(1);
        const reverifyCall = calls.find((c) => c.sessionId === "ses_bob");
        expect(reverifyCall).toBeDefined();
        expect(reverifyCall!.text).toContain("could not be evaluated");
        expect(calls.some((c) => c.sessionId === "ses_alice")).toBe(false);
        expect(team.activeTask).toBeDefined();

        // Second INVALID: 1 -> 2 > maxInvalidRetries 1 -> fail as workflow_invalid.
        ctx = makeCtx({ outputs: { ses_bob: INVALID_VERDICT }, calls: calls });
        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(team.status).toBe("failed");
        expect(team.activeTask).toBeUndefined();
        const leaderCall = calls.find((c) => c.sessionId === "ses_lead");
        expect(leaderCall).toBeDefined();
        expect(leaderCall!.text).toContain("workflow_invalid");
    });

    test("on_invalid=escalate forces a human-approval pause even without humanApproval", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "do work",
                    completed: true,
                    output: "alice output",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "passes tests",
                    onFail: "fail",
                    onInvalid: "escalate",
                    completed: false,
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "follow-up",
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            humanApproval: false,
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

        // Forced pause: the gate is marked complete (so approve will advance),
        // an approval request was emitted to the leader, and carol was NOT dispatched yet.
        expect(task.steps![1].completed).toBe(true);
        expect(task.approvalStage).toBe(true);
        expect(task.approvalRequest?.kind).toBe("workflow_step");
        expect(
            calls.some(
                (c) =>
                    c.sessionId === "ses_lead" &&
                    c.text.includes("could not be evaluated"),
            ),
        ).toBe(true);
        expect(calls.some((c) => c.sessionId === "ses_carol")).toBe(false);
        expect(team.activeTask).toBeDefined();
    });

    test("a gate target_step with a string id verifies the named task step", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    id: "design",
                    member: "alice",
                    task: "draft",
                    completed: true,
                    output: "design output",
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
                    id: "verify-design",
                    verifier: "bob",
                    targetStepIndex: 0,
                    criteria: "design ok",
                    completed: false,
                },
            ],
            currentStageIndex: 2,
            responses: { alice: "latest alice", carol: "latest carol" },
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

        const bobCall = calls.find((c) => c.sessionId === "ses_bob");
        expect(bobCall).toBeDefined();
        expect(bobCall!.text).toContain("design output");
        expect(bobCall!.text).not.toContain("tests output");
    });

    test("a gate with where score asks the verifier to emit score/confidence", async () => {
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
                    task: "premium",
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
        const ctx = makeCtx({ outputs: {}, calls: calls });

        await advanceWorkflowStep(ctx, team);

        const bobCall = calls.find((c) => c.sessionId === "ses_bob");
        expect(bobCall).toBeDefined();
        expect(bobCall!.text).toContain("score");
        expect(bobCall!.text).toContain("confidence");
    });

    test("a gate without where does not request structured fields", async () => {
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
        const ctx = makeCtx({ outputs: {}, calls: calls });

        await advanceWorkflowStep(ctx, team);

        const bobCall = calls.find((c) => c.sessionId === "ses_bob");
        expect(bobCall).toBeDefined();
        expect(bobCall!.text).not.toContain("structured score");
        expect(bobCall!.text).not.toContain("structured issues");
    });

    test("a multi-target gate verifies all selected task outputs", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    id: "api",
                    member: "alice",
                    task: "api",
                    completed: true,
                    output: "api output",
                },
                {
                    kind: "task",
                    id: "tests",
                    member: "carol",
                    task: "tests",
                    completed: true,
                    output: "tests output",
                },
                {
                    kind: "task",
                    id: "docs",
                    member: "dave",
                    task: "docs",
                    completed: true,
                    output: "docs output",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    targetStepIndices: [0, 2],
                    criteria: "api and docs agree",
                    completed: false,
                },
            ],
            currentStageIndex: 3,
            responses: {
                alice: "latest api",
                carol: "latest tests",
                dave: "latest docs",
            },
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
        const ctx = makeCtx({ outputs: {}, calls: calls });

        await advanceWorkflowStep(ctx, team);

        const bobCall = calls.find((c) => c.sessionId === "ses_bob");
        expect(bobCall).toBeDefined();
        expect(bobCall!.text).toContain("workflow steps 1, 3");
        expect(bobCall!.text).toContain("[Step 1 output from alice]");
        expect(bobCall!.text).toContain("api output");
        expect(bobCall!.text).toContain("[Step 3 output from dave]");
        expect(bobCall!.text).toContain("docs output");
        expect(bobCall!.text).not.toContain("tests output");
        expect(bobCall!.text).not.toContain("latest api");
    });

    test("a multi-target gate FAIL retry resets from the earliest target", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
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
                    kind: "task",
                    member: "dave",
                    task: "docs",
                    completed: true,
                    output: "docs output",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    targetStepIndices: [0, 2],
                    criteria: "all consistent",
                    onFail: "retry",
                    maxRetries: 1,
                    attempts: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 3,
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
        const ctx = makeCtx({ outputs: { ses_bob: FAIL_VERDICT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(task.steps![0].completed).toBe(false);
        expect(task.steps![1].completed).toBe(false);
        expect(task.steps![2].completed).toBe(false);
        expect(task.currentStageIndex).toBe(0);
        const aliceCall = calls.find((c) => c.sessionId === "ses_alice");
        expect(aliceCall).toBeDefined();
        expect(aliceCall!.text).toContain("Gate FAILED");
        expect(aliceCall!.text).toContain("api");
    });
});

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
import type { WorkflowGateStep, WorkflowStep } from "../src/core/types.js";
import { cleanupTmpRoots, makeCtx, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js";

function gateStepAt(steps: readonly WorkflowStep[] | undefined, index: number): WorkflowGateStep {
    const step = steps?.[index];
    if (step?.kind !== "gate") throw new Error(`Expected gate step at index ${index}`);
    return step;
}

afterAll(cleanupTmpRoots);

describe("handleWorkflowIdle (via processIdle): step-level controls", () => {
    test("approval_before on a task step pauses before dispatching it", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
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
        const ctx = makeCtx({ outputs: {}, calls: calls });

        await advanceWorkflowStep(ctx, team);

        expect(task.approvalStage).toBe(true);
        expect(task.approvalRequest?.kind).toBe("workflow_step");
        expect(task.steps![1].approvalBeforeGranted).toBe(true);
        // bob (step 1) was NOT dispatched yet — paused before dispatch
        expect(calls.some((c) => c.sessionId === "ses_bob")).toBe(false);
        expect(team.activeTask).toBeDefined();
    });

    test("approval_before granted flag is consumed once the step is dispatched on resume", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
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
            currentStageIndex: 0,
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

        // granted flag set (simulate post-approve) -> dispatch proceeds, no pause
        expect(task.approvalStage).toBeUndefined();
        const bobCall = calls.find((c) => c.sessionId === "ses_bob");
        expect(bobCall).toBeDefined();
        expect(bobCall!.text).toContain("step 1");
    });

    test("approval_after on a task step pauses after it completes, before advancing", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "step 0",
                    approvalAfter: true,
                    completed: false,
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "step 1",
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
        const ctx = makeCtx({ outputs: { ses_alice: "alice output" }, calls: calls });

        await processIdle(ctx, team, team.members[0], "ses_alice");

        expect(task.steps![0].completed).toBe(true);
        expect(task.approvalStage).toBe(true);
        expect(task.approvalRequest?.kind).toBe("workflow_step");
        // bob (next step) NOT dispatched yet — paused after step 0
        expect(calls.some((c) => c.sessionId === "ses_bob")).toBe(false);
        expect(team.activeTask).toBeDefined();
    });

    test("max_output_bytes truncates the captured task step output", async () => {
        const calls: DispatchCall[] = [];
        const huge = "x".repeat(5000);
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "step 0",
                    maxOutputBytes: 100,
                    completed: false,
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "step 1",
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
        const ctx = makeCtx({ outputs: { ses_alice: huge }, calls: calls });

        await processIdle(ctx, team, team.members[0], "ses_alice");

        expect(task.steps![0].completed).toBe(true);
        const captured = task.steps![0].output ?? "";
        // truncateOutput keeps head+tail within the byte budget plus a small separator overhead
        expect(Buffer.byteLength(captured, "utf8")).toBeLessThan(5000);
        expect(captured).toContain("truncated");
    });
});

describe("handleWorkflowIdle (via processIdle): approval_before honored on retry re-dispatch", () => {
    // Regression: FAIL retry and INVALID retry_verifier paths used to call
    // dispatchToMember directly, bypassing maybePauseBeforeWorkflowStep. A
    // producer/verifier with approval_before:true was silently re-dispatched
    // on retry without the leader being asked.

    test("FAIL retry re-dispatch honors producer approval_before", async () => {
        const calls: DispatchCall[] = [];
        const failVerdict =
            '<verdict>{"result":"FAIL","rationale":"bad","diff":"fix"}</verdict>';
        // Producer step 0 has approval_before. First FAIL triggers a retry
        // (maxRetries=1). The retry must pause before re-dispatching alice.
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "impl",
                    approvalBefore: true,
                    approvalBeforeGranted: true,
                    completed: true,
                    output: "impl",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "ok",
                    onFail: "retry",
                    maxRetries: 1,
                    attempts: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "impl", bob: failVerdict },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: {}, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        // Paused before re-dispatching alice (producer approval_before honored on retry).
        expect(task.approvalStage).toBe(true);
        expect(task.approvalRequest?.kind).toBe("workflow_step");
        expect(task.steps![0].approvalBeforeGranted).toBe(true);
        expect(task.steps![0].completed).toBe(false); // reset for retry
        expect(gateStepAt(task.steps, 1).attempts).toBe(1); // counter still bumped
        // alice NOT re-dispatched yet.
        expect(calls.some((c) => c.sessionId === "ses_alice")).toBe(false);
        expect(team.activeTask).toBeDefined();
    });

    test("INVALID retry_verifier re-dispatch honors gate approval_before", async () => {
        const calls: DispatchCall[] = [];
        const invalidVerdict =
            '<verdict>{"result":"INVALID","rationale":"cannot eval","diff":""}</verdict>';
        // Gate step 1 has approval_before. The gate was dispatched once
        // (dispatchGateStep consumed approvalBeforeGranted -> undefined) and
        // produced INVALID. retry_verifier must pause before re-dispatching bob.
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
                    onInvalid: "retry_verifier",
                    maxInvalidRetries: 1,
                    invalidAttempts: 0,
                    approvalBefore: true,
                    startedAt: 1000,
                    dispatchedAt: 1000,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "impl", bob: invalidVerdict },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: {}, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        // Paused before re-dispatching bob (gate approval_before honored on invalid retry).
        expect(task.approvalStage).toBe(true);
        expect(task.approvalRequest?.kind).toBe("workflow_step");
        expect(task.steps![1].approvalBeforeGranted).toBe(true);
        expect(gateStepAt(task.steps, 1).invalidAttempts).toBe(1); // counter still bumped
        // bob NOT re-dispatched yet.
        expect(calls.some((c) => c.sessionId === "ses_bob")).toBe(false);
        // Timing was reset before the pause so the resumed dispatch measures only the new attempt.
        expect(task.steps![1].startedAt).toBeUndefined();
        expect(task.steps![1].dispatchedAt).toBeUndefined();
        expect(team.activeTask).toBeDefined();
    });
});

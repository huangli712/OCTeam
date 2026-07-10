/**
 * A1: workflow loop tests.
 *
 * Gate steps with `loop` config bound backward iterations via on_fail_goto.
 * loopIterations replaces jumpCount for loop-controlled gotos. Tests cover:
 *   - loop back on FAIL (increments loopIterations, re-dispatches target)
 *   - exhaust with on_exhaust="fail" terminates the run
 *   - exhaust with on_exhaust="continue" marks gate complete and advances
 *   - PASS converges the loop without incrementing loopIterations
 *   - loop-controlled goto does not increment jumpCount
 */
import { describe, expect, test } from "bun:test";


import { processIdle } from "../src/orchestration/idle.js";
import type {
    ActiveTask,
    MemberState,
    WorkflowStep,
    WorkflowTask,
} from "../src/core/types.js";


import { makeTeam, makeCtx, makeWorkflowTask, type DispatchCall } from "./helpers.js";



const FAIL_VERDICT =
    '<verdict>{"result":"FAIL","rationale":"not good enough","diff":"needs work"}</verdict>';
const PASS_VERDICT =
    '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>';

function makeLoopSteps(loopIterations: number, onExhaust: "fail" | "continue" = "fail"): WorkflowStep[] {
    return [
        { kind: "task", member: "alice", task: "do work", completed: true, output: "alice output" },
        {
            kind: "gate",
            verifier: "bob",
            criteria: "quality check",
            onFail: "fail",
            onFailGoto: 0,
            loop: { maxIterations: 2, onExhaust },
            loopIterations,
            completed: false,
        },
        { kind: "task", member: "carol", task: "final step", completed: false },
    ];
}

describe("workflow loop", () => {
    test("loop back on FAIL increments loopIterations and re-dispatches target", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: makeLoopSteps(0),
            currentStageIndex: 1,
            responses: { alice: "alice output" },
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

        expect(task.steps![1].loopIterations).toBe(1);
        // loop back to step 0 (alice) should be re-dispatched
        const aliceRedispatch = calls.find((c) => c.sessionId === "ses_alice");
        expect(aliceRedispatch).toBeDefined();
        // jumpCount should NOT increment for loop-controlled goto
        expect(task.steps![1].jumpCount ?? 0).toBe(0);
    });

    test("loop revalidates the body before dispatching the successor", async () => {
        // Given an active gate whose FAIL verdict loops back to the body.
        const calls: DispatchCall[] = [];
        const steps = makeLoopSteps(0);
        const task = makeWorkflowTask({
            steps,
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        });
        const ctx = makeCtx({
            outputs: {
                ses_alice: "revised alice output",
                ses_bob: FAIL_VERDICT,
            },
            calls,
        });

        // When the gate fails and the redispatched body completes.
        await processIdle(ctx, team, team.members[1], "ses_bob");
        await processIdle(ctx, team, team.members[0], "ses_alice");

        // Then the gate is pending a fresh verdict and the successor is untouched.
        expect(calls.filter((call) => call.sessionId === "ses_bob")).toHaveLength(1);
        expect(steps[1]?.completed).toBe(false);
        expect(calls.some((call) => call.sessionId === "ses_carol")).toBe(false);
    });

    test("exhaust with on_exhaust='fail' terminates the run", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: makeLoopSteps(2, "fail"),
            currentStageIndex: 1,
            responses: { alice: "alice output" },
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

        // loopIterations was 2, incremented to 3, exceeds maxIterations=2
        expect(task.steps![1].loopIterations).toBe(3);
        expect(team.status).toBe("failed");
        const leaderCall = calls.find((c) => c.sessionId === "ses_lead");
        expect(leaderCall).toBeDefined();
        expect(leaderCall!.text).toContain("workflow_failed");
    });

    test("exhaust with on_exhaust='continue' marks gate complete and advances", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: makeLoopSteps(2, "continue"),
            currentStageIndex: 1,
            responses: { alice: "alice output" },
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

        expect(task.steps![1].loopIterations).toBe(3);
        expect(task.steps![1].completed).toBe(true);
        // workflow should advance to step 2 (carol)
        const carolDispatch = calls.find((c) => c.sessionId === "ses_carol");
        expect(carolDispatch).toBeDefined();
    });

    test("PASS converges the loop without incrementing loopIterations", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: makeLoopSteps(1),
            currentStageIndex: 1,
            responses: { alice: "alice output" },
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

        // PASS does not increment loopIterations
        expect(task.steps![1].loopIterations).toBe(1);
        expect(task.steps![1].completed).toBe(true);
        // workflow should advance to step 2 (carol)
        const carolDispatch = calls.find((c) => c.sessionId === "ses_carol");
        expect(carolDispatch).toBeDefined();
    });

    test("full cycle: FAIL backward goto then body idle re-dispatches gate, not successor", async () => {
        const calls: DispatchCall[] = [];
        const steps = makeLoopSteps(0);
        const task = makeWorkflowTask({
            steps,
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        });
        const ctx = makeCtx({
            outputs: { ses_bob: FAIL_VERDICT, ses_alice: "alice output" },
            calls: calls,
        });

        // Phase 1: gate verifier FAIL triggers backward goto to step 0 (alice).
        await processIdle(ctx, team, team.members[1], "ses_bob");

        // Backward goto re-dispatches alice (step 0 body).
        const aliceRedispatch = calls.find((c) => c.sessionId === "ses_alice");
        expect(aliceRedispatch).toBeDefined();
        // Gate must remain incomplete after the backward jump so advancement
        // re-verifies it instead of skipping to the successor.
        expect(steps[1]?.completed).toBe(false);

        // Phase 2: body (alice) goes idle after re-running -> must re-verify gate.
        await processIdle(ctx, team, team.members[0], "ses_alice");

        // Gate (bob) must be re-dispatched for re-verification.
        const gateRedispatch = calls.filter((c) => c.sessionId === "ses_bob");
        expect(gateRedispatch.length).toBe(1);
        // Successor (carol) must remain undispatched.
        const carolDispatch = calls.find((c) => c.sessionId === "ses_carol");
        expect(carolDispatch).toBeUndefined();
    });
});

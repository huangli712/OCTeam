/**
 * B2: gate ensemble verdict tests.
 *
 * Gate steps with `verifiers` dispatch multiple verifiers in parallel and
 * aggregate their verdicts via `ensemble_policy`. Tests cover:
 *   - majority: 2 PASS + 1 FAIL -> aggregated PASS
 *   - majority: 1 PASS + 2 FAIL -> aggregated FAIL
 *   - unanimous: all PASS -> aggregated PASS
 *   - unanimous: 2 PASS + 1 FAIL -> aggregated INVALID
 *   - quorum: 2/3 PASS with quorum=0.6 -> aggregated PASS
 *   - one malformed verifier -> aggregated INVALID (parse_failure)
 */
import { describe, expect, test } from "bun:test";


import { processIdle } from "../src/orchestration/lifecycle/idle.js";
import type {
    MemberState,
    WorkflowGateStep,
    WorkflowStep,
} from "../src/core/types.js";

import type { Team } from "../src/state/store.js";
import { makeCtx, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js";



function makeEnsembleSteps(
    policy: "majority" | "quorum" | "unanimous",
    quorum?: number,
): WorkflowStep[] {
    return [
        { kind: "task", member: "alice", task: "do work", completed: true, output: "alice output" },
        {
            kind: "gate",
            verifiers: ["bob", "carol", "dave"],
            ensemblePolicy: policy,
            ...(quorum !== undefined ? { ensembleQuorum: quorum } : {}),
            criteria: "quality check",
            onFail: "fail",
            completed: false,
        },
        { kind: "task", member: "erin", task: "final step", completed: false },
    ];
}

function gateStepAt(steps: readonly WorkflowStep[] | undefined, index: number): WorkflowGateStep {
    const step = steps?.[index];
    if (step?.kind !== "gate") throw new Error(`Expected gate step at index ${index}`);
    return step;
}

function memberByName(team: Team, name: string): MemberState {
    const m = team.members.find((c) => c.name === name);
    if (!m) throw new Error(`Missing fixture member: ${name}`);
    return m;
}

const PASS_V = '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>';
const FAIL_V = '<verdict>{"result":"FAIL","rationale":"no","diff":"bad"}</verdict>';

describe("workflow ensemble gate", () => {
    test("majority: 2 PASS + 1 FAIL -> aggregated PASS", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: makeEnsembleSteps("majority"),
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
                { name: "erin", sessionId: "ses_erin" },
            ],
        });
        const ctx = makeCtx({ outputs: {
            ses_bob: PASS_V,
            ses_carol: PASS_V,
            ses_dave: FAIL_V,
        }, calls: calls });

        // process each verifier idle
        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob");
        await processIdle(ctx, team, memberByName(team, "carol"), "ses_carol");
        await processIdle(ctx, team, memberByName(team, "dave"), "ses_dave");

        expect(gateStepAt(task.steps, 1).verdict).toBe("PASS");
        expect(task.steps![1].completed).toBe(true);
        // workflow should advance to erin
        const erinDispatch = calls.find((c) => c.sessionId === "ses_erin");
        expect(erinDispatch).toBeDefined();
    });

    test("majority completes when dispatch records the last ensemble verifier", async () => {
        // Given an active ensemble gate in the state left by its dispatch loop.
        const calls: DispatchCall[] = [];
        const steps = makeEnsembleSteps("majority");
        const gate = steps[1];
        if (gate?.kind !== "gate") throw new Error("Missing ensemble gate fixture");
        gate.dispatchedActor = "dave";
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
                { name: "dave", sessionId: "ses_dave" },
                { name: "erin", sessionId: "ses_erin" },
            ],
        });
        const ctx = makeCtx({ outputs: {
            ses_bob: PASS_V,
            ses_carol: PASS_V,
            ses_dave: FAIL_V,
        }, calls });

        // When every verifier reports through the production idle path.
        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob");
        await processIdle(ctx, team, memberByName(team, "carol"), "ses_carol");
        await processIdle(ctx, team, memberByName(team, "dave"), "ses_dave");

        // Then the majority verdict completes and dispatches the successor.
        expect(gate.verdict).toBe("PASS");
        expect(gate.completed).toBe(true);
        expect(calls.some((call) => call.sessionId === "ses_erin")).toBe(true);
    });

    test("majority: 1 PASS + 2 FAIL -> aggregated FAIL, run fails", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: makeEnsembleSteps("majority"),
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
                { name: "erin", sessionId: "ses_erin" },
            ],
        });
        const ctx = makeCtx({ outputs: {
            ses_bob: PASS_V,
            ses_carol: FAIL_V,
            ses_dave: FAIL_V,
        }, calls: calls });

        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob");
        await processIdle(ctx, team, memberByName(team, "carol"), "ses_carol");
        await processIdle(ctx, team, memberByName(team, "dave"), "ses_dave");

        expect(gateStepAt(task.steps, 1).verdict).toBe("FAIL");
        expect(team.status).toBe("failed");
    });

    test("unanimous: all PASS -> aggregated PASS", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: makeEnsembleSteps("unanimous"),
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
                { name: "erin", sessionId: "ses_erin" },
            ],
        });
        const ctx = makeCtx({ outputs: {
            ses_bob: PASS_V,
            ses_carol: PASS_V,
            ses_dave: PASS_V,
        }, calls: calls });

        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob");
        await processIdle(ctx, team, memberByName(team, "carol"), "ses_carol");
        await processIdle(ctx, team, memberByName(team, "dave"), "ses_dave");

        expect(gateStepAt(task.steps, 1).verdict).toBe("PASS");
        expect(task.steps![1].completed).toBe(true);
        const erinDispatch = calls.find((c) => c.sessionId === "ses_erin");
        expect(erinDispatch).toBeDefined();
    });

    test("unanimous: 2 PASS + 1 FAIL -> aggregated INVALID", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: makeEnsembleSteps("unanimous"),
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
                { name: "erin", sessionId: "ses_erin" },
            ],
        });
        const ctx = makeCtx({ outputs: {
            ses_bob: PASS_V,
            ses_carol: PASS_V,
            ses_dave: FAIL_V,
        }, calls: calls });

        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob");
        await processIdle(ctx, team, memberByName(team, "carol"), "ses_carol");
        await processIdle(ctx, team, memberByName(team, "dave"), "ses_dave");

        // unanimous fails when not all agree -> INVALID -> default on_invalid=fail
        expect(gateStepAt(task.steps, 1).verdict).toBe("INVALID");
        expect(team.status).toBe("failed");
    });

    test("quorum: 2/3 PASS with quorum=0.6 -> aggregated PASS", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: makeEnsembleSteps("quorum", 0.6),
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
                { name: "erin", sessionId: "ses_erin" },
            ],
        });
        const ctx = makeCtx({ outputs: {
            ses_bob: PASS_V,
            ses_carol: PASS_V,
            ses_dave: FAIL_V,
        }, calls: calls });

        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob");
        await processIdle(ctx, team, memberByName(team, "carol"), "ses_carol");
        await processIdle(ctx, team, memberByName(team, "dave"), "ses_dave");

        // 2/3 = 0.667 >= 0.6 -> PASS
        expect(gateStepAt(task.steps, 1).verdict).toBe("PASS");
        expect(task.steps![1].completed).toBe(true);
    });

    test("one malformed verifier -> aggregated INVALID (parse_failure)", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: makeEnsembleSteps("majority"),
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
                { name: "erin", sessionId: "ses_erin" },
            ],
        });
        const ctx = makeCtx({ outputs: {
            ses_bob: PASS_V,
            ses_carol: PASS_V,
            ses_dave: "I cannot decide, no verdict tag",
        }, calls: calls });

        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob");
        await processIdle(ctx, team, memberByName(team, "carol"), "ses_carol");
        await processIdle(ctx, team, memberByName(team, "dave"), "ses_dave");

        // dave produced malformed verdict -> aggregated INVALID with parseFailed
        expect(gateStepAt(task.steps, 1).verdict).toBe("INVALID");
        expect(team.status).toBe("failed");
    });

    test("quorum: 1/3 PASS with quorum=0.6 -> aggregated FAIL", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: makeEnsembleSteps("quorum", 0.6),
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
                { name: "erin", sessionId: "ses_erin" },
            ],
        });
        const ctx = makeCtx({ outputs: {
            ses_bob: PASS_V,
            ses_carol: FAIL_V,
            ses_dave: FAIL_V,
        }, calls: calls });

        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob");
        await processIdle(ctx, team, memberByName(team, "carol"), "ses_carol");
        await processIdle(ctx, team, memberByName(team, "dave"), "ses_dave");

        // 1/3 = 0.333 < 0.6 -> FAIL
        expect(gateStepAt(task.steps, 1).verdict).toBe("FAIL");
    });
});

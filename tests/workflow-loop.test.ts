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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processIdle } from "../src/orchestration/handlers.js";
import type {
    ActiveTask,
    MemberState,
    WorkflowStep,
    WorkflowTask,
} from "../src/core/types.js";
import { AsyncMutex } from "../src/state/locks.js";
import type { Team } from "../src/state/store.js";
import type { PluginContext } from "../src/core/context.js";

type DispatchCall = { sessionId: string; text: string };

function makeCtx(
    outputs: Record<string, string>,
    calls: DispatchCall[] = [],
    storageRoot = "/tmp",
): PluginContext {
    return {
        storageRoot,
        scope: "project",
        directory: "/app",
        client: {
            session: {
                messages: async ({ path }: { path: { id: string } }) => {
                    const text = outputs[path.id] ?? "";
                    return {
                        data: [
                            { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
                            ...(text
                                ? [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }]
                                : []),
                        ],
                    };
                },
                promptAsync: async (args: any) => {
                    calls.push({ sessionId: args.path.id, text: args.body.parts[0].text });
                    return { data: {} };
                },
            },
        },
    } as unknown as PluginContext;
}

function makeWorkflowTask(
    opts: Partial<WorkflowTask> & { steps: WorkflowStep[] },
): WorkflowTask {
    return {
        type: "workflow",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        signoffPolicy: "none",
        ...opts,
    } as WorkflowTask;
}

function makeTeam(opts: {
    activeTask?: ActiveTask;
    members?: Array<Partial<MemberState> & Pick<MemberState, "name">>;
}): Team {
    const members: MemberState[] = (opts.members ?? []).map((m) => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: m.initialized ?? true,
        turnCount: m.turnCount ?? 0,
        sessionId: m.sessionId,
        agent: m.agent,
        isMaster: m.isMaster,
        error: m.error,
    }));
    return {
        version: 1,
        teamRunId: "test-run",
        teamName: "test-team",
        status: "busy",
        leadSessionId: "ses_lead",
        members,
        bounds: {
            maxMembers: 8,
            maxParallelMembers: 4,
            maxMessagesPerRun: 100,
            maxWallClockMinutes: 30,
            maxMemberTurns: 50,
            maxTasks: 200,
            messagePayloadMaxBytes: 32768,
            messageUnreadMaxBytes: 1048576,
        },
        createdAt: 0,
        activeTask: opts.activeTask,
        mutex: new AsyncMutex(),
        directory: mkdtempSync(join(tmpdir(), "octeam-loop-")),
    } as unknown as Team;
}

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
        const ctx = makeCtx({ ses_bob: FAIL_VERDICT }, calls);

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(task.steps![1].loopIterations).toBe(1);
        // loop back to step 0 (alice) should be re-dispatched
        const aliceRedispatch = calls.find((c) => c.sessionId === "ses_alice");
        expect(aliceRedispatch).toBeDefined();
        // jumpCount should NOT increment for loop-controlled goto
        expect(task.steps![1].jumpCount ?? 0).toBe(0);
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
        const ctx = makeCtx({ ses_bob: FAIL_VERDICT }, calls);

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
        const ctx = makeCtx({ ses_bob: FAIL_VERDICT }, calls);

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
        const ctx = makeCtx({ ses_bob: PASS_VERDICT }, calls);

        await processIdle(ctx, team, team.members[1], "ses_bob");

        // PASS does not increment loopIterations
        expect(task.steps![1].loopIterations).toBe(1);
        expect(task.steps![1].completed).toBe(true);
        // workflow should advance to step 2 (carol)
        const carolDispatch = calls.find((c) => c.sessionId === "ses_carol");
        expect(carolDispatch).toBeDefined();
    });
});

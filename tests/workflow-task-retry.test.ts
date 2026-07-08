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
        directory: mkdtempSync(join(tmpdir(), "octeam-task-retry-")),
    } as unknown as Team;
}

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
        const ctx = makeCtx({ ses_alice: "   " }, calls);

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
        const ctx = makeCtx({ ses_alice: "ERROR: something broke" }, calls);

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
        const ctx = makeCtx({ ses_alice: "failed to complete" }, calls);

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
        const ctx = makeCtx({ ses_alice: "work in progress" }, calls);

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
        const ctx = makeCtx({ ses_alice: "real output here" }, calls);

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
        const ctx = makeCtx({ ses_alice: "" }, calls);

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

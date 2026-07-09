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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processIdle } from "../src/orchestration/idle.js";
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
        directory: mkdtempSync(join(tmpdir(), "octeam-ensemble-")),
    } as unknown as Team;
}

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
        const ctx = makeCtx({
            ses_bob: PASS_V,
            ses_carol: PASS_V,
            ses_dave: FAIL_V,
        }, calls);

        // process each verifier idle
        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob");
        await processIdle(ctx, team, memberByName(team, "carol"), "ses_carol");
        await processIdle(ctx, team, memberByName(team, "dave"), "ses_dave");

        expect(task.steps![1].verdict).toBe("PASS");
        expect(task.steps![1].completed).toBe(true);
        // workflow should advance to erin
        const erinDispatch = calls.find((c) => c.sessionId === "ses_erin");
        expect(erinDispatch).toBeDefined();
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
        const ctx = makeCtx({
            ses_bob: PASS_V,
            ses_carol: FAIL_V,
            ses_dave: FAIL_V,
        }, calls);

        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob");
        await processIdle(ctx, team, memberByName(team, "carol"), "ses_carol");
        await processIdle(ctx, team, memberByName(team, "dave"), "ses_dave");

        expect(task.steps![1].verdict).toBe("FAIL");
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
        const ctx = makeCtx({
            ses_bob: PASS_V,
            ses_carol: PASS_V,
            ses_dave: PASS_V,
        }, calls);

        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob");
        await processIdle(ctx, team, memberByName(team, "carol"), "ses_carol");
        await processIdle(ctx, team, memberByName(team, "dave"), "ses_dave");

        expect(task.steps![1].verdict).toBe("PASS");
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
        const ctx = makeCtx({
            ses_bob: PASS_V,
            ses_carol: PASS_V,
            ses_dave: FAIL_V,
        }, calls);

        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob");
        await processIdle(ctx, team, memberByName(team, "carol"), "ses_carol");
        await processIdle(ctx, team, memberByName(team, "dave"), "ses_dave");

        // unanimous fails when not all agree -> INVALID -> default on_invalid=fail
        expect(task.steps![1].verdict).toBe("INVALID");
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
        const ctx = makeCtx({
            ses_bob: PASS_V,
            ses_carol: PASS_V,
            ses_dave: FAIL_V,
        }, calls);

        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob");
        await processIdle(ctx, team, memberByName(team, "carol"), "ses_carol");
        await processIdle(ctx, team, memberByName(team, "dave"), "ses_dave");

        // 2/3 = 0.667 >= 0.6 -> PASS
        expect(task.steps![1].verdict).toBe("PASS");
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
        const ctx = makeCtx({
            ses_bob: PASS_V,
            ses_carol: PASS_V,
            ses_dave: "I cannot decide, no verdict tag",
        }, calls);

        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob");
        await processIdle(ctx, team, memberByName(team, "carol"), "ses_carol");
        await processIdle(ctx, team, memberByName(team, "dave"), "ses_dave");

        // dave produced malformed verdict -> aggregated INVALID with parseFailed
        expect(task.steps![1].verdict).toBe("INVALID");
        expect(team.status).toBe("failed");
    });
});

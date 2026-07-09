/**
 * Workflow handler execution tests (TDD RED→GREEN for Wave 2 T2).
 *
 * Mirrors the pipeline-exec.test.ts stub-ctx harness: makeCtx captures member
 * outputs and records promptAsync dispatches; makeTeam/buildWorkflowTask fixture
 * the state. Drives the handler via processIdle (the real idle entry point) so
 * identity validation (getExpectedMember), output capture, and dispatch all run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processIdle } from "../src/orchestration/idle.js";
import { checkTermination } from "../src/orchestration/termination.js";
import { advanceWorkflowStep } from "../src/orchestration/workflow.js";
import { readRunEvents, readRunRecord } from "../src/orchestration/runs.js";
import type {
    ActiveTask,
    MemberState,
    WorkflowStep,
    WorkflowTask,
} from "../src/core/types.js";


import { AsyncMutex } from "../src/state/locks.js";
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js";
import { initTeamState, loadTeamState } from "../src/state/store.js";
import type { Team } from "../src/state/store.js";
import {
    teamWorkflowTool,
    type WorkflowToolStep,
} from "../src/tools/workflow.js";
import type { PluginContext } from "../src/core/context.js";
import { makeCtx, makeMember, makeState, makeToolContext, type DispatchCall, waitForEvent } from "./helpers.js";


const trackedSessions: string[] = [];
afterEach(() => {
    for (const sid of trackedSessions.splice(0)) unindexSession(sid);
});

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
        directory: mkdtempSync(join(tmpdir(), "octeam-wf-")),
    } as unknown as Team;
}

function findTeamMember(team: Team, name: string): MemberState {
    const member = team.members.find((candidate) => candidate.name === name);
    if (member === undefined) {
        throw new Error(`Missing fixture member: ${name}`);
    }
    return member;
}

function sessionIdFor(team: Team, name: string): string {
    const sessionId = findTeamMember(team, name).sessionId;
    if (sessionId === undefined) {
        throw new Error(`Missing fixture session: ${name}`);
    }
    return sessionId;
}

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

type FanoutHappyFixture = {
    readonly calls: DispatchCall[];
    readonly task: WorkflowTask;
    readonly team: Team;
    readonly ctx: PluginContext;
};

type ToolLoweredFanoutFixture = FanoutHappyFixture & {
    readonly startupResult: string;
};

function makeToolLoweredFanoutSteps(maxErrored = 0): WorkflowToolStep[] {
    return [
        { kind: "task", member: "alice", task: "prepare shared context" },
        {
            kind: "fanout",
            max_errored: maxErrored,
            branches: [
                {
                    id: "api",
                    steps: [
                        {
                            kind: "task",
                            member: "bob",
                            task: "build api branch",
                        },
                        {
                            kind: "gate",
                            verifier: "erin",
                            criteria: "api branch passes",
                        },
                    ],
                },
                {
                    id: "tests",
                    steps: [
                        {
                            kind: "task",
                            member: "carol",
                            task: "build test branch",
                        },
                        {
                            kind: "gate",
                            verifier: "eve",
                            criteria: "test branch passes",
                        },
                    ],
                },
            ],
        },
        { kind: "join" },
        { kind: "task", member: "dave", task: "integrate branch results" },
    ];
}

async function startToolLoweredFanoutWorkflow(
    maxErrored = 0,
): Promise<ToolLoweredFanoutFixture> {
    const id = crypto.randomUUID();
    const root = mkdtempSync(join(tmpdir(), "octeam-wf-tool-fanout-"));
    const sessions = {
        master: `ses_wf_master_${id}`,
        alice: `ses_wf_alice_${id}`,
        bob: `ses_wf_bob_${id}`,
        erin: `ses_wf_erin_${id}`,
        carol: `ses_wf_carol_${id}`,
        eve: `ses_wf_eve_${id}`,
        dave: `ses_wf_dave_${id}`,
    };
    trackedSessions.push(...Object.values(sessions));
    const calls: DispatchCall[] = [];
    const ctx = makeCtx({ outputs: {
        [sessions.alice]: "shared pre-fanout output",
        [sessions.bob]: "api branch output",
        [sessions.erin]: PASS_VERDICT,
        [sessions.carol]: "tests branch output",
        [sessions.eve]: PASS_VERDICT,
        [sessions.dave]: "downstream integrated output",
    }, calls: calls, storageRoot: root });
    await initTeamState(
        root,
        makeState(
            "alpha",
            sessions.master,
            [
                makeMember("alice", sessions.alice),
                makeMember("bob", sessions.bob),
                makeMember("erin", sessions.erin),
                makeMember("carol", sessions.carol),
                makeMember("eve", sessions.eve),
                makeMember("dave", sessions.dave),
            ],
            Date.now(),
        ),
        sessions.master,
    );
    await rebuildSessionIndex(root, `${root}__unused`);

    const startupResult = await teamWorkflowTool(ctx).execute(
        { team_id: "alpha", steps: makeToolLoweredFanoutSteps(maxErrored) },
        makeToolContext(sessions.master),
    );
    const team = await loadTeamState(root, "alpha", sessions.master);
    const task = team.activeTask;
    if (task?.type !== "workflow")
        throw new Error("Expected workflow task after team_workflow startup");

    return { calls, task, team, ctx, startupResult };
}

function makeFanoutHappyFixture(
    includeDownstream = true,
    maxErrored = 0,
): FanoutHappyFixture {
    const calls: DispatchCall[] = [];
    const steps: WorkflowStep[] = [
        {
            kind: "task",
            member: "alice",
            task: "prepare shared context",
            completed: false,
        },
        {
            kind: "fanout",
            completed: false,
            fanout: {
                branchIds: ["api", "tests"],
                branchRanges: [
                    { startIndex: 2, endIndex: 3 },
                    { startIndex: 4, endIndex: 4 },
                ],
                joinIndex: 5,
                maxErrored,
            },
        },
        {
            kind: "task",
            member: "bob",
            task: "build api branch",
            completed: false,
            branch: {
                fanoutIndex: 1,
                branchId: "api",
                branchIndex: 0,
                joinIndex: 5,
            },
        },
        {
            kind: "task",
            member: "erin",
            task: "package api branch",
            completed: false,
            branch: {
                fanoutIndex: 1,
                branchId: "api",
                branchIndex: 0,
                joinIndex: 5,
            },
        },
        {
            kind: "task",
            member: "carol",
            task: "build test branch",
            completed: false,
            branch: {
                fanoutIndex: 1,
                branchId: "tests",
                branchIndex: 1,
                joinIndex: 5,
            },
        },
        {
            kind: "join",
            completed: false,
            join: { fanoutIndex: 1, branchTailIndices: [3, 4], maxErrored },
        },
    ];
    if (includeDownstream) {
        steps.push({
            kind: "task",
            member: "dave",
            task: "integrate branch results",
            completed: false,
        });
    }
    const task = makeWorkflowTask({
        steps,
        currentStageIndex: 0,
        activeStepIndices: [0],
    });
    const team = makeTeam({
        activeTask: task,
        members: [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
            { name: "erin", sessionId: "ses_erin" },
            { name: "carol", sessionId: "ses_carol" },
            { name: "dave", sessionId: "ses_dave" },
        ],
    });
    const ctx = makeCtx({ outputs: {
        ses_alice: "shared pre-fanout output",
        ses_bob: "api branch output",
        ses_erin: "api packaged output",
        ses_carol: "tests branch output",
        ses_dave: "downstream integrated output",
    }, calls: calls });

    return { calls, task, team, ctx };
}

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

describe("handleWorkflowIdle (via processIdle): fanout frontier", () => {
    test("fanout happy path dispatches both branches and joins into downstream context", async () => {
        const { calls, task, team, ctx } = makeFanoutHappyFixture();

        await processIdle(
            ctx,
            team,
            findTeamMember(team, "alice"),
            "ses_alice",
        );

        const bobCall = calls.find((call) => call.sessionId === "ses_bob");
        const carolCall = calls.find((call) => call.sessionId === "ses_carol");
        expect(bobCall).toBeDefined();
        expect(carolCall).toBeDefined();
        expect(bobCall?.text).toContain("build api branch");
        expect(carolCall?.text).toContain("build test branch");
        expect(bobCall?.text).toContain("shared pre-fanout output");
        expect(carolCall?.text).toContain("shared pre-fanout output");
        expect(task.currentStageIndex).toBe(2);
        expect(task.activeStepIndices).toEqual([2, 4]);

        await processIdle(ctx, team, findTeamMember(team, "bob"), "ses_bob");

        const erinCall = calls.find((call) => call.sessionId === "ses_erin");
        expect(erinCall).toBeDefined();
        expect(erinCall?.text).toContain("package api branch");
        expect(erinCall?.text).toContain("shared pre-fanout output");
        expect(erinCall?.text).toContain("api branch output");
        expect(erinCall?.text).not.toContain("tests branch output");
        expect(calls.some((call) => call.sessionId === "ses_dave")).toBe(false);
        expect(task.steps?.[2]?.completed).toBe(true);
        expect(task.steps?.[3]?.completed).toBe(false);
        expect(task.steps?.[4]?.completed).toBe(false);

        await processIdle(
            ctx,
            team,
            findTeamMember(team, "carol"),
            "ses_carol",
        );

        expect(calls.some((call) => call.sessionId === "ses_dave")).toBe(false);
        expect(task.steps?.[4]?.completed).toBe(true);

        await processIdle(ctx, team, findTeamMember(team, "erin"), "ses_erin");

        const joinStep = task.steps?.[5];
        expect(joinStep?.completed).toBe(true);
        expect(joinStep?.join?.joinedOutput).toContain("api branch output");
        expect(joinStep?.join?.joinedOutput).toContain("api packaged output");
        expect(joinStep?.join?.joinedOutput).toContain("tests branch output");
        expect(task.currentStageIndex).toBe(6);
        expect(task.activeStepIndices).toEqual([6]);
        const daveCall = calls.find((call) => call.sessionId === "ses_dave");
        expect(daveCall).toBeDefined();
        expect(daveCall?.text).toContain("integrate branch results");
        expect(daveCall?.text).toContain("api branch output");
        expect(daveCall?.text).toContain("api packaged output");
        expect(daveCall?.text).toContain("tests branch output");
    });

    test("join fires once under repeated idle events after both branches finish", async () => {
        const { calls, task, team, ctx } = makeFanoutHappyFixture();

        await processIdle(
            ctx,
            team,
            findTeamMember(team, "alice"),
            "ses_alice",
        );
        await processIdle(ctx, team, findTeamMember(team, "bob"), "ses_bob");
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "carol"),
            "ses_carol",
        );
        await processIdle(ctx, team, findTeamMember(team, "erin"), "ses_erin");
        const joinedOutput = task.steps?.[5]?.join?.joinedOutput;

        await processIdle(
            ctx,
            team,
            findTeamMember(team, "carol"),
            "ses_carol",
        );
        await processIdle(ctx, team, findTeamMember(team, "bob"), "ses_bob");
        await processIdle(ctx, team, findTeamMember(team, "erin"), "ses_erin");

        expect(task.steps?.[5]?.completed).toBe(true);
        expect(task.steps?.[5]?.join?.joinedOutput).toBe(joinedOutput);
        expect(
            calls.filter((call) => call.sessionId === "ses_dave"),
        ).toHaveLength(1);
        expect(task.currentStageIndex).toBe(6);
        expect(task.activeStepIndices).toEqual([6]);
    });

    test("fanout happy path completes after the downstream task idles", async () => {
        const { calls, task, team, ctx } = makeFanoutHappyFixture();

        expect(task.steps?.[1]?.completed).toBe(false);

        await processIdle(
            ctx,
            team,
            findTeamMember(team, "alice"),
            "ses_alice",
        );
        await processIdle(ctx, team, findTeamMember(team, "bob"), "ses_bob");
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "carol"),
            "ses_carol",
        );
        await processIdle(ctx, team, findTeamMember(team, "erin"), "ses_erin");

        expect(team.status).toBe("busy");
        expect(team.activeTask).toBeDefined();
        expect(
            calls.filter(
                (call) =>
                    call.sessionId === "ses_lead" &&
                    call.text.includes("workflow_complete"),
            ),
        ).toHaveLength(0);

        await processIdle(ctx, team, findTeamMember(team, "dave"), "ses_dave");

        expect(task.steps?.[1]?.completed).toBe(true);
        expect(team.status).toBe("idle");
        expect(team.activeTask).toBeUndefined();
        expect(
            calls.filter(
                (call) =>
                    call.sessionId === "ses_lead" &&
                    call.text.includes("workflow_complete"),
            ),
        ).toHaveLength(1);
    });

    test("fanout happy path completes when join is the final step", async () => {
        const { calls, task, team, ctx } = makeFanoutHappyFixture(false);

        expect(task.steps?.[1]?.completed).toBe(false);

        await processIdle(
            ctx,
            team,
            findTeamMember(team, "alice"),
            "ses_alice",
        );
        await processIdle(ctx, team, findTeamMember(team, "bob"), "ses_bob");
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "carol"),
            "ses_carol",
        );
        await processIdle(ctx, team, findTeamMember(team, "erin"), "ses_erin");

        expect(task.steps?.[1]?.completed).toBe(true);
        expect(task.steps?.[5]?.completed).toBe(true);
        expect(team.status).toBe("idle");
        expect(team.activeTask).toBeUndefined();
        expect(
            calls.filter(
                (call) =>
                    call.sessionId === "ses_lead" &&
                    call.text.includes("workflow_complete"),
            ),
        ).toHaveLength(1);
        expect(calls.some((call) => call.sessionId === "ses_dave")).toBe(false);
    });

    test("tool-lowered fanout task/gate branches join into downstream context", async () => {
        // Given: team_workflow lowered a task -> fanout(branch task/gate chains) -> join -> downstream task graph.
        const { calls, task, team, ctx, startupResult } =
            await startToolLoweredFanoutWorkflow();

        expect(startupResult).toContain("team_workflow started");
        expect(task.steps?.map((step) => step.kind)).toEqual([
            "task",
            "fanout",
            "task",
            "gate",
            "task",
            "gate",
            "join",
            "task",
        ]);
        expect(task.steps?.[1]?.fanout?.branchRanges).toEqual([
            { startIndex: 2, endIndex: 3 },
            { startIndex: 4, endIndex: 5 },
        ]);
        expect(task.steps?.[0]?.dispatchedAt).toBeNumber();
        expect(task.activeStepIndices).toEqual([0]);

        // When: processIdle drives both branch chains through task output and gate PASS verdicts.
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "alice"),
            sessionIdFor(team, "alice"),
        );
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "bob"),
            sessionIdFor(team, "bob"),
        );
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "carol"),
            sessionIdFor(team, "carol"),
        );
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "erin"),
            sessionIdFor(team, "erin"),
        );
        expect(
            calls.some((call) =>
                call.text.includes("integrate branch results"),
            ),
        ).toBe(false);
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "eve"),
            sessionIdFor(team, "eve"),
        );

        // Then: the join uses task outputs from both surviving branches and dispatches downstream work.
        const joinStep = task.steps?.[6];
        expect(joinStep?.completed).toBe(true);
        expect(joinStep?.join?.joinedOutput).toContain("api branch output");
        expect(joinStep?.join?.joinedOutput).toContain("tests branch output");
        expect(joinStep?.join?.joinedOutput).not.toContain("PASS");
        const daveCall = calls.find((call) =>
            call.text.includes("integrate branch results"),
        );
        expect(daveCall).toBeDefined();
        expect(daveCall?.text).toContain("api branch output");
        expect(daveCall?.text).toContain("tests branch output");
        expect(task.activeStepIndices).toEqual([7]);

        await processIdle(
            ctx,
            team,
            findTeamMember(team, "dave"),
            sessionIdFor(team, "dave"),
        );
        expect(team.status).toBe("idle");
        expect(team.activeTask).toBeUndefined();
    });

    test("tool-lowered reduce fanout dispatches reducer before downstream and uses reducer output", async () => {
        // Given: a workflow fanout using join_policy=reduce with a reducer member.
        const id = crypto.randomUUID();
        const root = mkdtempSync(
            join(tmpdir(), "octeam-wf-tool-reduce-fanout-"),
        );
        const sessions = {
            master: `ses_wf_master_${id}`,
            alice: `ses_wf_alice_${id}`,
            bob: `ses_wf_bob_${id}`,
            carol: `ses_wf_carol_${id}`,
            rachel: `ses_wf_rachel_${id}`,
            dave: `ses_wf_dave_${id}`,
        };
        trackedSessions.push(...Object.values(sessions));
        const calls: DispatchCall[] = [];
        const ctx = makeCtx({ outputs: {
            [sessions.alice]: "shared pre-fanout output",
            [sessions.bob]: "api branch output",
            [sessions.carol]: "tests branch output",
            [sessions.rachel]: "reduced branch summary",
            [sessions.dave]: "downstream integrated output",
        }, calls: calls, storageRoot: root });
        await initTeamState(
            root,
            makeState(
                "alpha",
                sessions.master,
                [
                    makeMember("alice", sessions.alice),
                    makeMember("bob", sessions.bob),
                    makeMember("carol", sessions.carol),
                    makeMember("rachel", sessions.rachel),
                    makeMember("dave", sessions.dave),
                ],
                Date.now(),
            ),
            sessions.master,
        );
        await rebuildSessionIndex(root, `${root}__unused`);

        const startupResult = await teamWorkflowTool(ctx).execute(
            {
                team_id: "alpha",
                steps: [
                    {
                        kind: "task",
                        member: "alice",
                        task: "prepare shared context",
                    },
                    {
                        kind: "fanout",
                        join_policy: "reduce",
                        reducer_member: "rachel",
                        branches: [
                            {
                                id: "api",
                                steps: [
                                    {
                                        kind: "task",
                                        member: "bob",
                                        task: "build api branch",
                                    },
                                ],
                            },
                            {
                                id: "tests",
                                steps: [
                                    {
                                        kind: "task",
                                        member: "carol",
                                        task: "build test branch",
                                    },
                                ],
                            },
                        ],
                    },
                    { kind: "join" },
                    {
                        kind: "task",
                        member: "dave",
                        task: "integrate branch results",
                    },
                ],
            },
            makeToolContext(sessions.master),
        );
        const team = await loadTeamState(root, "alpha", sessions.master);
        const task = team.activeTask;
        if (task?.type !== "workflow")
            throw new Error(
                "Expected workflow task after team_workflow startup",
            );

        // When: both branches complete.
        expect(startupResult).toContain("team_workflow started");
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "alice"),
            sessions.alice,
        );
        await processIdle(ctx, team, findTeamMember(team, "bob"), sessions.bob);
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "carol"),
            sessions.carol,
        );

        // Then: the reducer is dispatched first, and downstream is not dispatched yet.
        const reducerCall = calls.find(
            (call) => call.sessionId === sessions.rachel,
        );
        expect(reducerCall).toBeDefined();
        expect(reducerCall?.text).toContain("api branch output");
        expect(reducerCall?.text).toContain("tests branch output");
        expect(calls.some((call) => call.sessionId === sessions.dave)).toBe(
            false,
        );
        expect(task.steps?.[4]?.completed).toBe(false);
        expect(task.activeStepIndices).toEqual([4]);

        // When: the reducer produces the aggregate.
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "rachel"),
            sessions.rachel,
        );

        // Then: the join output is the reducer result, and downstream receives only the aggregate.
        const joinStep = task.steps?.[4];
        expect(joinStep?.completed).toBe(true);
        expect(joinStep?.join?.joinedOutput).toBe("reduced branch summary");
        const daveCall = calls.find((call) => call.sessionId === sessions.dave);
        expect(daveCall).toBeDefined();
        expect(daveCall?.text).toContain("integrate branch results");
        expect(daveCall?.text).toContain("reduced branch summary");
        expect(daveCall?.text).not.toContain("api branch output");
        expect(daveCall?.text).not.toContain("tests branch output");
    });

    test("a fanout branch task with expose_output=false is excluded from the joined output", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "secret"],
                        branchRanges: [
                            { startIndex: 1, endIndex: 1 },
                            { startIndex: 2, endIndex: 2 },
                        ],
                        joinIndex: 3,
                        maxErrored: 0,
                    },
                },
                {
                    kind: "task",
                    member: "alice",
                    task: "api",
                    completed: true,
                    output: "api output",
                    branch: {
                        fanoutIndex: 0,
                        branchId: "api",
                        branchIndex: 0,
                        joinIndex: 3,
                    },
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "secret",
                    completed: true,
                    output: "secret output",
                    exposeOutput: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "secret",
                        branchIndex: 1,
                        joinIndex: 3,
                    },
                },
                {
                    kind: "join",
                    completed: false,
                    join: {
                        fanoutIndex: 0,
                        branchTailIndices: [1, 2],
                        maxErrored: 0,
                    },
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "consume joined output",
                    completed: false,
                },
            ],
            currentStageIndex: 3,
            activeStepIndices: [3],
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
        expect(carolCall!.text).toContain("api output");
        expect(carolCall!.text).not.toContain("secret output");
    });

    test("tool-lowered fanout branch gate failure within tolerance joins survivor output", async () => {
        // Given: the api branch has reached its verifier while one branch error is tolerated.
        const { calls, task, team, ctx } =
            await startToolLoweredFanoutWorkflow(1);
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "alice"),
            sessionIdFor(team, "alice"),
        );
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "bob"),
            sessionIdFor(team, "bob"),
        );
        const erin = findTeamMember(team, "erin");
        erin.status = "errored";
        erin.error = "verifier outage";

        // When: termination marks the failed branch, and the sibling branch completes through its gate.
        await checkTermination(ctx, team);
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "carol"),
            sessionIdFor(team, "carol"),
        );
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "eve"),
            sessionIdFor(team, "eve"),
        );

        // Then: only the surviving branch feeds the join and downstream dispatch.
        const joinStep = task.steps?.[6];
        expect(team.status).toBe("busy");
        expect(team.activeTask).toBeDefined();
        expect(task.steps?.[3]?.skipped).toBe(true);
        expect(joinStep?.completed).toBe(true);
        expect(joinStep?.join?.survivorBranchIds).toEqual(["tests"]);
        expect(joinStep?.join?.erroredBranchIds).toEqual(["api"]);
        expect(joinStep?.join?.joinedOutput).toContain("tests branch output");
        expect(joinStep?.join?.joinedOutput).not.toContain("api branch output");
        const daveCall = calls.find((call) =>
            call.text.includes("integrate branch results"),
        );
        expect(daveCall).toBeDefined();
        expect(daveCall?.text).toContain("tests branch output");
        expect(daveCall?.text).not.toContain("api branch output");
    });

    test("tool-lowered fanout branch gate failure over tolerance fails the workflow", async () => {
        // Given: the default fanout tolerance is zero and the api verifier errors mid-branch.
        const { calls, task, team, ctx } =
            await startToolLoweredFanoutWorkflow();
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "alice"),
            sessionIdFor(team, "alice"),
        );
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "bob"),
            sessionIdFor(team, "bob"),
        );
        const erin = findTeamMember(team, "erin");
        erin.status = "errored";
        erin.error = "verifier outage";

        // When: termination evaluates the active fanout.
        await checkTermination(ctx, team);

        // Then: the run fails instead of joining or dispatching downstream work.
        expect(team.status).toBe("failed");
        expect(team.activeTask).toBeUndefined();
        expect(
            calls.some((call) =>
                call.text.includes("integrate branch results"),
            ),
        ).toBe(false);
        const leaderCall = calls.find((call) =>
            call.text.includes("workflow_failed:fanout:2:over_tolerance"),
        );
        expect(leaderCall).toBeDefined();
        const runId = task.runId;
        expect(runId).toBeDefined();
        const record =
            runId === undefined
                ? null
                : await readRunRecord(team.directory, runId);
        expect(record?.status).toBe("failed");
        expect(record?.reason).toBe("workflow_failed:fanout:2:over_tolerance");
    });

    test("tool-lowered fanout branch INVALID retry uses that branch gate index", async () => {
        const { calls, task, team, ctx } =
            await startToolLoweredFanoutWorkflow();
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "alice"),
            sessionIdFor(team, "alice"),
        );
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "bob"),
            sessionIdFor(team, "bob"),
        );
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "carol"),
            sessionIdFor(team, "carol"),
        );
        const testsGate = task.steps?.[5];
        if (testsGate?.kind !== "gate")
            throw new Error("Expected tests branch gate");
        testsGate.onInvalid = "retry_verifier";
        testsGate.maxInvalidRetries = 1;

        const invalidCtx = makeCtx({ outputs: { [sessionIdFor(team, "eve")]: INVALID_VERDICT }, calls: calls, storageRoot: ctx.storageRoot });
        await processIdle(
            invalidCtx,
            team,
            findTeamMember(team, "eve"),
            sessionIdFor(team, "eve"),
        );

        expect(testsGate.invalidAttempts).toBe(1);
        const retryCall = calls
            .filter((call) => call.sessionId === sessionIdFor(team, "eve"))
            .at(-1);
        expect(retryCall).toBeDefined();
        expect(retryCall?.text).toContain("tests branch output");
        expect(retryCall?.text).not.toContain("api branch output");
        const events = await readRunEvents(team.directory, task.runId!);
        const retryEvent = events.find(
            (event) => event.kind === "retry" && event.member === "eve",
        );
        expect(retryEvent?.stage).toBe(5);
        expect(retryEvent?.detail).toContain("workflow step 6");
    });

    test("fanout active branch actors complete their own step snapshots", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "tests"],
                        branchRanges: [
                            { startIndex: 1, endIndex: 1 },
                            { startIndex: 2, endIndex: 2 },
                        ],
                        joinIndex: 3,
                        maxErrored: 0,
                    },
                },
                {
                    kind: "task",
                    member: "alice",
                    task: "api branch",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "api",
                        branchIndex: 0,
                        joinIndex: 3,
                    },
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "tests branch",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "tests",
                        branchIndex: 1,
                        joinIndex: 3,
                    },
                },
                {
                    kind: "join",
                    completed: false,
                    join: {
                        fanoutIndex: 0,
                        branchTailIndices: [1, 2],
                        maxErrored: 0,
                    },
                },
            ],
            currentStageIndex: 0,
            activeStepIndices: [1, 2],
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });

        await processIdle(
            makeCtx({ outputs: { ses_alice: "api branch output" }, calls: calls }),
            team,
            findTeamMember(team, "alice"),
            "ses_alice",
        );
        await processIdle(
            makeCtx({ outputs: { ses_bob: "tests branch output" }, calls: calls }),
            team,
            findTeamMember(team, "bob"),
            "ses_bob",
        );

        const apiStep = task.steps?.[1];
        const testsStep = task.steps?.[2];
        expect(apiStep?.completed).toBe(true);
        expect(apiStep?.output).toContain("api branch output");
        expect(testsStep?.completed).toBe(true);
        expect(testsStep?.output).toContain("tests branch output");
        expect(apiStep?.output).not.toContain("tests branch output");
        expect(testsStep?.output).not.toContain("api branch output");
        expect(task.steps?.[3]?.completed).toBe(true);
        expect(task.steps?.[3]?.join?.joinedOutput).toContain(
            "api branch output",
        );
        expect(task.steps?.[3]?.join?.joinedOutput).toContain(
            "tests branch output",
        );
        expect(task.currentStageIndex).toBe(3);
        expect(team.status).toBe("idle");
        expect(team.activeTask).toBeUndefined();
        expect(
            calls.some(
                (call) =>
                    call.sessionId === "ses_lead" &&
                    call.text.includes("workflow_complete"),
            ),
        ).toBe(true);
    });

    test("a fanout stray idle is rejected without capturing a branch snapshot", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "tests"],
                        branchRanges: [
                            { startIndex: 1, endIndex: 1 },
                            { startIndex: 2, endIndex: 2 },
                        ],
                        joinIndex: 3,
                        maxErrored: 0,
                    },
                },
                {
                    kind: "task",
                    member: "alice",
                    task: "api branch",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "api",
                        branchIndex: 0,
                        joinIndex: 3,
                    },
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "tests branch",
                    completed: false,
                    branch: {
                        fanoutIndex: 0,
                        branchId: "tests",
                        branchIndex: 1,
                        joinIndex: 3,
                    },
                },
                {
                    kind: "join",
                    completed: false,
                    join: {
                        fanoutIndex: 0,
                        branchTailIndices: [1, 2],
                        maxErrored: 0,
                    },
                },
            ],
            currentStageIndex: 0,
            activeStepIndices: [1, 2],
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        });

        await processIdle(
            makeCtx({ outputs: { ses_carol: "stray output" }, calls: calls }),
            team,
            findTeamMember(team, "carol"),
            "ses_carol",
        );

        expect(task.steps?.[1]?.completed).toBe(false);
        expect(task.steps?.[2]?.completed).toBe(false);
        expect(task.steps?.[1]?.output).toBeUndefined();
        expect(task.steps?.[2]?.output).toBeUndefined();
        expect(task.responses["carol"]).toBeUndefined();
        expect(task.currentStageIndex).toBe(0);
        expect(calls).toHaveLength(0);
    });

    test("fanout partial failure within tolerance joins survivor output downstream", async () => {
        // Given: a fanout with one tolerated branch failure.
        const { calls, task, team, ctx } = makeFanoutHappyFixture(true, 1);
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "alice"),
            "ses_alice",
        );
        const bob = findTeamMember(team, "bob");
        bob.status = "errored";
        bob.error = "provider outage";

        // When: termination observes the branch error, then the survivor branch completes.
        await checkTermination(ctx, team);
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "carol"),
            "ses_carol",
        );

        // Then: the join fires with only survivor output and dispatches downstream work.
        const joinStep = task.steps?.[5];
        expect(team.status).toBe("busy");
        expect(team.activeTask).toBeDefined();
        expect(joinStep?.completed).toBe(true);
        expect(joinStep?.join?.survivorBranchIds).toEqual(["tests"]);
        expect(joinStep?.join?.erroredBranchIds).toEqual(["api"]);
        expect(joinStep?.join?.joinedOutput).toContain("tests branch output");
        expect(joinStep?.join?.joinedOutput).not.toContain("api branch output");
        expect(joinStep?.join?.joinedOutput).not.toContain(
            "api packaged output",
        );
        const daveCall = calls.find((call) => call.sessionId === "ses_dave");
        expect(daveCall).toBeDefined();
        expect(daveCall?.text).toContain("integrate branch results");
        expect(daveCall?.text).toContain("tests branch output");
        expect(daveCall?.text).not.toContain("api branch output");
    });

    test("fanout default over tolerance fails workflow with failed run status", async () => {
        // Given: a default-tolerance fanout with one active branch error.
        const { calls, task, team, ctx } = makeFanoutHappyFixture();
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "alice"),
            "ses_alice",
        );
        const bob = findTeamMember(team, "bob");
        bob.status = "errored";
        bob.error = "provider outage";

        // When: termination evaluates the active fanout.
        await checkTermination(ctx, team);

        // Then: the workflow fails with a workflow_failed reason persisted as failed.
        expect(team.status).toBe("failed");
        expect(team.activeTask).toBeUndefined();
        const leaderCall = calls.find((call) => call.sessionId === "ses_lead");
        expect(leaderCall?.text).toContain(
            "workflow_failed:fanout:2:over_tolerance",
        );
        const runId = task.runId;
        expect(runId).toBeDefined();
        const record =
            runId === undefined
                ? null
                : await readRunRecord(team.directory, runId);
        expect(record?.status).toBe("failed");
        expect(record?.reason).toBe("workflow_failed:fanout:2:over_tolerance");
    });

    test("fanout all branches errored fails workflow even within numeric tolerance", async () => {
        // Given: every active branch in a fanout has errored.
        const { calls, task, team, ctx } = makeFanoutHappyFixture(true, 1);
        await processIdle(
            ctx,
            team,
            findTeamMember(team, "alice"),
            "ses_alice",
        );
        const bob = findTeamMember(team, "bob");
        const carol = findTeamMember(team, "carol");
        bob.status = "errored";
        bob.error = "provider outage";
        carol.status = "errored";
        carol.error = "provider outage";

        // When: termination evaluates the active fanout.
        await checkTermination(ctx, team);

        // Then: zero survivors fails as workflow_failed and persists failed status.
        expect(team.status).toBe("failed");
        expect(team.activeTask).toBeUndefined();
        const leaderCall = calls.find((call) => call.sessionId === "ses_lead");
        expect(leaderCall?.text).toContain(
            "workflow_failed:fanout:2:all_errored",
        );
        const runId = task.runId;
        expect(runId).toBeDefined();
        const record =
            runId === undefined
                ? null
                : await readRunRecord(team.directory, runId);
        expect(record?.status).toBe("failed");
        expect(record?.reason).toBe("workflow_failed:fanout:2:all_errored");
    });

    test("linear workflow member error fails immediately without fanout tolerance", async () => {
        // Given: a linear workflow active member has errored.
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "linear work",
                    completed: false,
                },
            ],
            currentStageIndex: 0,
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                {
                    name: "alice",
                    sessionId: "ses_alice",
                    status: "errored",
                    error: "provider outage",
                },
            ],
        });
        const ctx = makeCtx({ outputs: {}, calls: calls });

        // When: termination evaluates the workflow.
        await checkTermination(ctx, team);

        // Then: the run fails through the normal member_error path.
        expect(team.status).toBe("failed");
        expect(team.activeTask).toBeUndefined();
        const leaderCall = calls.find((call) => call.sessionId === "ses_lead");
        expect(leaderCall?.text).toContain(
            "member_error:alice:provider outage",
        );
    });
});

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
        ctx = makeCtx({ outputs: { ses_bob: FAIL_VERDICT }, calls: calls });
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

        expect(task.steps![1].jumpCount).toBe(1);
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

        expect(task.steps![1].jumpCount).toBe(1);
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

        expect(task.steps![1].jumpCount).toBe(1);
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

        expect(task.steps![1].score).toBe(9);
        expect(task.steps![1].confidence).toBe(0.9);
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

        expect(task.steps![1].issues).toEqual([
            { severity: "high", message: "risk" },
        ]);
        expect(task.currentStageIndex).toBe(0);
        const aliceCall = calls.find((c) => c.sessionId === "ses_alice");
        expect(aliceCall).toBeDefined();
        expect(aliceCall!.text).toContain("when:has_issue_severity");
    });
});

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
        expect(task.steps![1].attempts).toBe(1); // counter still bumped
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
        expect(task.steps![1].invalidAttempts).toBe(1); // counter still bumped
        // bob NOT re-dispatched yet.
        expect(calls.some((c) => c.sessionId === "ses_bob")).toBe(false);
        // Timing was reset before the pause so the resumed dispatch measures only the new attempt.
        expect(task.steps![1].startedAt).toBeUndefined();
        expect(task.steps![1].dispatchedAt).toBeUndefined();
        expect(team.activeTask).toBeDefined();
    });
});

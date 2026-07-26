/**
 * Workflow handler execution tests (TDD RED→GREEN for Wave 2 T2).
 *
 * Mirrors the pipeline-exec.test.ts stub-ctx harness: makeCtx captures member
 * outputs and records promptAsync dispatches; makeTeam/buildWorkflowTask fixture
 * the state. Drives the handler via processIdle (the real idle entry point) so
 * identity validation (getExpectedMember), output capture, and dispatch all run.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { processIdle } from "../src/orchestration/lifecycle/idle.js";
import { checkTermination } from "../src/orchestration/lifecycle/termination.js";
import { advanceWorkflowStep } from "../src/orchestration/workflow/engine.js";
import { readRunEvents, readRunRecord } from "../src/orchestration/records/runs.js";
import type {
    MemberState,
    WorkflowFanoutStep,
    WorkflowJoinStep,
    WorkflowStep,
    WorkflowTask,
} from "../src/core/types.js";


import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js";
import { initTeamState, loadTeamState } from "../src/state/store.js";
import type { Team } from "../src/state/store.js"
import { teamWorkflowTool } from "../src/tools/workflow/engine.js";
import type { WorkflowToolStep } from "../src/core/types/workflow.js";
import type { PluginContext } from "../src/core/context.js";
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeTeam, makeToolContext, makeWorkflowTask, tmpRoot, type DispatchCall } from "./helpers.js";

function joinStepAt(steps: readonly WorkflowStep[] | undefined, index: number): WorkflowJoinStep {
    const step = steps?.[index];
    if (step?.kind !== "join") throw new Error(`Expected join step at index ${index}`);
    return step;
}

function fanoutStepAt(steps: readonly WorkflowStep[] | undefined, index: number): WorkflowFanoutStep {
    const step = steps?.[index];
    if (step?.kind !== "fanout") throw new Error(`Expected fanout step at index ${index}`);
    return step;
}

const trackedSessions: string[] = [];
afterEach(() => {
    for (const sid of trackedSessions.splice(0)) unindexSession(sid);
});
afterAll(cleanupTmpRoots);

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
const INVALID_VERDICT =
    '<verdict>{"result":"INVALID","rationale":"cannot run tests","diff":""}</verdict>';

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
    const root = tmpRoot("wf-tool-fanout");
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

        const joinStep = joinStepAt(task.steps, 5);
        expect(joinStep.completed).toBe(true);
        expect(joinStep.join.joinedOutput).toContain("api branch output");
        expect(joinStep.join.joinedOutput).toContain("api packaged output");
        expect(joinStep.join.joinedOutput).toContain("tests branch output");
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
        const joinStep = joinStepAt(task.steps, 5);
        const joinedOutput = joinStep.join.joinedOutput;

        await processIdle(
            ctx,
            team,
            findTeamMember(team, "carol"),
            "ses_carol",
        );
        await processIdle(ctx, team, findTeamMember(team, "bob"), "ses_bob");
        await processIdle(ctx, team, findTeamMember(team, "erin"), "ses_erin");

        expect(joinStep.completed).toBe(true);
        expect(joinStep.join.joinedOutput).toBe(joinedOutput);
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
        expect(fanoutStepAt(task.steps, 1).fanout.branchRanges).toEqual([
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
        const joinStep = joinStepAt(task.steps, 6);
        expect(joinStep.completed).toBe(true);
        expect(joinStep.join.joinedOutput).toContain("api branch output");
        expect(joinStep.join.joinedOutput).toContain("tests branch output");
        expect(joinStep.join.joinedOutput).not.toContain("PASS");
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
        const root = tmpRoot("wf-tool-reduce-fanout");
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
        const joinStep = joinStepAt(task.steps, 4);
        expect(joinStep.completed).toBe(true);
        expect(joinStep.join.joinedOutput).toBe("reduced branch summary");
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
        const joinStep = joinStepAt(task.steps, 6);
        expect(team.status).toBe("busy");
        expect(team.activeTask).toBeDefined();
        expect(task.steps?.[3]?.skipped).toBe(true);
        expect(joinStep.completed).toBe(true);
        expect(joinStep.join.survivorBranchIds).toEqual(["tests"]);
        expect(joinStep.join.erroredBranchIds).toEqual(["api"]);
        expect(joinStep.join.joinedOutput).toContain("tests branch output");
        expect(joinStep.join.joinedOutput).not.toContain("api branch output");
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
        const joinStep = joinStepAt(task.steps, 3);
        expect(joinStep.completed).toBe(true);
        expect(joinStep.join.joinedOutput).toContain(
            "api branch output",
        );
        expect(joinStep.join.joinedOutput).toContain(
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
        const joinStep = joinStepAt(task.steps, 5);
        expect(team.status).toBe("busy");
        expect(team.activeTask).toBeDefined();
        expect(joinStep.completed).toBe(true);
        expect(joinStep.join.survivorBranchIds).toEqual(["tests"]);
        expect(joinStep.join.erroredBranchIds).toEqual(["api"]);
        expect(joinStep.join.joinedOutput).toContain("tests branch output");
        expect(joinStep.join.joinedOutput).not.toContain("api branch output");
        expect(joinStep.join.joinedOutput).not.toContain(
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

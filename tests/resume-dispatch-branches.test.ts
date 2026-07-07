/**
 * Coverage-gap regression tests for resumeDispatch (src/tools/dispatch.ts) — the
 * 9-way per-mode re-dispatch switch used by team_resume Phase 3.
 *
 * GAP CLOSED: existing resume tests cover parallel, pipeline (advance), delegate,
 * recurse, route Phase-A-with-captured-router, arbitrate, tollgate, and the
 * signoff/reduce pre-checks. The following branches had NO direct test (verified
 * against the bun --coverage uncovered-line set for tools/dispatch.ts):
 *   - reduce sub-stage where the reducer ALREADY responded → handleReduceIdle
 *     (dispatch.ts:78-79)
 *   - consensus re-dispatch loop: round < maxRounds AND a member lacks a
 *     response → that member is re-dispatched (dispatch.ts:138-154)
 *   - pipeline/loop ALL-COMPLETE crash edge: currentStageIndex >= stages.length
 *     → deliver + clear (dispatch.ts:161-165)
 *   - loop mid-stage resume → advanceToStage (the loop half of the shared case)
 *   - route Phase A with NO captured router output → router re-dispatched
 *     (dispatch.ts:199-216)
 *   - route Phase B (routeStage set) → targets without responses re-dispatched
 *     (dispatch.ts:222-237)
 *
 * These drive resumeDispatch directly (mirrors resume-signoff-reduce.test.ts),
 * which is exactly what team_resume Phase 3 calls under the mutex.
 */
import { afterEach, describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask } from "../src/core/types.js"
import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { resumeDispatch } from "../src/tools/dispatch.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

function makeCtx(
    root: string,
    promptAsync: (req: { path: { id: string }; body: { parts: { text: string }[] } }) => Promise<void>,
): PluginContext {
    return {
        storageRoot: root,
        scope: "project",
        directory: "/app",
        client: {
            app: { log: mock(async () => {}) },
            session: {
                abort: mock(async () => {}),
                promptAsync: mock(promptAsync),
                messages: mock(async () => ({ data: [] })),
            },
        },
    } as unknown as PluginContext
}

function makeTask(overrides: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300_000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        ...overrides,
    } as ActiveTask
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

/** Commit a task as the active task on a freshly-loaded failed team, indexed. */
async function setup(
    root: string,
    sid: string,
    task: ActiveTask,
    members: ReturnType<typeof makeMember>[],
): Promise<ReturnType<typeof loadTeamState>> {
    const state = makeState("alpha", sid, members, Date.now())
    await initTeamState(root, state, sid)
    const team = await loadTeamState(root, "alpha", sid)
    await team.mutex.runExclusive(async () => {
        team.activeTask = task
        await saveTeamState(team)
    })
    await rebuildSessionIndex(root, `${root}__unused`)
    return team
}

describe("resumeDispatch: reduce sub-stage where reducer ALREADY responded", () => {
    test("reducer has a response → handleReduceIdle runs (NOT a re-dispatch)", async () => {
        const root = tmpRoot("rdb-reduce-responded")
        const sid = "ses_rdb_reduce"
        tracked.push(sid)
        // reduceStage set, reducer bob HAS produced output → the resume path must
        // re-drive handleReduceIdle to capture+continue, not re-dispatch bob.
        const task = makeTask({
            type: "parallel",
            reducePolicy: "merge",
            reducerMember: "bob",
            reduceStage: true,
            responses: { alice: "a", dave: "d", bob: "MERGED RESULT" },
        })
        const alice = makeMember("alice", "ses_alice")
        const bob = makeMember("bob", "ses_bob")
        const dave = makeMember("dave", "ses_dave")
        const team = await setup(root, sid, task, [alice, bob, dave])

        const dispatched: string[] = []
        const ctx = makeCtx(root, async req => { dispatched.push(req.path.id) })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        // handleReduceIdle captured the reducer's result and delivered to leader;
        // bob was NOT re-dispatched. The leader (sid) receives the summary.
        expect(dispatched).not.toContain("ses_bob")
        expect(team.activeTask).toBeUndefined()
        expect(team.status).toBe("idle")
    })
})

describe("resumeDispatch: consensus re-dispatch loop", () => {
    test("round < maxRounds + a member lacks a response → that member is re-dispatched", async () => {
        const root = tmpRoot("rdb-consensus-redispatch")
        const sid = "ses_rdb_consensus"
        tracked.push(sid)
        // currentRound (0) < maxRounds (2); alice answered, bob did not →
        // resume must re-dispatch ONLY bob with the consensus round prompt.
        const task = makeTask({
            type: "consensus",
            topic: "ship or wait",
            currentRound: 0,
            maxRounds: 2,
            responses: { alice: "agree" },
        })
        const alice = makeMember("alice", "ses_alice")
        const bob = makeMember("bob", "ses_bob")
        const team = await setup(root, sid, task, [alice, bob])

        const dispatched: { id: string; text: string }[] = []
        const ctx = makeCtx(root, async req => {
            dispatched.push({ id: req.path.id, text: req.body.parts[0].text })
        })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        // Only bob re-dispatched (alice already responded), carrying the consensus prompt.
        expect(dispatched.map(d => d.id)).toEqual(["ses_bob"])
        expect(dispatched[0].text).toContain("Consensus Round")
        expect(dispatched[0].text).toContain("ship or wait")
        // Run stays live (still collecting this round).
        expect(team.activeTask).toBeDefined()
    })
})

describe("resumeDispatch: pipeline/loop all-complete crash edge", () => {
    test("currentStageIndex >= stages.length → delivers + clears (no dispatch)", async () => {
        const root = tmpRoot("rdb-pipeline-allcomplete")
        const sid = "ses_rdb_pipe_done"
        tracked.push(sid)
        // Crash happened AFTER the last stage completed but BEFORE delivery:
        // currentStageIndex (2) == stages.length (2).
        const task = makeTask({
            type: "pipeline",
            stages: [
                { member: "alice", task: "s1", completed: true },
                { member: "bob", task: "s2", completed: true },
            ],
            currentStageIndex: 2,
            responses: { alice: "A", bob: "B" },
        })
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])

        const dispatched: string[] = []
        const ctx = makeCtx(root, async req => { dispatched.push(req.path.id) })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        // No member re-dispatched; only the leader receives the completion summary.
        expect(dispatched).toEqual([sid])
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
    })

    test("loop mid-stage resume → advanceToStage dispatches the current stage member", async () => {
        const root = tmpRoot("rdb-loop-midstage")
        const sid = "ses_rdb_loop_mid"
        tracked.push(sid)
        // Loop crashed at stage index 1 (bob's stage) within the round.
        const task = makeTask({
            type: "loop",
            stages: [
                { member: "alice", task: "code", completed: true },
                { member: "bob", task: "review", completed: false },
            ],
            currentStageIndex: 1,
            currentRound: 1,
            maxRounds: 3,
            deciderMember: "bob",
            responses: { alice: "ALICE_LOOP_OUTPUT" },
        })
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])

        const dispatched: { id: string; text: string }[] = []
        const ctx = makeCtx(root, async req => {
            dispatched.push({ id: req.path.id, text: req.body.parts[0].text })
        })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        // Only bob (current stage) is re-dispatched, with upstream context injected.
        expect(dispatched.map(d => d.id)).toEqual(["ses_bob"])
        expect(dispatched[0].text).toContain("review")
        expect(dispatched[0].text).toContain("ALICE_LOOP_OUTPUT")
        expect(team.activeTask).toBeDefined()
    })
})

describe("resumeDispatch: route Phase A with NO captured router output", () => {
    test("router has no response → the router is re-dispatched (not a target)", async () => {
        const root = tmpRoot("rdb-route-router")
        const sid = "ses_rdb_route_router"
        tracked.push(sid)
        // routeStage not set, router has produced nothing yet → re-dispatch router.
        const task = makeTask({
            type: "route",
            routerMember: "router",
            routeStage: false,
            task: "classify this ticket",
            routeBranches: [
                { name: "sales", member: "alice" },
                { name: "support", member: "bob" },
            ],
            responses: {},
        })
        const team = await setup(root, sid, task, [
            makeMember("router", "ses_router"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])

        const dispatched: { id: string; text: string }[] = []
        const ctx = makeCtx(root, async req => {
            dispatched.push({ id: req.path.id, text: req.body.parts[0].text })
        })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        // Only the router is re-dispatched with the routing prompt; no targets yet.
        expect(dispatched.map(d => d.id)).toEqual(["ses_router"])
        expect(dispatched[0].text).toContain("classify this ticket")
        expect(team.activeTask).toBeDefined()
    })
})

describe("resumeDispatch: route Phase B target re-dispatch", () => {
    test("routeStage set + a target lacks a response → only that target is re-dispatched", async () => {
        const root = tmpRoot("rdb-route-targets")
        const sid = "ses_rdb_route_targets"
        tracked.push(sid)
        // Phase B: router decided (routeStage=true, targets alice+bob). alice
        // responded pre-crash; bob did not → re-dispatch only bob.
        const task = makeTask({
            type: "route",
            routerMember: "router",
            routeStage: true,
            routeTargets: ["alice", "bob"],
            task: "the routed input",
            routeBranches: [
                { name: "sales", member: "alice", task: "handle sale" },
                { name: "support", member: "bob", task: "handle support" },
            ],
            responses: { router: '<route>{"branches":["sales","support"]}</route>', alice: "alice-done" },
        })
        const team = await setup(root, sid, task, [
            makeMember("router", "ses_router"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])

        const dispatched: { id: string; text: string }[] = []
        const ctx = makeCtx(root, async req => {
            dispatched.push({ id: req.path.id, text: req.body.parts[0].text })
        })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        // Only bob (no response) is re-dispatched with his branch task; alice is skipped.
        expect(dispatched.map(d => d.id)).toEqual(["ses_bob"])
        expect(dispatched[0].text).toBe("handle support")
        expect(team.activeTask).toBeDefined()
    })

    test("routeStage set + ALL targets responded → barrier re-driven (delivers, no re-dispatch)", async () => {
        const root = tmpRoot("rdb-route-barrier")
        const sid = "ses_rdb_route_barrier"
        tracked.push(sid)
        // Phase B zero-dispatch: both targets already responded → handleRouteIdle
        // re-drives the barrier and delivers.
        const task = makeTask({
            type: "route",
            routerMember: "router",
            routeStage: true,
            routeTargets: ["alice", "bob"],
            task: "the routed input",
            routeBranches: [
                { name: "sales", member: "alice" },
                { name: "support", member: "bob" },
            ],
            responses: { router: '<route>{"branches":["sales","support"]}</route>', alice: "A", bob: "B" },
        })
        const team = await setup(root, sid, task, [
            { ...makeMember("router", "ses_router"), status: "idle" },
            { ...makeMember("alice", "ses_alice"), status: "idle" },
            { ...makeMember("bob", "ses_bob"), status: "idle" },
        ])

        const dispatched: string[] = []
        const ctx = makeCtx(root, async req => { dispatched.push(req.path.id) })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        // No target re-dispatched; only the leader receives the route_complete summary.
        expect(dispatched).toEqual([sid])
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
    })
})

describe("resumeDispatch: workflow all-complete crash edge", () => {
    test("all steps completed pre-crash -> delivers + clears (no re-dispatch)", async () => {
        const root = tmpRoot("rdb-wf-allcomplete")
        const sid = "ses_rdb_wf_done"
        tracked.push(sid)
        // Crash happened AFTER the last step completed but BEFORE delivery:
        // every step completed; currentStageIndex is past the end.
        const task = makeTask({
            type: "workflow",
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true },
                { kind: "gate", verifier: "bob", criteria: "ok", onFail: "fail", maxRetries: 0, attempts: 0, completed: true, verdict: "PASS" },
            ],
            currentStageIndex: 2,
            responses: { alice: "A", bob: '<verdict>{"result":"PASS","rationale":"","diff":""}</verdict>' },
        })
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])

        const dispatched: string[] = []
        const ctx = makeCtx(root, async req => { dispatched.push(req.path.id) })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        // No member re-dispatched; only the leader receives workflow_complete.
        expect(dispatched).toEqual([sid])
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
    })
})

describe("resumeDispatch: workflow mid-task-step crash", () => {
    test("current task step's actor has no response -> re-dispatched with its task", async () => {
        const root = tmpRoot("rdb-wf-midtask")
        const sid = "ses_rdb_wf_midtask"
        tracked.push(sid)
        // Crashed at step 0 (alice's task), alice has produced nothing yet.
        const task = makeTask({
            type: "workflow",
            steps: [
                { kind: "task", member: "alice", task: "draft the design", completed: false },
                { kind: "gate", verifier: "bob", criteria: "ok", onFail: "fail", maxRetries: 0, attempts: 0, completed: false },
            ],
            currentStageIndex: 0,
            responses: {},
        })
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])

        const dispatched: { id: string; text: string }[] = []
        const ctx = makeCtx(root, async req => {
            dispatched.push({ id: req.path.id, text: req.body.parts[0].text })
        })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        expect(dispatched.map(d => d.id)).toEqual(["ses_alice"])
        expect(dispatched[0].text).toContain("draft the design")
        expect(team.activeTask).toBeDefined()
    })

    test("current task actor already responded -> handler re-run and advances", async () => {
        const root = tmpRoot("rdb-wf-midtask-captured")
        const sid = "ses_rdb_wf_midtask_captured"
        tracked.push(sid)
        const task = makeTask({
            type: "workflow",
            steps: [
                { kind: "task", member: "alice", task: "draft the design", completed: false },
                { kind: "task", member: "bob", task: "polish", completed: false },
            ],
            currentStageIndex: 0,
            responses: { alice: "captured draft" },
        })
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])

        const dispatched: { id: string; text: string }[] = []
        const ctx = makeCtx(root, async req => {
            dispatched.push({ id: req.path.id, text: req.body.parts[0].text })
        })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        if (task.type !== "workflow") throw new Error("expected workflow task")
        expect(task.steps?.[0].completed).toBe(true)
        expect(task.steps?.[0].output).toBe("captured draft")
        expect(dispatched.map(d => d.id)).toEqual(["ses_bob"])
        expect(dispatched[0].text).toContain("polish")
    })
})

describe("resumeDispatch: workflow mid-gate-step crash with captured verdict", () => {
    test("current gate's verifier already responded -> handler re-run (delivers, no re-dispatch)", async () => {
        const root = tmpRoot("rdb-wf-midgate")
        const sid = "ses_rdb_wf_midgate"
        tracked.push(sid)
        // Crashed at the gate (step 1) AFTER bob rendered a PASS verdict but
        // before the handler processed it: bob's response is captured.
        const passVerdict = '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>'
        const task = makeTask({
            type: "workflow",
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true },
                { kind: "gate", verifier: "bob", criteria: "ok", onFail: "fail", maxRetries: 0, attempts: 0, completed: false },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice's work", bob: passVerdict },
        })
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])

        const dispatched: string[] = []
        const ctx = makeCtx(root, async req => { dispatched.push(req.path.id) })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        // The captured PASS verdict is processed (no re-dispatch of bob); the
        // leader receives workflow_complete.
        expect(dispatched).toEqual([sid])
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
    })

    test("multi-target gate with captured PASS resumes and dispatches the next step", async () => {
        const root = tmpRoot("rdb-wf-midgate-targets")
        const sid = "ses_rdb_wf_midgate_targets"
        tracked.push(sid)
        const passVerdict = '<verdict>{"result":"PASS","rationale":"all match","diff":""}</verdict>'
        const task = makeTask({
            type: "workflow",
            steps: [
                { kind: "task", member: "alice", task: "api", completed: true, output: "api output" },
                { kind: "task", member: "carol", task: "tests", completed: true, output: "tests output" },
                { kind: "gate", verifier: "bob", criteria: "consistent", targetStepIndices: [0, 1], onFail: "fail", maxRetries: 0, attempts: 0, completed: false },
                { kind: "task", member: "dave", task: "publish", completed: false },
            ],
            currentStageIndex: 2,
            responses: { alice: "api output", carol: "tests output", bob: passVerdict },
        })
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
            makeMember("carol", "ses_carol"),
            makeMember("dave", "ses_dave"),
        ])

        const dispatched: { id: string; text: string }[] = []
        const ctx = makeCtx(root, async req => {
            dispatched.push({ id: req.path.id, text: req.body.parts[0].text })
        })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        expect(dispatched.map(d => d.id)).toEqual(["ses_dave"])
        expect(dispatched[0].text).toContain("publish")
        expect(dispatched[0].text).toContain("api output")
        expect(dispatched[0].text).toContain("tests output")
        expect(team.activeTask).toBeDefined()
    })
})

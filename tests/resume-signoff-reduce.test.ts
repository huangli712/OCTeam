/**
 * Regression tests for the resumeDispatch signoff/reduce sub-stage recovery
 * (P1-1 fix).
 *
 * Root cause: resumeDispatch (tools/dispatch.ts) only switched on task.type,
 * without the priority checks for signoffStage / reduceStage that processIdle
 * has (handlers.ts:176-186). A crash exactly during a signoff or reduce stage
 * left the task with signoffStage=true but reviewers idle (errored→idle on
 * resume). On team_resume, the type-switch treated it as parallel map work,
 * saw all responses present, re-drove the barrier — which short-circuited on
 * signoffStage without re-dispatching the reviewers. The run stalled to
 * wall-clock timeout.
 *
 * Fix (tools/dispatch.ts resumeDispatch): BEFORE the switch(task.type), check
 * reduceStage / signoffStage and re-dispatch the reducer / reviewers using the
 * same idempotent entry points the live path uses, then bail.
 *
 * These tests reproduce the scenario: an interrupted parallel task with
 * signoffStage (or reduceStage) set, all map responses present, decider idle.
 * resumeDispatch must re-dispatch the decider/reducer, not the mappers.
 */

import { afterEach, describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask } from "../src/core/types.js"
import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { resumeDispatch } from "../src/tools/dispatch.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

// --- helpers ---

function makeCtx(
    root: string,
    promptAsync: (req: unknown) => Promise<void>,
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

describe("resumeDispatch signoff/reduce sub-stage recovery (P1-1)", () => {
    test("signoffStage set + decider not yet responded → decider is re-dispatched (mappers are NOT)", async () => {
        const root = tmpRoot("rd-sig")
        const sid = "ses_rd_sig"
        tracked.push(sid)

        // Parallel task that crashed DURING the signoff stage:
        // - all map responses present (alice + bob did their work)
        // - signoffStage=true (maybeTriggerSignoff had fired pre-crash)
        // - decider carol has NO response (was dispatched, crashed mid-review)
        // - signoffApprovals is empty (no reviewer has responded yet)
        const task = makeTask({
            responses: { alice: "alice-result", bob: "bob-result" },
            signoffPolicy: "decider",
            signoffDecider: "carol",
            signoffStage: true,
            signoffApprovals: {},
        })

        const alice = makeMember("alice", "ses_alice")
        const bob = makeMember("bob", "ses_bob")
        const carol = makeMember("carol", "ses_carol")
        // All members idle (resume resets errored→idle; everyone was idle at crash).
        alice.status = "idle"
        bob.status = "idle"
        carol.status = "idle"

        const state = makeState("alpha", sid, [alice, bob, carol], Date.now())
        await initTeamState(root, state, sid)
        const team = await loadTeamState(root, "alpha", sid)
        await team.mutex.runExclusive(async () => {
            team.activeTask = task
            await saveTeamState(team)
        })
        await rebuildSessionIndex(root, `${root}__unused`)

        const dispatched: string[] = []
        const ctx = makeCtx(root, async (req: any) => {
            dispatched.push(req.path.id)
        })

        // Drive resumeDispatch directly (mirrors what team_resume Phase 3 calls).
        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        // ONLY the decider (carol) is re-dispatched with the signoff review
        // prompt. Mappers alice/bob are NOT re-dispatched — their work is
        // already captured. Without the P1-1 fix, resumeDispatch would skip
        // them all (responses present), call handleParallelIdle (barrier),
        // which short-circuits on signoffStage without dispatching carol →
        // the run would stall to wall-clock.
        expect(dispatched).toEqual(["ses_carol"])
    })

    test("signoffStage set + decider already responded → decider NOT re-dispatched (idempotent)", async () => {
        const root = tmpRoot("rd-sig-idem")
        const sid = "ses_rd_sig_idem"
        tracked.push(sid)

        // Decider carol already recorded an approval pre-crash.
        const task = makeTask({
            responses: { alice: "a", bob: "b", carol: "<signoff>{\"approved\": true}</signoff>" },
            signoffPolicy: "decider",
            signoffDecider: "carol",
            signoffStage: true,
            signoffApprovals: { carol: true },
        })

        const alice = makeMember("alice", "ses_alice")
        const bob = makeMember("bob", "ses_bob")
        const carol = makeMember("carol", "ses_carol")
        const state = makeState("alpha", sid, [alice, bob, carol], Date.now())
        await initTeamState(root, state, sid)
        const team = await loadTeamState(root, "alpha", sid)
        await team.mutex.runExclusive(async () => {
            team.activeTask = task
            await saveTeamState(team)
        })
        await rebuildSessionIndex(root, `${root}__unused`)

        const dispatched: string[] = []
        const ctx = makeCtx(root, async (req: any) => {
            dispatched.push(req.path.id)
        })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        // Carol already has an approval recorded → she is NOT re-dispatched.
        // (The caller's checkTermination / sweep eventually re-drives
        // handleSignoffIdle to capture the already-recorded verdict.)
        expect(dispatched).toEqual([])
    })

    test("peer-quorum signoffStage + 1 of 2 reviewers responded → only the missing reviewer is dispatched", async () => {
        const root = tmpRoot("rd-pq")
        const sid = "ses_rd_pq"
        tracked.push(sid)

        const task = makeTask({
            responses: { alice: "a-signoff", bob: "b-signoff", carol: "c" },
            signoffPolicy: "peer-quorum",
            signoffQuorum: 0.5,
            signoffStage: true,
            // alice responded, bob did not:
            signoffApprovals: { alice: true },
        })

        const alice = makeMember("alice", "ses_alice")
        const bob = makeMember("bob", "ses_bob")
        const carol = makeMember("carol", "ses_carol")
        const state = makeState("alpha", sid, [alice, bob, carol], Date.now())
        await initTeamState(root, state, sid)
        const team = await loadTeamState(root, "alpha", sid)
        await team.mutex.runExclusive(async () => {
            team.activeTask = task
            await saveTeamState(team)
        })
        await rebuildSessionIndex(root, `${root}__unused`)

        const dispatched: string[] = []
        const ctx = makeCtx(root, async (req: any) => {
            dispatched.push(req.path.id)
        })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        // Only bob (no approval) and carol (no approval) are re-dispatched.
        // alice (already recorded approval) is skipped.
        // Order follows team.members declaration: bob before carol.
        expect(dispatched).toEqual(["ses_bob", "ses_carol"])
    })

    test("reduceStage set + reducer has no response → reducer is re-dispatched (mappers are NOT)", async () => {
        const root = tmpRoot("rd-red")
        const sid = "ses_rd_red"
        tracked.push(sid)

        // Parallel task that crashed DURING the reduce stage:
        // - all map responses present
        // - reduceStage=true (maybeTriggerReduce had fired pre-crash)
        // - reducer bob has NO response (crashed mid-reduce)
        const task = makeTask({
            responses: { alice: "alice-result", dave: "dave-result" },
            reducePolicy: "merge",
            reducerMember: "bob",
            reduceStage: true,
        })

        const alice = makeMember("alice", "ses_alice")
        const bob = makeMember("bob", "ses_bob")
        const dave = makeMember("dave", "ses_dave")
        alice.status = "idle"
        bob.status = "idle"
        dave.status = "idle"

        const state = makeState("alpha", sid, [alice, bob, dave], Date.now())
        await initTeamState(root, state, sid)
        const team = await loadTeamState(root, "alpha", sid)
        await team.mutex.runExclusive(async () => {
            team.activeTask = task
            await saveTeamState(team)
        })
        await rebuildSessionIndex(root, `${root}__unused`)

        const dispatched: string[] = []
        const ctx = makeCtx(root, async (req: any) => {
            dispatched.push(req.path.id)
        })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        // ONLY the reducer (bob) is re-dispatched. Mappers alice/dave are NOT.
        expect(dispatched).toEqual(["ses_bob"])
    })

    test("non-signoff/non-reduce parallel task → existing behavior preserved (incomplete mappers dispatched)", async () => {
        const root = tmpRoot("rd-baseline")
        const sid = "ses_rd_base"
        tracked.push(sid)

        // Plain parallel task, no signoff/reduce. alice has responded, bob has not.
        const task = makeTask({
            responses: { alice: "done" },
        })

        const alice = makeMember("alice", "ses_alice")
        const bob = makeMember("bob", "ses_bob")
        const state = makeState("alpha", sid, [alice, bob], Date.now())
        await initTeamState(root, state, sid)
        const team = await loadTeamState(root, "alpha", sid)
        await team.mutex.runExclusive(async () => {
            team.activeTask = task
            await saveTeamState(team)
        })
        await rebuildSessionIndex(root, `${root}__unused`)

        const dispatched: string[] = []
        const ctx = makeCtx(root, async (req: any) => {
            dispatched.push(req.path.id)
        })

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!)
        })

        // Bob (no response) is dispatched; alice (has response) is skipped.
        // Verifies the P1-1 signoff/reduce pre-check did not regress the
        // normal map-recovery path.
        expect(dispatched).toEqual(["ses_bob"])
    })
})

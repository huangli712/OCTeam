import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { ActiveTask } from "../src/core/types.js"
import { teamConsensusTool } from "../src/tools/modes/consensus.js"
import { teamDelegateTool } from "../src/tools/modes/delegate.js"
import { teamLoopTool } from "../src/tools/modes/loop.js"
import { teamParallelTool } from "../src/tools/modes/parallel.js"
import { teamPipelineTool } from "../src/tools/modes/pipeline.js"
import { teamWorkflowTool } from "../src/tools/workflow/engine.js"
import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { makeCtx, makeMember, makeState, makeToolContext, tmpRoot, type DispatchCall } from "./helpers.js"


const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

async function setupTeam(
    root: string, sid: string,
    members = [makeMember("alice"), makeMember("bob")],
    activatedAt?: number,
): Promise<void> {
    await initTeamState(root, makeState("alpha", sid, members, activatedAt), sid)
    await rebuildSessionIndex(root, `${root}__unused`)
}

/** Make the team busy so Phase 1 rejects any new orchestration. */
async function setBusy(root: string, sid: string, type: string): Promise<void> {
    const team = await loadTeamState(root, "alpha", sid)
    await team.mutex.runExclusive(async () => {
        team.status = "busy"
        team.activeTask = {
            type,
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
        } as ActiveTask
        await saveTeamState(team)
    })
}

// -----------------------------------------------------------------------
// Shared startup validation: non-master / inactive / busy / signoff_decider
// -----------------------------------------------------------------------

type TeamToolFn = typeof teamParallelTool

interface StartupFixture {
    name: string
    tool: TeamToolFn
    prefix: string
    busyType: string
    validArgs: Record<string, unknown>
    signoff?: boolean
}

const startupFixtures: StartupFixture[] = [
    {
        name: "team_parallel",
        tool: teamParallelTool,
        prefix: "par",
        busyType: "parallel",
        validArgs: { team_id: "alpha", mode: "isolated", task: "do x" },
        signoff: true,
    },
    {
        name: "team_consensus",
        tool: teamConsensusTool,
        prefix: "con",
        busyType: "consensus",
        validArgs: { team_id: "alpha", topic: "use sqlite?" },
    },
    {
        name: "team_pipeline",
        tool: teamPipelineTool,
        prefix: "pip",
        busyType: "pipeline",
        validArgs: { team_id: "alpha", stages: [{ member: "alice", task: "do x" }] },
        signoff: true,
    },
    {
        name: "team_workflow",
        tool: teamWorkflowTool,
        prefix: "wf",
        busyType: "workflow",
        validArgs: { team_id: "alpha", steps: [{ kind: "task", member: "alice", task: "do x" }] },
        signoff: true,
    },
    {
        name: "team_loop",
        tool: teamLoopTool,
        prefix: "loop",
        busyType: "loop",
        validArgs: { team_id: "alpha", stages: [{ member: "alice", task: "code" }], decider: "alice", max_rounds: 3, initial_task: "start" },
    },
    {
        name: "team_delegate",
        tool: teamDelegateTool,
        prefix: "del",
        busyType: "delegate",
        validArgs: { team_id: "alpha", tasks: [{ subject: "t1", description: "d" }] },
        signoff: true,
    },
]

for (const fx of startupFixtures) {
    describe(`${fx.name} startup validation`, () => {
        test("non-master → rejected", async () => {
            const root = tmpRoot(`${fx.prefix}-nomaster`)
            const masterSid = `ses_${fx.prefix}_m`
            const memberSid = `ses_${fx.prefix}_a`
            tracked.push(masterSid, memberSid)
            await setupTeam(root, masterSid, [makeMember("alice", memberSid)], Date.now())
            const result = await fx.tool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
                fx.validArgs,
                makeToolContext(memberSid),
            )
            expect(result).toContain("master-only")
        })

        test("inactive team → rejected", async () => {
            const root = tmpRoot(`${fx.prefix}-inactive`)
            const sid = `ses_${fx.prefix}_inact`
            tracked.push(sid)
            await setupTeam(root, sid, undefined, undefined)
            const result = await fx.tool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
                fx.validArgs,
                makeToolContext(sid),
            )
            expect(result).toContain("Error")
        })

        test("already busy → rejected", async () => {
            const root = tmpRoot(`${fx.prefix}-busy`)
            const sid = `ses_${fx.prefix}_busy`
            tracked.push(sid)
            await setupTeam(root, sid, undefined, Date.now())
            await setBusy(root, sid, fx.busyType)
            const result = await fx.tool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
                fx.validArgs,
                makeToolContext(sid),
            )
            expect(result).toContain("already has an active orchestration")
        })

        if (fx.signoff) {
            test("signoff_decider not a member → rejected", async () => {
                const root = tmpRoot(`${fx.prefix}-sd`)
                const sid = `ses_${fx.prefix}_sd`
                tracked.push(sid)
                await setupTeam(root, sid, [makeMember("alice")], Date.now())
                const result = await fx.tool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
                    { ...fx.validArgs, signoff_policy: "decider", signoff_decider: "bob" },
                    makeToolContext(sid),
                )
                expect(result).toContain("not a member")
            })
        }
    })
}

// -----------------------------------------------------------------------
// team_parallel — type-specific validations
// -----------------------------------------------------------------------
describe("team_parallel type-specific validation", () => {
    test("isolated without task → rejected", async () => {
        const root = tmpRoot("par-notask")
        const sid = "ses_par_notask"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        const result = await teamParallelTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", mode: "isolated" },
            makeToolContext(sid),
        )
        expect(result).toContain("requires `task`")
    })

    test("cooperative without tasks → rejected", async () => {
        const root = tmpRoot("par-notasks")
        const sid = "ses_par_notasks"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        const result = await teamParallelTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", mode: "cooperative" },
            makeToolContext(sid),
        )
        expect(result).toContain("requires `tasks`")
    })

    test("reduce_policy 'select' without reducer_member → rejected", async () => {
        const root = tmpRoot("par-sel-nored")
        const sid = "ses_par_sel_nr"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamParallelTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", mode: "isolated", task: "do x", reduce_policy: "select" },
            makeToolContext(sid),
        )
        expect(result).toContain("requires reducer_member")
    })

    test("reduce_policy 'merge' without reducer_member → rejected", async () => {
        const root = tmpRoot("par-merge-nored")
        const sid = "ses_par_merge_nr"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamParallelTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", mode: "isolated", task: "do x", reduce_policy: "merge" },
            makeToolContext(sid),
        )
        expect(result).toContain("requires reducer_member")
    })

    test("reduce_policy 'rubric' with reduce_rubric but no reducer_member → rejected", async () => {
        const root = tmpRoot("par-rub-nored")
        const sid = "ses_par_rub_nr"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamParallelTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", mode: "isolated", task: "do x", reduce_policy: "rubric", reduce_rubric: "correctness" },
            makeToolContext(sid),
        )
        expect(result).toContain("requires reducer_member")
    })
})

// -----------------------------------------------------------------------
// team_pipeline — type-specific validations
// -----------------------------------------------------------------------
describe("team_pipeline type-specific validation", () => {
    test("unknown stage member → rejected", async () => {
        const root = tmpRoot("pip-unknown")
        const sid = "ses_pip_unk"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamPipelineTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", stages: [{ member: "bob", task: "do x" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("unknown member")
    })

    test("duplicate stage member → rejected", async () => {
        const root = tmpRoot("pip-dup")
        const sid = "ses_pip_dup"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamPipelineTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "a" }, { member: "alice", task: "b" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("unique")
    })
})

// -----------------------------------------------------------------------
// team_workflow — type-specific validations
// -----------------------------------------------------------------------
describe("team_workflow type-specific validation", () => {
    test("empty steps -> rejected", async () => {
        const root = tmpRoot("wf-empty")
        const sid = "ses_wf_empty"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", steps: [] },
            makeToolContext(sid),
        )
        expect(result).toContain("steps")
    })

    test("task step missing member -> rejected", async () => {
        const root = tmpRoot("wf-nomember")
        const sid = "ses_wf_nm"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", steps: [{ kind: "task", task: "do x" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("requires `member`")
    })

    test("unknown task member -> rejected", async () => {
        const root = tmpRoot("wf-unknown")
        const sid = "ses_wf_unk"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", steps: [{ kind: "task", member: "bob", task: "do x" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("unknown member")
    })

    test("task fallback_member must be a team member", async () => {
        // Given: a task declares an unknown fallback actor.
        const root = tmpRoot("wf-fallback-unknown")
        const sid = "ses_wf_fallback_unknown"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())

        // When: the workflow is validated.
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", steps: [{ kind: "task", member: "alice", fallback_member: "bob", task: "do x" }] },
            makeToolContext(sid),
        )

        // Then: the unknown fallback is rejected before dispatch.
        expect(result).toContain("fallback_member")
        expect(result).toContain("not a team member")
    })

    test("gate fallback_verifier must not self-verify any target", async () => {
        // Given: a gate fallback verifier matches one of two target task members.
        const root = tmpRoot("wf-fallback-selfverify")
        const sid = "ses_wf_fallback_selfverify"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())

        // When: the workflow is validated.
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "api" },
                    { kind: "task", member: "carol", task: "tests" },
                    { kind: "gate", verifier: "bob", fallback_verifier: "carol", targets: [1, 2], criteria: "both ok" },
                ],
            },
            makeToolContext(sid),
        )

        // Then: fallback self-verification is rejected against every target.
        expect(result).toContain("fallback_verifier")
        expect(result).toContain("target step 2")
        expect(result).toContain("self-verification")
    })

    test("gate verifier must not self-verify a target fallback_member", async () => {
        // Given: a task fallback actor could become the actual producer at runtime.
        const root = tmpRoot("wf-fallback-target-selfverify")
        const sid = "ses_wf_fallback_target_selfverify"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())

        // When: the gate verifier matches the target task fallback actor.
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", fallback_member: "bob", task: "produce" },
                    { kind: "gate", verifier: "bob", target_step: 1, criteria: "review output" },
                ],
            },
            makeToolContext(sid),
        )

        // Then: the workflow is rejected before runtime can self-verify.
        expect(result).toContain("verifier")
        expect(result).toContain("fallback_member")
        expect(result).toContain("self-verification")
    })

    test("initial task dispatch uses fallback_member when the primary actor has no live session", async () => {
        // Given: the first task's primary member is errored but its fallback is live.
        const root = tmpRoot("wf-fallback-runtime")
        const sid = "ses_wf_fallback_runtime"
        const aliceSid = "ses_wf_fallback_runtime_alice"
        const bobSid = "ses_wf_fallback_runtime_bob"
        tracked.push(sid, aliceSid, bobSid)
        await setupTeam(root, sid, [{ ...makeMember("alice", aliceSid), status: "errored" }, makeMember("bob", bobSid)], Date.now())
        const calls: DispatchCall[] = []

        // When: the workflow starts.
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: calls })).execute(
            { team_id: "alpha", steps: [{ kind: "task", member: "alice", fallback_member: "bob", task: "do x" }] },
            makeToolContext(sid),
        )

        // Then: the task is dispatched to the fallback session.
        expect(result).toContain("team_workflow started")
        expect(calls).toContainEqual({ sessionId: bobSid, text: "do x" })
    })

    test("gate-first (no preceding task) -> rejected", async () => {
        const root = tmpRoot("wf-gatefirst")
        const sid = "ses_wf_gf"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", steps: [{ kind: "gate", verifier: "bob", criteria: "ok" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("no preceding task")
    })

    test("fanout-first starts workflow and dispatches branch heads", async () => {
        const root = tmpRoot("wf-fanoutfirst")
        const sid = "ses_wf_ff"
        const aliceSid = "ses_wf_ff_alice"
        const bobSid = "ses_wf_ff_bob"
        const erinSid = "ses_wf_ff_erin"
        tracked.push(sid, aliceSid, bobSid, erinSid)
        await setupTeam(
            root,
            sid,
            [
                makeMember("alice", aliceSid),
                makeMember("bob", bobSid),
                makeMember("erin", erinSid),
            ],
            Date.now(),
        )
        const calls: DispatchCall[] = []

        const result = await teamWorkflowTool(
            makeCtx({ storageRoot: root, directory: root, calls }),
        ).execute(
            {
                team_id: "alpha",
                steps: [
                    {
                        kind: "fanout",
                        join_policy: "all",
                        branches: [
                            {
                                id: "a",
                                steps: [{ kind: "task", member: "alice", task: "do a" }],
                            },
                            {
                                id: "b",
                                steps: [{ kind: "task", member: "bob", task: "do b" }],
                            },
                        ],
                    },
                    { kind: "join" },
                    {
                        kind: "gate",
                        verifier: "erin",
                        criteria: "both branches passed",
                        target_step: 2,
                    },
                ],
            },
            makeToolContext(sid),
        )

        // Workflow started successfully (fanout as step 1 no longer rejected).
        expect(result).toContain("team_workflow started")
        // Both branch heads were dispatched in parallel.
        expect(calls).toContainEqual({ sessionId: aliceSid, text: "do a" })
        expect(calls).toContainEqual({ sessionId: bobSid, text: "do b" })
    })

    test("gate-first still rejected at gate validation (post step[0] removal)", async () => {
        const root = tmpRoot("wf-gatefirst2")
        const sid = "ses_wf_gf2"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", steps: [{ kind: "gate", verifier: "bob", criteria: "ok" }] },
            makeToolContext(sid),
        )
        // Gate-first is now caught by resolveAndValidateGateTargets (line 622)
        // rather than the removed step[0] check, but the error substring is preserved.
        expect(result).toContain("no preceding task")
    })

    test("join-first rejected (no matching fanout)", async () => {
        const root = tmpRoot("wf-joinfirst")
        const sid = "ses_wf_jf"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", steps: [{ kind: "join" }, { kind: "task", member: "alice", task: "do x" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("no matching fanout")
    })

    test("fanout-first without following join rejected", async () => {
        const root = tmpRoot("wf-fanoutnojoin")
        const sid = "ses_wf_fnj"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    {
                        kind: "fanout",
                        join_policy: "all",
                        branches: [
                            { id: "a", steps: [{ kind: "task", member: "alice", task: "do a" }] },
                        ],
                    },
                    // Missing: { kind: "join" }
                    { kind: "task", member: "bob", task: "after" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("must be followed by a join step")
    })

    test("fanout-first with no live branch member session fails the run", async () => {
        const root = tmpRoot("wf-fanoutrollback")
        const sid = "ses_wf_fr"
        const aliceSid = "ses_wf_fr_alice"
        tracked.push(sid, aliceSid)
        // alice has no live session (status: errored).
        await setupTeam(
            root,
            sid,
            [{ ...makeMember("alice", aliceSid), status: "errored" }],
            Date.now(),
        )

        await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    {
                        kind: "fanout",
                        join_policy: "all",
                        branches: [
                            { id: "a", steps: [{ kind: "task", member: "alice", task: "do a" }] },
                        ],
                    },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )
        // Branch head dispatch fails -> handleWorkflowDispatchUnavailable -> finishRun("failed").
        // The run is recorded as failed.
        const team = await loadTeamState(root, "alpha", sid)
        expect(team.status).toBe("failed")
    })

    test("task step with gate-only fields -> rejected", async () => {
        const root = tmpRoot("wf-task-gate-field")
        const sid = "ses_wf_tgf"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", steps: [{ kind: "task", member: "alice", task: "do x", verifier: "bob" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("must not set gate fields")
    })

    test("gate step with task-only fields -> rejected", async () => {
        const root = tmpRoot("wf-gate-task-field")
        const sid = "ses_wf_gtf"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "do x" },
                    { kind: "gate", verifier: "bob", criteria: "ok", member: "alice" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("must not set task fields")
    })

    test("gate self-verification (verifier == preceding task member) -> rejected", async () => {
        const root = tmpRoot("wf-selfverify")
        const sid = "ses_wf_sv"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", steps: [{ kind: "task", member: "alice", task: "do x" }, { kind: "gate", verifier: "alice", criteria: "ok" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("self-verification")
    })

    test("target_step self-verification -> rejected against target member", async () => {
        const root = tmpRoot("wf-target-selfverify")
        const sid = "ses_wf_tsv"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "task", member: "bob", task: "polish" },
                    { kind: "gate", verifier: "alice", target_step: 1, criteria: "check draft" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("target step 1")
        expect(result).toContain("self-verification")
    })

    test("target_step must reference a previous task step", async () => {
        const root = tmpRoot("wf-target-bad")
        const sid = "ses_wf_tb"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "gate", verifier: "bob", criteria: "check draft" },
                    { kind: "gate", verifier: "bob", target_step: 2, criteria: "check gate" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("must reference a previous task step")
    })

    test("duplicate step id -> rejected", async () => {
        const root = tmpRoot("wf-dup-id")
        const sid = "ses_wf_dup"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", id: "draft", member: "alice", task: "draft" },
                    { kind: "task", id: "draft", member: "alice", task: "again" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("duplicate step id")
        expect(result).toContain("draft")
    })

    test("target_step resolves a string id to a previous task", async () => {
        const root = tmpRoot("wf-target-id")
        const sid = "ses_wf_tid"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", id: "design", member: "alice", task: "draft design" },
                    { kind: "task", member: "carol", task: "add tests" },
                    { kind: "gate", verifier: "bob", target_step: "design", criteria: "design ok", on_fail: "retry", max_retries: 1 },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("verifies step 1 (design)")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.activeTask).toBeUndefined()
    })

    test("targets resolves multiple previous task ids in dry_run", async () => {
        const root = tmpRoot("wf-targets-id")
        const sid = "ses_wf_targets"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol"), makeMember("dave")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", id: "api", member: "alice", task: "build api" },
                    { kind: "task", id: "tests", member: "carol", task: "write tests" },
                    { kind: "task", id: "docs", member: "dave", task: "write docs" },
                    { kind: "gate", verifier: "bob", targets: ["api", "tests", "docs"], criteria: "all consistent" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("verifies steps 1 (api), 2 (tests), 3 (docs)")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.activeTask).toBeUndefined()
    })

    test("targets cannot be combined with target_step", async () => {
        const root = tmpRoot("wf-targets-conflict")
        const sid = "ses_wf_targets_conflict"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "gate", verifier: "bob", target_step: 1, targets: [1], criteria: "ok" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("must not set both target_step and targets")
    })

    test("targets must reference previous task steps and cannot self-verify", async () => {
        const root = tmpRoot("wf-targets-invalid")
        const sid = "ses_wf_targets_invalid"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "gate", verifier: "bob", criteria: "ok" },
                    { kind: "gate", verifier: "alice", targets: [1, 2], criteria: "check both" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("targets[1]")
        expect(result).toContain("must reference a previous task step")
    })

    test("targets self-verification is rejected against every target member", async () => {
        const root = tmpRoot("wf-targets-selfverify")
        const sid = "ses_wf_targets_selfverify"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "api" },
                    { kind: "task", member: "carol", task: "tests" },
                    { kind: "gate", verifier: "carol", targets: [1, 2], criteria: "both ok" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("target step 2")
        expect(result).toContain("self-verification")
    })

    test("task step with targets is rejected as a gate-only field", async () => {
        const root = tmpRoot("wf-task-targets")
        const sid = "ses_wf_task_targets"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", steps: [{ kind: "task", member: "alice", task: "do x", targets: [1] }] },
            makeToolContext(sid),
        )
        expect(result).toContain("must not set gate fields")
    })

    test("target_step unknown id -> rejected", async () => {
        const root = tmpRoot("wf-target-unknown-id")
        const sid = "ses_wf_tui"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "gate", verifier: "bob", target_step: "missing", criteria: "ok" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("must reference a previous task step by id")
    })

    test("task inputs must reference previous task or join steps", async () => {
        const root = tmpRoot("wf-input-forward")
        const sid = "ses_wf_input_forward"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "task", member: "bob", task: "consume future", inputs: [3] },
                    { kind: "task", member: "alice", task: "future" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("inputs[0]")
        expect(result).toContain("must reference a previous task or join step")
    })

    test("on_invalid retry_verifier requires max_invalid_retries", async () => {
        const root = tmpRoot("wf-invalid-no-max")
        const sid = "ses_wf_inm"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "gate", verifier: "bob", criteria: "ok", on_invalid: "retry_verifier" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("requires `max_invalid_retries`")
    })

    test("dry_run renders id and on_invalid policy", async () => {
        const root = tmpRoot("wf-dry-id")
        const sid = "ses_wf_dryid"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", id: "impl", member: "alice", task: "implement" },
                    { kind: "gate", id: "verify", verifier: "bob", target_step: "impl", criteria: "ok", on_invalid: "escalate" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("1. [task] (impl) alice")
        expect(result).toContain("2. [gate] (verify) bob verifies step 1 (impl)")
        expect(result).toContain("on_invalid=escalate")
    })

    test("dry_run renders data-flow controls and reduce reducer metadata", async () => {
        const root = tmpRoot("wf-dry-dataflow-reduce")
        const sid = "ses_wf_dry_dataflow_reduce"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol"), makeMember("dave")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", id: "draft", member: "alice", task: "draft" },
                    { kind: "task", id: "hidden", member: "bob", task: "hidden", expose_output: false },
                    { kind: "task", member: "carol", task: "consume selected", inputs: ["hidden"] },
                    {
                        kind: "fanout",
                        join_policy: "reduce",
                        reducer_member: "dave",
                        branches: [
                            { id: "api", steps: [{ kind: "task", member: "alice", task: "api" }] },
                            { id: "docs", steps: [{ kind: "task", member: "bob", task: "docs" }] },
                        ],
                    },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("expose_output=false")
        expect(result).toContain("inputs=step 2 (hidden)")
        expect(result).toContain("join_policy=reduce")
        expect(result).toContain("reducer_member=dave")
    })

    test("dry_run renders on_fail skip and survivor join controls", async () => {
        const root = tmpRoot("wf-dry-skip-survivors")
        const sid = "ses_wf_dry_skip_survivors"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", member: "alice", task: "build" },
                    { kind: "gate", verifier: "bob", criteria: "optional", on_fail: "skip" },
                    {
                        kind: "fanout",
                        join_policy: "all",
                        use_survivors: true,
                        branches: [
                            { id: "api", steps: [{ kind: "task", member: "alice", task: "api" }] },
                            { id: "qa", steps: [{ kind: "task", member: "carol", task: "qa" }] },
                        ],
                    },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("on_fail=skip")
        expect(result).toContain("join_policy=all")
        expect(result).toContain("use_survivors=true")
    })

    test("conditional jumps: goto unknown id -> rejected", async () => {
        const root = tmpRoot("wf-goto-unknown")
        const sid = "ses_wf_gu"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "gate", verifier: "bob", criteria: "ok", on_pass_goto: "missing" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("on_pass_goto")
        expect(result).toContain("must reference an existing step by id")
    })

    test("conditional jumps: goto self -> rejected", async () => {
        const root = tmpRoot("wf-goto-self")
        const sid = "ses_wf_gs"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "gate", id: "g", verifier: "bob", criteria: "ok", on_pass_goto: "g" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("on_pass_goto")
        expect(result).toContain("must reference an existing step")
    })

    test("step controls: max_output_bytes on a gate is rejected", async () => {
        const root = tmpRoot("wf-mob-gate")
        const sid = "ses_wf_mobg"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "gate", verifier: "bob", criteria: "ok", max_output_bytes: 100 },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("max_output_bytes")
        expect(result).toContain("task steps")
    })

    test("step controls: max_jumps without on_*_goto is rejected", async () => {
        const root = tmpRoot("wf-maxjumps-nogoto")
        const sid = "ses_wf_mjng"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "gate", verifier: "bob", criteria: "ok", max_jumps: 3 },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("max_jumps")
        expect(result).toContain("on_pass_goto")
    })

    test("step controls: max_jumps with on_pass_goto is accepted", async () => {
        const root = tmpRoot("wf-maxjumps-goto")
        const sid = "ses_wf_mjg"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "gate", verifier: "bob", criteria: "ok", on_pass_goto: 3, max_jumps: 2 },
                    { kind: "task", member: "carol", task: "ship" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("max_jumps=2")
        expect(result).toContain("on_pass->step 3")
    })

    test("step controls: non-positive max_output_bytes is rejected", async () => {
        const root = tmpRoot("wf-mob-bad")
        const sid = "ses_wf_mobb"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "draft", max_output_bytes: 0 },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("max_output_bytes")
    })

    test("step controls: approval_after is incompatible with on_pass_goto", async () => {
        const root = tmpRoot("wf-after-goto")
        const sid = "ses_wf_ag"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "impl" },
                    { kind: "gate", verifier: "bob", criteria: "ok", on_pass_goto: 1, approval_after: true },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("approval_after")
        expect(result).toContain("goto")
    })

    test("step controls: dry_run renders per-step approval and output caps", async () => {
        const root = tmpRoot("wf-controls-dry")
        const sid = "ses_wf_cd"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", member: "alice", task: "draft", approval_before: true, max_output_bytes: 512 },
                    { kind: "gate", verifier: "bob", criteria: "ok", approval_after: true },
                    { kind: "task", member: "carol", task: "ship" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("approval_before")
        expect(result).toContain("max_output_bytes=512")
        expect(result).toContain("approval_after")
    })

    test("conditional jumps: on_invalid_goto incompatible with escalate -> rejected", async () => {
        const root = tmpRoot("wf-goto-escalate")
        const sid = "ses_wf_ge"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "gate", verifier: "bob", criteria: "ok", on_invalid: "escalate", on_invalid_goto: 1 },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("on_invalid_goto is incompatible with on_invalid='escalate'")
    })

    test("conditional jumps: dry_run renders goto targets and max_jumps", async () => {
        const root = tmpRoot("wf-goto-dry")
        const sid = "ses_wf_gd"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", id: "impl", member: "alice", task: "implement" },
                    { kind: "task", id: "polish", member: "carol", task: "polish" },
                    { kind: "gate", id: "verify", verifier: "bob", target_step: "impl", criteria: "ok", on_pass_goto: "polish", on_fail_goto: "impl", max_jumps: 2 },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("on_pass->step 2 (polish)")
        expect(result).toContain("on_fail->step 1 (impl)")
        expect(result).toContain("max_jumps=2")
    })

    test("conditional jumps: dry_run renders where condition for threshold goto", async () => {
        const root = tmpRoot("wf-where-dry")
        const sid = "ses_wf_where_dry"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", id: "impl", member: "alice", task: "implement" },
                    { kind: "gate", id: "verify", verifier: "bob", criteria: "ok", on_pass_goto: "polish", where: { score_gte: 8 } },
                    { kind: "task", id: "polish", member: "carol", task: "polish" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("on_pass->step 3 (polish) when score_gte 8")
    })

    test("conditional jumps: where must contain exactly one supported condition", async () => {
        const root = tmpRoot("wf-where-bad")
        const sid = "ses_wf_where_bad"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "implement" },
                    { kind: "gate", verifier: "bob", criteria: "ok", on_pass_goto: 3, where: { score_gte: 8, confidence_gte: 0.9 } },
                    { kind: "task", member: "carol", task: "polish" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("where")
        expect(result).toContain("exactly one")
    })

    test("workflow_file dry_run loads steps and substitutes vars", async () => {
        const root = tmpRoot("wf-file-dry")
        const sid = "ses_wf_file_dry"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const dir = join(root, ".octeam", "workflows")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "register.json"), JSON.stringify({
            steps: [
                { kind: "task", member: "alice", task: "Implement ${handler}" },
                { kind: "gate", verifier: "bob", criteria: "${handler} passes", where: { score_gte: 8 }, on_pass_goto: 1 },
            ],
        }))

        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", dry_run: true, workflow_file: ".octeam/workflows/register.json", vars: { handler: "register-handler" } },
            makeToolContext(sid),
        )

        expect(result).toContain("Implement register-handler")
        expect(result).toContain("register-handler passes")
    })

    test("workflow_file accepts an explicit version 1", async () => {
        const root = tmpRoot("wf-file-version1")
        const sid = "ses_wf_file_v1"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const dir = join(root, ".octeam", "workflows")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "v.json"), JSON.stringify({
            version: 1,
            steps: [
                { kind: "task", member: "alice", task: "do x" },
                { kind: "gate", verifier: "bob", criteria: "ok" },
            ],
        }))

        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", dry_run: true, workflow_file: ".octeam/workflows/v.json" },
            makeToolContext(sid),
        )

        expect(result).toContain("1. [task] alice")
        expect(result).toContain("2. [gate] bob verifies step 1")
    })

    test("workflow_file rejects an unsupported future version", async () => {
        const root = tmpRoot("wf-file-version99")
        const sid = "ses_wf_file_v99"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const dir = join(root, ".octeam", "workflows")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "v.json"), JSON.stringify({
            version: 99,
            steps: [
                { kind: "task", member: "alice", task: "do x" },
                { kind: "gate", verifier: "bob", criteria: "ok" },
            ],
        }))

        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", dry_run: true, workflow_file: ".octeam/workflows/v.json" },
            makeToolContext(sid),
        )

        expect(result).toContain("version")
        expect(result).toContain("99")
        expect(result).toContain("unsupported")
    })

    test("workflow_file rejects a non-integer version", async () => {
        const root = tmpRoot("wf-file-version-bad")
        const sid = "ses_wf_file_vb"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const dir = join(root, ".octeam", "workflows")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "v.json"), JSON.stringify({
            version: "1",
            steps: [
                { kind: "task", member: "alice", task: "do x" },
                { kind: "gate", verifier: "bob", criteria: "ok" },
            ],
        }))

        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", dry_run: true, workflow_file: ".octeam/workflows/v.json" },
            makeToolContext(sid),
        )

        expect(result).toContain("version")
        expect(result).toContain("integer")
    })

    test("workflow_file unknown ${var} stays literal by default (backward compat)", async () => {
        const root = tmpRoot("wf-file-unknown-default")
        const sid = "ses_wf_file_uk_def"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const dir = join(root, ".octeam", "workflows")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "f.json"), JSON.stringify({
            steps: [
                { kind: "task", member: "alice", task: "do ${missing}" },
                { kind: "gate", verifier: "bob", criteria: "ok" },
            ],
        }))

        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", dry_run: true, workflow_file: ".octeam/workflows/f.json", vars: {} },
            makeToolContext(sid),
        )

        // Default: unknown ${missing} is left as a literal — backward compat.
        expect(result).toContain("${missing}")
    })

    test("workflow_file strict_vars=true rejects unknown template variable", async () => {
        const root = tmpRoot("wf-file-strict-unknown")
        const sid = "ses_wf_file_strict_unk"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const dir = join(root, ".octeam", "workflows")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "f.json"), JSON.stringify({
            strict_vars: true,
            steps: [
                { kind: "task", member: "alice", task: "do ${missing}" },
                { kind: "gate", verifier: "bob", criteria: "ok" },
            ],
        }))

        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", dry_run: true, workflow_file: ".octeam/workflows/f.json", vars: {} },
            makeToolContext(sid),
        )

        expect(result).toContain("unknown template variable")
        expect(result).toContain("missing")
        expect(result).not.toContain("[task] alice")
    })

    test("workflow_file strict_vars=false keeps backward-compat literal behavior", async () => {
        const root = tmpRoot("wf-file-strict-false")
        const sid = "ses_wf_file_strict_f"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const dir = join(root, ".octeam", "workflows")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "f.json"), JSON.stringify({
            strict_vars: false,
            steps: [
                { kind: "task", member: "alice", task: "do ${missing}" },
                { kind: "gate", verifier: "bob", criteria: "ok" },
            ],
        }))

        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", dry_run: true, workflow_file: ".octeam/workflows/f.json", vars: {} },
            makeToolContext(sid),
        )

        // Explicit strict_vars=false -> same as default: literal preserved.
        expect(result).toContain("${missing}")
    })

    test("workflow_file rejects inline steps at the same time", async () => {
        const root = tmpRoot("wf-file-inline")
        const sid = "ses_wf_file_inline"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", workflow_file: ".octeam/workflows/register.json", steps: [{ kind: "task", member: "alice", task: "x" }] },
            makeToolContext(sid),
        )

        expect(result).toContain("must set exactly one of steps or workflow_file")
    })

    test("workflow_file rejects paths outside the workspace", async () => {
        const root = tmpRoot("wf-file-escape")
        const sid = "ses_wf_file_escape"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", workflow_file: "../escape.json" },
            makeToolContext(sid),
        )

        expect(result).toContain("workflow_file")
        expect(result).toContain("workspace")
    })

    test("on_fail retry requires explicit max_retries", async () => {
        const root = tmpRoot("wf-retry-no-max")
        const sid = "ses_wf_rnm"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "gate", verifier: "bob", criteria: "ok", on_fail: "retry" },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("requires `max_retries`")
    })

    test("dry_run returns a step ledger without starting orchestration", async () => {
        const root = tmpRoot("wf-dry-run")
        const sid = "ses_wf_dr"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", member: "alice", task: "draft" },
                    { kind: "gate", verifier: "bob", target_step: 1, criteria: "ok", on_fail: "retry", max_retries: 1 },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("Workflow dry run")
        expect(result).toContain("1. [task] alice")
        expect(result).toContain("2. [gate] bob verifies step 1")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.activeTask).toBeUndefined()
        expect(after.status).toBe("live")
    })

    test("fanout dry_run renders branch structure without starting orchestration", async () => {
        const root = tmpRoot("wf-fanout-dry")
        const sid = "ses_wf_fanout_dry"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol"), makeMember("dave"), makeMember("erin")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", id: "plan", member: "alice", task: "Plan rollout" },
                    {
                        kind: "fanout",
                        id: "parallel",
                        max_errored: 1,
                        branches: [
                            {
                                id: "api",
                                steps: [
                                    { kind: "task", id: "api-build", member: "bob", task: "Build API" },
                                    { kind: "gate", id: "api-check", verifier: "carol", criteria: "API passes" },
                                ],
                            },
                            {
                                id: "docs",
                                steps: [
                                    { kind: "task", id: "docs-write", member: "dave", task: "Write docs" },
                                ],
                            },
                        ],
                    },
                    { kind: "join", id: "merge" },
                    { kind: "task", id: "ship", member: "erin", task: "Ship release" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("2. [fanout] (parallel) branches: api, docs -> join step 6 (merge); max_errored=1")
        expect(result).toContain("  branch api:")
        expect(result).toContain("  3. [task] (api-build) bob: Build API")
        expect(result).toContain("  4. [gate] (api-check) carol verifies step 3 (api-build): API passes")
        expect(result).toContain("  branch docs:")
        expect(result).toContain("6. [join] (merge) waits for all branches to reach a terminal state before applying join policy; branches: api, docs; max_errored=1")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.activeTask).toBeUndefined()
        expect(after.status).toBe("live")
    })

    test("fanout dry_run explains all-terminal join policy semantics", async () => {
        const root = tmpRoot("wf-fanout-policy-dry")
        const sid = "ses_wf_fanout_policy_dry"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    {
                        kind: "fanout",
                        join_policy: "quorum",
                        quorum: 0.5,
                        branches: [
                            { id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }] },
                            { id: "qa", steps: [{ kind: "task", member: "carol", task: "Test" }] },
                        ],
                    },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("waits for all branches to reach a terminal state before applying join policy")
        expect(result).toContain("join_policy=quorum")
        expect(result).toContain("quorum=0.5")
    })

    test("workflow_file fanout dry_run loads branch structure", async () => {
        const root = tmpRoot("wf-file-fanout-dry")
        const sid = "ses_wf_file_fanout_dry"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const dir = join(root, ".octeam", "workflows")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "fanout.json"), JSON.stringify({
            steps: [
                { kind: "task", id: "plan", member: "alice", task: "Plan ${area}" },
                {
                    kind: "fanout",
                    id: "parallel",
                    branches: [
                        { id: "api", steps: [{ kind: "task", id: "api-build", member: "bob", task: "Build ${area} API" }] },
                        { id: "qa", steps: [{ kind: "task", id: "qa-run", member: "carol", task: "Test ${area} API" }] },
                    ],
                },
                { kind: "join", id: "merge" },
            ],
        }))

        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", dry_run: true, workflow_file: ".octeam/workflows/fanout.json", vars: { area: "billing" } },
            makeToolContext(sid),
        )

        expect(result).toContain("Plan billing")
        expect(result).toContain("Build billing API")
        expect(result).toContain("2. [fanout] (parallel) branches: api, qa -> join step 5 (merge); max_errored=0")
    })

    test("workflow_file invalid retry fields -> rejected before runtime", async () => {
        const root = tmpRoot("wf-file-invalid-retry")
        const sid = "ses_wf_file_invalid_retry"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const dir = join(root, ".octeam", "workflows")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "invalid-retry.json"), JSON.stringify({
            steps: [
                { kind: "task", member: "alice", task: "Plan" },
                { kind: "gate", verifier: "bob", criteria: "OK", on_invalid: "retry_verifier", max_invalid_retries: "never" },
            ],
        }))

        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", dry_run: true, workflow_file: ".octeam/workflows/invalid-retry.json" },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: workflow_file \".octeam/workflows/invalid-retry.json\" step 2 max_invalid_retries must be an integer from 0 to 5")
    })

    test("workflow_file invalid timeout fields -> rejected before runtime", async () => {
        const root = tmpRoot("wf-file-invalid-timeout")
        const sid = "ses_wf_file_invalid_timeout"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const dir = join(root, ".octeam", "workflows")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "invalid-timeout.json"), JSON.stringify({
            steps: [
                { kind: "task", member: "alice", task: "Plan", timeout_ms: "soon" },
            ],
        }))

        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", dry_run: true, workflow_file: ".octeam/workflows/invalid-timeout.json" },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: workflow_file \".octeam/workflows/invalid-timeout.json\" step 1 timeout_ms must be an integer >= 1000")
    })

    test("workflow_file runtime dispatches the first templated task", async () => {
        const root = tmpRoot("wf-file-runtime")
        const sid = "ses_wf_file_runtime"
        const aliceSid = "ses_wf_file_runtime_alice"
        const bobSid = "ses_wf_file_runtime_bob"
        tracked.push(sid, aliceSid, bobSid)
        await setupTeam(root, sid, [makeMember("alice", aliceSid), makeMember("bob", bobSid)], Date.now())
        const dir = join(root, ".octeam", "workflows")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "register.json"), JSON.stringify({
            version: 1,
            strict_vars: true,
            steps: [
                { kind: "task", id: "impl", member: "alice", task: "Implement ${handler}" },
                { kind: "gate", id: "verify", verifier: "bob", target_step: "impl", criteria: "${handler} passes" },
            ],
        }))
        const calls: DispatchCall[] = []

        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: calls })).execute(
            { team_id: "alpha", workflow_file: ".octeam/workflows/register.json", vars: { handler: "register-handler" } },
            makeToolContext(sid),
        )

        expect(result).toContain("team_workflow started")
        expect(calls).toContainEqual({ sessionId: aliceSid, text: "Implement register-handler" })
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.status).toBe("busy")
        expect(after.activeTask?.type).toBe("workflow")
    })

    test("workflow_file runtime rejects missing strict vars before dispatch", async () => {
        const root = tmpRoot("wf-file-runtime-strict-missing")
        const sid = "ses_wf_file_runtime_strict_missing"
        const aliceSid = "ses_wf_file_runtime_strict_missing_alice"
        tracked.push(sid, aliceSid)
        await setupTeam(root, sid, [makeMember("alice", aliceSid)], Date.now())
        const dir = join(root, ".octeam", "workflows")
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "missing-var.json"), JSON.stringify({
            version: 1,
            strict_vars: true,
            steps: [{ kind: "task", member: "alice", task: "Implement ${handler}" }],
        }))
        const calls: DispatchCall[] = []

        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: calls })).execute(
            { team_id: "alpha", workflow_file: ".octeam/workflows/missing-var.json" },
            makeToolContext(sid),
        )

        expect(result).toContain("unknown template variable \"handler\"")
        expect(calls).toEqual([])
    })

    test("fanout recursive branch step -> rejected", async () => {
        const root = tmpRoot("wf-fanout-recursive")
        const sid = "ses_wf_fanout_recursive"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    { kind: "fanout", branches: [{ id: "api", steps: [{ kind: "fanout", branches: [{ id: "inner", steps: [{ kind: "task", member: "bob", task: "Nested" }] }] }] }] },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 branch \"api\" must not contain recursive fanout")
    })

    test("fanout missing join -> rejected", async () => {
        const root = tmpRoot("wf-fanout-missing-join")
        const sid = "ses_wf_fanout_missing_join"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    { kind: "fanout", branches: [{ id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }] }] },
                    { kind: "task", member: "alice", task: "Ship" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 must be followed by a join step")
    })

    test("orphan join -> rejected", async () => {
        const root = tmpRoot("wf-fanout-orphan-join")
        const sid = "ses_wf_fanout_orphan_join"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", steps: [{ kind: "task", member: "alice", task: "Plan" }, { kind: "join" }] },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: join step 2 has no matching fanout step")
    })

    test("fanout duplicate branch ids -> rejected", async () => {
        const root = tmpRoot("wf-fanout-dup-branch")
        const sid = "ses_wf_fanout_dup_branch"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    {
                        kind: "fanout",
                        branches: [
                            { id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }] },
                            { id: "api", steps: [{ kind: "task", member: "carol", task: "Test" }] },
                        ],
                    },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: duplicate fanout branch id \"api\" at fanout step 2")
    })

    test("fanout duplicate step ids -> rejected", async () => {
        const root = tmpRoot("wf-fanout-dup-step")
        const sid = "ses_wf_fanout_dup_step"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", id: "build", member: "alice", task: "Plan" },
                    { kind: "fanout", branches: [{ id: "api", steps: [{ kind: "task", id: "build", member: "bob", task: "Build" }] }] },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: duplicate step id \"build\"")
    })

    test("fanout unknown branch member -> rejected", async () => {
        const root = tmpRoot("wf-fanout-unknown")
        const sid = "ses_wf_fanout_unknown"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    { kind: "fanout", branches: [{ id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }] }] },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: unknown member \"bob\" in fanout step 2 branch \"api\" step 1")
    })

    test("fanout same-member concurrent branches -> rejected", async () => {
        const root = tmpRoot("wf-fanout-same-member")
        const sid = "ses_wf_fanout_same_member"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    {
                        kind: "fanout",
                        branches: [
                            { id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }] },
                            { id: "qa", steps: [{ kind: "task", member: "bob", task: "Test" }] },
                        ],
                    },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 uses member \"bob\" in concurrent branches \"api\" and \"qa\"")
    })

    test("fanout join_policy='quorum' without quorum -> rejected", async () => {
        const root = tmpRoot("wf-quorum-no-q")
        const sid = "ses_wf_quorum_no_q"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    {
                        kind: "fanout",
                        join_policy: "quorum",
                        branches: [
                            { id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }] },
                            { id: "qa", steps: [{ kind: "task", member: "carol", task: "Test" }] },
                        ],
                    },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 join_policy='quorum' requires `quorum`")
    })

    test("fanout join_policy='required_branches' with unknown branch -> rejected", async () => {
        const root = tmpRoot("wf-required-unknown")
        const sid = "ses_wf_required_unknown"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    {
                        kind: "fanout",
                        join_policy: "required_branches",
                        required_branches: ["missing"],
                        branches: [
                            { id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }] },
                            { id: "qa", steps: [{ kind: "task", member: "carol", task: "Test" }] },
                        ],
                    },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 required_branches references unknown branch \"missing\"")
    })

    test("fanout join_policy='reduce' without reducer_member -> rejected", async () => {
        const root = tmpRoot("wf-reduce-no-red")
        const sid = "ses_wf_reduce_no_red"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    {
                        kind: "fanout",
                        join_policy: "reduce",
                        branches: [
                            { id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }] },
                            { id: "qa", steps: [{ kind: "task", member: "carol", task: "Test" }] },
                        ],
                    },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 join_policy='reduce' requires `reducer_member`")
    })

    test("fanout join_policy='select' without reducer_member -> rejected", async () => {
        // Given: select join policy without a selector member.
        const root = tmpRoot("wf-select-no-selector")
        const sid = "ses_wf_select_no_selector"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())

        // When: the workflow is validated.
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    {
                        kind: "fanout",
                        join_policy: "select",
                        branches: [
                            { id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }] },
                            { id: "qa", steps: [{ kind: "task", member: "carol", task: "Test" }] },
                        ],
                    },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        // Then: select requires reducer_member as the selector.
        expect(result).toContain("Error: fanout step 2 join_policy='select' requires `reducer_member`")
    })

    test("fanout same gate verifier across concurrent branches -> rejected", async () => {
        const root = tmpRoot("wf-fanout-same-verifier")
        const sid = "ses_wf_fanout_same_verifier"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol"), makeMember("dave")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    {
                        kind: "fanout",
                        branches: [
                            { id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }, { kind: "gate", verifier: "dave", criteria: "API OK" }] },
                            { id: "qa", steps: [{ kind: "task", member: "carol", task: "Test" }, { kind: "gate", verifier: "dave", criteria: "QA OK" }] },
                        ],
                    },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 uses member \"dave\" in concurrent branches \"api\" and \"qa\"")
    })

    test("fanout invalid max_errored -> rejected", async () => {
        const root = tmpRoot("wf-fanout-max-errored")
        const sid = "ses_wf_fanout_max_errored"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    {
                        kind: "fanout",
                        max_errored: 2,
                        branches: [
                            { id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }] },
                            { id: "qa", steps: [{ kind: "task", member: "carol", task: "Test" }] },
                        ],
                    },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 max_errored must be an integer from 0 to 1")
    })

    test("workflow on_timeout retry requires max_timeout_retries -> rejected", async () => {
        const root = tmpRoot("wf-timeout-retry-required")
        const sid = "ses_wf_timeout_retry_required"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [{ kind: "task", member: "alice", task: "Plan", timeout_ms: 1000, on_timeout: "retry" }],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: step 1 (task) with on_timeout='retry' requires `max_timeout_retries`")
    })

    test("fanout branch on_timeout retry -> rejected", async () => {
        const root = tmpRoot("wf-branch-timeout-retry")
        const sid = "ses_wf_branch_timeout_retry"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    { kind: "fanout", branches: [{ id: "api", steps: [{ kind: "task", member: "bob", task: "Build", timeout_ms: 1000, on_timeout: "retry", max_timeout_retries: 1 }] }] },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 branch \"api\" step 1 must not set on_timeout='retry' or on_timeout='skip'")
    })

    test("fanout branch approval controls -> rejected", async () => {
        const root = tmpRoot("wf-fanout-approval")
        const sid = "ses_wf_fanout_approval"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    { kind: "fanout", branches: [{ id: "api", steps: [{ kind: "task", member: "bob", task: "Build", approval_before: true }] }] },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 branch \"api\" step 1 must not set approval_before/approval_after")
    })

    test("fanout branch goto crossing boundary -> rejected", async () => {
        const root = tmpRoot("wf-fanout-goto-cross")
        const sid = "ses_wf_fanout_goto_cross"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    {
                        kind: "fanout",
                        branches: [{ id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }, { kind: "gate", verifier: "carol", criteria: "OK", on_pass_goto: "ship" }] }],
                    },
                    { kind: "join" },
                    { kind: "task", id: "ship", member: "alice", task: "Ship" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 branch \"api\" step 2 (gate) on_pass_goto \"ship\" must not cross fanout boundaries")
    })

    test("fanout branch gate self-verification -> rejected", async () => {
        const root = tmpRoot("wf-fanout-selfverify")
        const sid = "ses_wf_fanout_selfverify"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    { kind: "fanout", branches: [{ id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }, { kind: "gate", verifier: "bob", criteria: "OK" }] }] },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 branch \"api\" step 2 (gate) verifier \"bob\" must differ from target step 1 member (no self-verification)")
    })

    test("fanout marker explicit gate target -> rejected", async () => {
        const root = tmpRoot("wf-fanout-marker-target")
        const sid = "ses_wf_fanout_marker_target"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob"), makeMember("carol")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    { kind: "fanout", id: "parallel", branches: [{ id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }] }] },
                    { kind: "join", id: "merge" },
                    { kind: "gate", verifier: "carol", target_step: "parallel", criteria: "Marker is not valid" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: step 5 (gate) target_step \"parallel\" must not reference a fanout/join marker step")
    })

    test("unknown gate verifier -> rejected", async () => {
        const root = tmpRoot("wf-unknownverifier")
        const sid = "ses_wf_uv"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", steps: [{ kind: "task", member: "alice", task: "do x" }, { kind: "gate", verifier: "bob", criteria: "ok" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("unknown member")
    })
})

// -----------------------------------------------------------------------
// team_loop — type-specific validations
// -----------------------------------------------------------------------
describe("team_loop type-specific validation", () => {
    test("decider = 'master' → rejected", async () => {
        const root = tmpRoot("loop-dmaster")
        const sid = "ses_loop_dm"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        const result = await teamLoopTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "code" }], decider: "master", max_rounds: 3, initial_task: "start" },
            makeToolContext(sid),
        )
        expect(result).toContain("must be a member")
    })

    test("decider not a member → rejected", async () => {
        const root = tmpRoot("loop-d404")
        const sid = "ses_loop_d404"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamLoopTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "code" }], decider: "bob", max_rounds: 3, initial_task: "start" },
            makeToolContext(sid),
        )
        expect(result).toContain("not a member")
    })

    test("unknown stage member → rejected", async () => {
        const root = tmpRoot("loop-unknown")
        const sid = "ses_loop_unk"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamLoopTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", stages: [{ member: "bob", task: "code" }], decider: "alice", max_rounds: 3, initial_task: "start" },
            makeToolContext(sid),
        )
        expect(result).toContain("unknown member")
    })
})

// -----------------------------------------------------------------------
// team_delegate — type-specific validations
// -----------------------------------------------------------------------
describe("team_delegate type-specific validation", () => {
    test("unknown blockedBy ref → rejected", async () => {
        const root = tmpRoot("del-ref")
        const sid = "ses_del_ref"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        const result = await teamDelegateTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            {
                team_id: "alpha",
                tasks: [
                    { ref: "t1", subject: "s1", description: "d1", blocked_by: ["t2"] },
                ],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("unknown blockedBy")
        expect(result).toContain("t2")
    })
})

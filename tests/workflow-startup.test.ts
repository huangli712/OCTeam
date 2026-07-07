import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask } from "../src/core/types.js"
import { teamConsensusTool } from "../src/tools/consensus.js"
import { teamDelegateTool } from "../src/tools/delegate.js"
import { teamLoopTool } from "../src/tools/loop.js"
import { teamParallelTool } from "../src/tools/parallel.js"
import { teamPipelineTool } from "../src/tools/pipeline.js"
import { teamWorkflowTool } from "../src/tools/workflow.js"
import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"

function makeCtx(storageRoot: string): PluginContext {
    return { storageRoot, scope: "project", directory: storageRoot } as unknown as PluginContext
}

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
// team_parallel
// -----------------------------------------------------------------------
describe("team_parallel startup validation", () => {
    test("non-master → rejected", async () => {
        const root = tmpRoot("par-nomaster")
        const masterSid = "ses_par_m"
        const memberSid = "ses_par_a"
        tracked.push(masterSid, memberSid)
        await setupTeam(root, masterSid, [makeMember("alice", memberSid)], Date.now())
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "isolated", task: "do x" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("master-only")
    })

    test("inactive team → rejected", async () => {
        const root = tmpRoot("par-inactive")
        const sid = "ses_par_inact"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, undefined) // no activatedAt
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "isolated", task: "do x" },
            makeToolContext(sid),
        )
        expect(result).toContain("Error")
    })

    test("already busy → rejected", async () => {
        const root = tmpRoot("par-busy")
        const sid = "ses_par_busy"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        await setBusy(root, sid, "parallel")
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "isolated", task: "do x" },
            makeToolContext(sid),
        )
        expect(result).toContain("already has an active orchestration")
    })

    test("isolated without task → rejected", async () => {
        const root = tmpRoot("par-notask")
        const sid = "ses_par_notask"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        const result = await teamParallelTool(makeCtx(root)).execute(
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
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "cooperative" },
            makeToolContext(sid),
        )
        expect(result).toContain("requires `tasks`")
    })

    test("signoff_decider not a member → rejected", async () => {
        const root = tmpRoot("par-sd")
        const sid = "ses_par_sd"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "isolated", task: "do x", signoff_policy: "decider", signoff_decider: "bob" },
            makeToolContext(sid),
        )
        expect(result).toContain("not a member")
    })

    test("reduce_policy 'select' without reducer_member → rejected", async () => {
        const root = tmpRoot("par-sel-nored")
        const sid = "ses_par_sel_nr"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamParallelTool(makeCtx(root)).execute(
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
        const result = await teamParallelTool(makeCtx(root)).execute(
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
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "isolated", task: "do x", reduce_policy: "rubric", reduce_rubric: "correctness" },
            makeToolContext(sid),
        )
        expect(result).toContain("requires reducer_member")
    })
})

// -----------------------------------------------------------------------
// team_consensus
// -----------------------------------------------------------------------
describe("team_consensus startup validation", () => {
    test("non-master → rejected", async () => {
        const root = tmpRoot("con-nomaster")
        const masterSid = "ses_con_m"
        const memberSid = "ses_con_a"
        tracked.push(masterSid, memberSid)
        await setupTeam(root, masterSid, [makeMember("alice", memberSid)], Date.now())
        const result = await teamConsensusTool(makeCtx(root)).execute(
            { team_id: "alpha", topic: "use sqlite?" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("master-only")
    })

    test("inactive team → rejected", async () => {
        const root = tmpRoot("con-inactive")
        const sid = "ses_con_inact"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, undefined)
        const result = await teamConsensusTool(makeCtx(root)).execute(
            { team_id: "alpha", topic: "use sqlite?" },
            makeToolContext(sid),
        )
        expect(result).toContain("Error")
    })

    test("already busy → rejected", async () => {
        const root = tmpRoot("con-busy")
        const sid = "ses_con_busy"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        await setBusy(root, sid, "consensus")
        const result = await teamConsensusTool(makeCtx(root)).execute(
            { team_id: "alpha", topic: "use sqlite?" },
            makeToolContext(sid),
        )
        expect(result).toContain("already has an active orchestration")
    })
})

// -----------------------------------------------------------------------
// team_pipeline
// -----------------------------------------------------------------------
describe("team_pipeline startup validation", () => {
    test("non-master → rejected", async () => {
        const root = tmpRoot("pip-nomaster")
        const masterSid = "ses_pip_m"
        const memberSid = "ses_pip_a"
        tracked.push(masterSid, memberSid)
        await setupTeam(root, masterSid, [makeMember("alice", memberSid)], Date.now())
        const result = await teamPipelineTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "do x" }] },
            makeToolContext(memberSid),
        )
        expect(result).toContain("master-only")
    })

    test("inactive team → rejected", async () => {
        const root = tmpRoot("pip-inactive")
        const sid = "ses_pip_inact"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, undefined)
        const result = await teamPipelineTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "do x" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("Error")
    })

    test("already busy → rejected", async () => {
        const root = tmpRoot("pip-busy")
        const sid = "ses_pip_busy"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        await setBusy(root, sid, "pipeline")
        const result = await teamPipelineTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "do x" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("already has an active orchestration")
    })

    test("signoff_decider not a member → rejected", async () => {
        const root = tmpRoot("pip-sd")
        const sid = "ses_pip_sd"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamPipelineTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "do x" }], signoff_policy: "decider", signoff_decider: "bob" },
            makeToolContext(sid),
        )
        expect(result).toContain("not a member")
    })

    test("unknown stage member → rejected", async () => {
        const root = tmpRoot("pip-unknown")
        const sid = "ses_pip_unk"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamPipelineTool(makeCtx(root)).execute(
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
        const result = await teamPipelineTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "a" }, { member: "alice", task: "b" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("unique")
    })
})

// -----------------------------------------------------------------------
// team_workflow
// -----------------------------------------------------------------------
describe("team_workflow startup validation", () => {
    test("non-master -> rejected", async () => {
        const root = tmpRoot("wf-nomaster")
        const masterSid = "ses_wf_m"
        const memberSid = "ses_wf_a"
        tracked.push(masterSid, memberSid)
        await setupTeam(root, masterSid, [makeMember("alice", memberSid), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx(root)).execute(
            { team_id: "alpha", steps: [{ kind: "task", member: "alice", task: "do x" }] },
            makeToolContext(memberSid),
        )
        expect(result).toContain("master-only")
    })

    test("inactive team -> rejected", async () => {
        const root = tmpRoot("wf-inactive")
        const sid = "ses_wf_inact"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, undefined)
        const result = await teamWorkflowTool(makeCtx(root)).execute(
            { team_id: "alpha", steps: [{ kind: "task", member: "alice", task: "do x" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("Error")
    })

    test("already busy -> rejected", async () => {
        const root = tmpRoot("wf-busy")
        const sid = "ses_wf_busy"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        await setBusy(root, sid, "workflow")
        const result = await teamWorkflowTool(makeCtx(root)).execute(
            { team_id: "alpha", steps: [{ kind: "task", member: "alice", task: "do x" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("already has an active orchestration")
    })

    test("empty steps -> rejected", async () => {
        const root = tmpRoot("wf-empty")
        const sid = "ses_wf_empty"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
            { team_id: "alpha", steps: [{ kind: "task", member: "bob", task: "do x" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("unknown member")
    })

    test("gate-first (no preceding task) -> rejected", async () => {
        const root = tmpRoot("wf-gatefirst")
        const sid = "ses_wf_gf"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx(root)).execute(
            { team_id: "alpha", steps: [{ kind: "gate", verifier: "bob", criteria: "ok" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("no preceding task")
    })

    test("task step with gate-only fields -> rejected", async () => {
        const root = tmpRoot("wf-task-gate-field")
        const sid = "ses_wf_tgf"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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

    test("on_invalid retry_verifier requires max_invalid_retries", async () => {
        const root = tmpRoot("wf-invalid-no-max")
        const sid = "ses_wf_inm"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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

    test("conditional jumps: goto unknown id -> rejected", async () => {
        const root = tmpRoot("wf-goto-unknown")
        const sid = "ses_wf_gu"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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

        const result = await teamWorkflowTool(makeCtx(root)).execute(
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

        const result = await teamWorkflowTool(makeCtx(root)).execute(
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

        const result = await teamWorkflowTool(makeCtx(root)).execute(
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

        const result = await teamWorkflowTool(makeCtx(root)).execute(
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

        const result = await teamWorkflowTool(makeCtx(root)).execute(
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

        const result = await teamWorkflowTool(makeCtx(root)).execute(
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

        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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
        const result = await teamWorkflowTool(makeCtx(root)).execute(
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

    test("unknown gate verifier -> rejected", async () => {
        const root = tmpRoot("wf-unknownverifier")
        const sid = "ses_wf_uv"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx(root)).execute(
            { team_id: "alpha", steps: [{ kind: "task", member: "alice", task: "do x" }, { kind: "gate", verifier: "bob", criteria: "ok" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("unknown member")
    })

    test("signoff_decider not a member -> rejected", async () => {
        const root = tmpRoot("wf-sd")
        const sid = "ses_wf_sd"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamWorkflowTool(makeCtx(root)).execute(
            { team_id: "alpha", steps: [{ kind: "task", member: "alice", task: "do x" }], signoff_policy: "decider", signoff_decider: "bob" },
            makeToolContext(sid),
        )
        expect(result).toContain("not a member")
    })
})

// -----------------------------------------------------------------------
// team_loop
// -----------------------------------------------------------------------
describe("team_loop startup validation", () => {
    test("non-master → rejected", async () => {
        const root = tmpRoot("loop-nomaster")
        const masterSid = "ses_loop_m"
        const memberSid = "ses_loop_a"
        tracked.push(masterSid, memberSid)
        await setupTeam(root, masterSid, [makeMember("alice", memberSid)], Date.now())
        const result = await teamLoopTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "code" }], decider: "alice", max_rounds: 3, initial_task: "start" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("master-only")
    })

    test("inactive team → rejected", async () => {
        const root = tmpRoot("loop-inactive")
        const sid = "ses_loop_inact"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, undefined)
        const result = await teamLoopTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "code" }], decider: "alice", max_rounds: 3, initial_task: "start" },
            makeToolContext(sid),
        )
        expect(result).toContain("Error")
    })

    test("already busy → rejected", async () => {
        const root = tmpRoot("loop-busy")
        const sid = "ses_loop_busy"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        await setBusy(root, sid, "loop")
        const result = await teamLoopTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "code" }], decider: "alice", max_rounds: 3, initial_task: "start" },
            makeToolContext(sid),
        )
        expect(result).toContain("already has an active orchestration")
    })

    test("decider = 'master' → rejected", async () => {
        const root = tmpRoot("loop-dmaster")
        const sid = "ses_loop_dm"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        const result = await teamLoopTool(makeCtx(root)).execute(
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
        const result = await teamLoopTool(makeCtx(root)).execute(
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
        const result = await teamLoopTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "bob", task: "code" }], decider: "alice", max_rounds: 3, initial_task: "start" },
            makeToolContext(sid),
        )
        expect(result).toContain("unknown member")
    })
})

// -----------------------------------------------------------------------
// team_delegate
// -----------------------------------------------------------------------
describe("team_delegate startup validation", () => {
    test("non-master → rejected", async () => {
        const root = tmpRoot("del-nomaster")
        const masterSid = "ses_del_m"
        const memberSid = "ses_del_a"
        tracked.push(masterSid, memberSid)
        await setupTeam(root, masterSid, [makeMember("alice", memberSid)], Date.now())
        const result = await teamDelegateTool(makeCtx(root)).execute(
            { team_id: "alpha", tasks: [{ subject: "t1", description: "d" }] },
            makeToolContext(memberSid),
        )
        expect(result).toContain("master-only")
    })

    test("inactive team → rejected", async () => {
        const root = tmpRoot("del-inactive")
        const sid = "ses_del_inact"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, undefined)
        const result = await teamDelegateTool(makeCtx(root)).execute(
            { team_id: "alpha", tasks: [{ subject: "t1", description: "d" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("Error")
    })

    test("already busy → rejected", async () => {
        const root = tmpRoot("del-busy")
        const sid = "ses_del_busy"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        await setBusy(root, sid, "delegate")
        const result = await teamDelegateTool(makeCtx(root)).execute(
            { team_id: "alpha", tasks: [{ subject: "t1", description: "d" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("already has an active orchestration")
    })

    test("unknown blockedBy ref → rejected", async () => {
        const root = tmpRoot("del-ref")
        const sid = "ses_del_ref"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        const result = await teamDelegateTool(makeCtx(root)).execute(
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

    test("signoff_decider not a member → rejected", async () => {
        const root = tmpRoot("del-sd")
        const sid = "ses_del_sd"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamDelegateTool(makeCtx(root)).execute(
            {
                team_id: "alpha",
                tasks: [{ subject: "s1", description: "d1" }],
                signoff_policy: "decider",
                signoff_decider: "bob",
            },
            makeToolContext(sid),
        )
        expect(result).toContain("not a member")
    })
})

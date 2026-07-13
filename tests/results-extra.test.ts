/**
 * Coverage-gap tests for src/tools/query/results.ts — the member-output-missing and
 * tasks-rendering branches (lines 88-95, 128, 130-131) that review-fixes.test.ts
 * doesn't reach.
 */
import fs from "node:fs/promises"

import { afterAll, describe, expect, test } from "bun:test"

import type { RunRecord } from "../src/core/types.js"
import { teamResultGetTool } from "../src/tools/query/results.js"
import { initTeamState, invalidateTeam } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { runDir, runRecordPath, teamDir } from "../src/state/paths.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

/** Write a RunRecord to disk so results tools can read it. */
async function writeRunRecord(
    teamDirectory: string,
    record: RunRecord,
): Promise<void> {
    const dir = runDir(teamDirectory, record.runId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(runRecordPath(teamDirectory, record.runId), JSON.stringify(record, null, 2), "utf8")
}

async function setupTeam(root: string, sid: string, memberSid: string) {
    const state = makeState("alpha", sid, [makeMember("alice", memberSid)], Date.now())
    const team = await initTeamState(root, state, sid)
    await rebuildSessionIndex(root, `${root}__user_unused`)
    return team
}

describe("team_result_get: member output paths", () => {
    test("member= with name not in memberOutputs → error", async () => {
        const root = tmpRoot("res-ghost")
        const sid = "ses_res_ghost"
        const memberSid = "ses_res_ghost_alice"
        const team = await setupTeam(root, sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)
        await writeRunRecord(tdir, {
            version: 1,
            runId: "run-1",
            teamRunId: "run-alpha-sid",
            teamName: "alpha",
            type: "parallel",
            mode: "isolated",
            status: "completed",
            reason: "completed",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            memberOutputs: { alice: { bytes: 10, file: "alice.md" } },
        } as RunRecord)

        const result = await teamResultGetTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "run-1", member: "ghost" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("no output")
        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession(memberSid)
    })

    test("member= output file missing on disk → error", async () => {
        const root = tmpRoot("res-missing")
        const sid = "ses_res_missing"
        const memberSid = "ses_res_missing_alice"
        const team = await setupTeam(root, sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)
        await writeRunRecord(tdir, {
            version: 1,
            runId: "run-2",
            teamRunId: "run-alpha-sid",
            teamName: "alpha",
            type: "parallel",
            mode: "isolated",
            status: "completed",
            reason: "completed",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            memberOutputs: { alice: { bytes: 10, file: "alice.md" } },
        } as RunRecord)
        // Intentionally do NOT create the alice.md output file.

        const result = await teamResultGetTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "run-2", member: "alice" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("missing")
        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession(memberSid)
    })
})

describe("team_result_get: tasks rendering", () => {
    test("tasks with owner → @owner in output", async () => {
        const root = tmpRoot("res-task-owner")
        const sid = "ses_res_task_owner"
        const memberSid = "ses_res_task_owner_alice"
        const team = await setupTeam(root, sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)
        await writeRunRecord(tdir, {
            version: 1,
            runId: "run-3",
            teamRunId: "run-alpha-sid",
            teamName: "alpha",
            type: "delegate",
            status: "completed",
            reason: "completed",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            memberOutputs: {},
            tasks: [{ id: "t1", subject: "do thing", status: "completed", owner: "alice" }],
        } as unknown as RunRecord)

        const result = await teamResultGetTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "run-3" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("@alice")
        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession(memberSid)
    })

    test("tasks without owner → no @ in task line", async () => {
        const root = tmpRoot("res-task-noowner")
        const sid = "ses_res_task_noowner"
        const memberSid = "ses_res_task_noowner_alice"
        const team = await setupTeam(root, sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)
        await writeRunRecord(tdir, {
            version: 1,
            runId: "run-4",
            teamRunId: "run-alpha-sid",
            teamName: "alpha",
            type: "delegate",
            status: "completed",
            reason: "completed",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            memberOutputs: {},
            tasks: [{ id: "t2", subject: "unclaimed work", status: "pending" }],
        } as RunRecord)

        const result = await teamResultGetTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "run-4" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("unclaimed work")
        // Task line should not have @owner (the task line starts with "- [")
        const taskLine = result.split("\n").find(l => l.includes("unclaimed work"))
        expect(taskLine).toBeDefined()
        expect(taskLine!).not.toContain("@")
        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession(memberSid)
    })
})

describe("team_result_get: workflow branch tree rendering", () => {
    test("renders fanout branches nested under fanout plus a join line", async () => {
        const root = tmpRoot("res-workflow-branch-tree")
        const sid = "ses_res_workflow_branch_tree"
        const memberSid = "ses_res_workflow_branch_tree_alice"
        const team = await setupTeam(root, sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)
        await writeRunRecord(tdir, {
            version: 1,
            runId: "run-workflow-tree",
            teamRunId: "run-alpha-sid",
            teamName: "alpha",
            type: "workflow",
            status: "completed",
            reason: "workflow_complete",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            memberOutputs: {},
            workflow: {
                steps: [
                    { index: 0, step: 1, kind: "task", member: "lead", completed: true, output: "setup", outputBytes: 5 },
                    {
                        index: 1,
                        step: 2,
                        kind: "fanout",
                        completed: true,
                        fanout: {
                            branchIds: ["api", "docs"],
                            branchRanges: [{ startIndex: 2, endIndex: 3 }, { startIndex: 4, endIndex: 5 }],
                            joinIndex: 6,
                            maxErrored: 1,
                        },
                        branchStatuses: { api: "completed", docs: "errored" },
                    },
                    {
                        index: 2,
                        step: 3,
                        kind: "task",
                        member: "alice",
                        completed: true,
                        output: "api output",
                        outputBytes: 10,
                        branch: { fanoutIndex: 1, branchId: "api", branchIndex: 0, joinIndex: 6 },
                    },
                    {
                        index: 3,
                        step: 4,
                        kind: "gate",
                        verifier: "bob",
                        targetStep: 3,
                        completed: true,
                        verdict: "PASS",
                        branch: { fanoutIndex: 1, branchId: "api", branchIndex: 0, joinIndex: 6 },
                    },
                    {
                        index: 4,
                        step: 5,
                        kind: "task",
                        member: "carol",
                        completed: true,
                        output: "docs output",
                        outputBytes: 11,
                        branch: { fanoutIndex: 1, branchId: "docs", branchIndex: 1, joinIndex: 6 },
                    },
                    {
                        index: 5,
                        step: 6,
                        kind: "gate",
                        verifier: "dave",
                        targetStep: 5,
                        completed: true,
                        verdict: "FAIL",
                        branch: { fanoutIndex: 1, branchId: "docs", branchIndex: 1, joinIndex: 6 },
                    },
                    {
                        index: 6,
                        step: 7,
                        kind: "join",
                        completed: true,
                        joinedOutputBytes: 21,
                        join: {
                            fanoutIndex: 1,
                            branchTailIndices: [3, 5],
                            maxErrored: 1,
                            survivorBranchIds: ["api"],
                            erroredBranchIds: ["docs"],
                        },
                        branchStatuses: { api: "completed", docs: "errored" },
                    },
                ],
            },
        } as RunRecord)

        const result = await teamResultGetTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "run-workflow-tree" },
            makeToolContext(memberSid),
        )

        expect(result).toContain("- Step 2: [fanout] branches api, docs -> join step 7")
        expect(result).toContain("  - Branch api [completed] steps 3-4")
        expect(result).toContain("    - Step 3: [task] alice (done) (10 bytes)")
        expect(result).toContain("  - Branch docs [errored] steps 5-6")
        expect(result).toContain("    - Step 6: [gate] dave verifies step 5 -> FAIL")
        expect(result).toContain("- Step 7: [join] fanout step 2 branches api:completed, docs:errored (joined 21 bytes)")
        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession(memberSid)
    })

    test("renders fanout join policy metadata when persisted", async () => {
        const root = tmpRoot("res-workflow-policy")
        const sid = "ses_res_workflow_policy"
        const memberSid = "ses_res_workflow_policy_alice"
        const team = await setupTeam(root, sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)
        await writeRunRecord(tdir, {
            version: 1,
            runId: "run-workflow-policy",
            teamRunId: "run-alpha-sid",
            teamName: "alpha",
            type: "workflow",
            status: "completed",
            reason: "workflow_complete",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            memberOutputs: {},
            workflow: {
                steps: [
                    {
                        index: 0,
                        step: 1,
                        kind: "fanout",
                        completed: true,
                        fanout: {
                            branchIds: ["api", "docs"],
                            branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }],
                            joinIndex: 3,
                            maxErrored: 0,
                            joinPolicy: "reduce",
                            reducerMember: "dave",
                        },
                    },
                    { index: 1, step: 2, kind: "task", member: "alice", completed: true, branch: { fanoutIndex: 0, branchId: "api", branchIndex: 0, joinIndex: 3 } },
                    { index: 2, step: 3, kind: "task", member: "carol", completed: true, branch: { fanoutIndex: 0, branchId: "docs", branchIndex: 1, joinIndex: 3 } },
                    { index: 3, step: 4, kind: "join", completed: true, join: { fanoutIndex: 0, branchTailIndices: [1, 2], maxErrored: 0, survivorBranchIds: ["api", "docs"] } },
                    {
                        index: 4,
                        step: 5,
                        kind: "fanout",
                        completed: true,
                        fanout: {
                            branchIds: ["linux", "mac"],
                            branchRanges: [{ startIndex: 5, endIndex: 5 }, { startIndex: 6, endIndex: 6 }],
                            joinIndex: 7,
                            maxErrored: 0,
                            joinPolicy: "quorum",
                            quorum: 0.5,
                        },
                    },
                    { index: 5, step: 6, kind: "task", member: "alice", completed: true, branch: { fanoutIndex: 4, branchId: "linux", branchIndex: 0, joinIndex: 7 } },
                    { index: 6, step: 7, kind: "task", member: "carol", completed: true, branch: { fanoutIndex: 4, branchId: "mac", branchIndex: 1, joinIndex: 7 } },
                    { index: 7, step: 8, kind: "join", completed: true, join: { fanoutIndex: 4, branchTailIndices: [5, 6], maxErrored: 0, survivorBranchIds: ["linux", "mac"] } },
                ],
            },
        } as RunRecord)

        const result = await teamResultGetTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "run-workflow-policy" },
            makeToolContext(memberSid),
        )

        expect(result).toContain("join_policy=reduce")
        expect(result).toContain("reducer_member=dave")
        expect(result).toContain("join_policy=quorum")
        expect(result).toContain("quorum=0.5")
        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession(memberSid)
    })

    test("renders workflow step duration when persisted", async () => {
        const root = tmpRoot("res-workflow-duration")
        const sid = "ses_res_workflow_duration"
        const memberSid = "ses_res_workflow_duration_alice"
        const team = await setupTeam(root, sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)
        await writeRunRecord(tdir, {
            version: 1,
            runId: "run-workflow-duration",
            teamRunId: "run-alpha-sid",
            teamName: "alpha",
            type: "workflow",
            status: "completed",
            reason: "workflow_complete",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            memberOutputs: {},
            workflow: {
                steps: [
                    { index: 0, step: 1, kind: "task", member: "alice", completed: true, output: "done", outputBytes: 4, startedAt: 1000, completedAt: 1025, durationMs: 25 },
                ],
            },
        } as RunRecord)

        const result = await teamResultGetTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "run-workflow-duration" },
            makeToolContext(memberSid),
        )

        expect(result).toContain("duration=25ms")
        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession(memberSid)
    })

    test("format=mermaid renders persisted workflow structure", async () => {
        const root = tmpRoot("res-workflow-mermaid")
        const sid = "ses_res_workflow_mermaid"
        const memberSid = "ses_res_workflow_mermaid_alice"
        const team = await setupTeam(root, sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)
        await writeRunRecord(tdir, {
            version: 1,
            runId: "run-workflow-mermaid",
            teamRunId: "run-alpha-sid",
            teamName: "alpha",
            type: "workflow",
            status: "completed",
            reason: "workflow_complete",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            memberOutputs: {},
            workflow: {
                steps: [
                    { index: 0, step: 1, kind: "task", member: "lead", completed: true, output: "setup", outputBytes: 5 },
                    {
                        index: 1,
                        step: 2,
                        kind: "fanout",
                        completed: true,
                        fanout: {
                            branchIds: ["api", "docs"],
                            branchRanges: [{ startIndex: 2, endIndex: 3 }, { startIndex: 4, endIndex: 4 }],
                            joinIndex: 5,
                            maxErrored: 0,
                            joinPolicy: "select",
                            reducerMember: "dave",
                        },
                    },
                    { index: 2, step: 3, kind: "task", member: "alice", completed: true, branch: { fanoutIndex: 1, branchId: "api", branchIndex: 0, joinIndex: 5 } },
                    { index: 3, step: 4, kind: "gate", verifier: "bob", targetStep: 3, completed: true, verdict: "PASS", branch: { fanoutIndex: 1, branchId: "api", branchIndex: 0, joinIndex: 5 } },
                    { index: 4, step: 5, kind: "task", member: "carol", completed: true, branch: { fanoutIndex: 1, branchId: "docs", branchIndex: 1, joinIndex: 5 } },
                    { index: 5, step: 6, kind: "join", completed: true, join: { fanoutIndex: 1, branchTailIndices: [3, 4], maxErrored: 0, joinPolicy: "select", reducerMember: "dave", selectedBranchId: "api", selectionRationale: "best" } },
                ],
            },
        } as RunRecord)

        const result = await teamResultGetTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "run-workflow-mermaid", format: "mermaid" },
            makeToolContext(memberSid),
        )

        expect(result).toContain("flowchart TD")
        expect(result).toContain("subgraph branch_1_0_api")
        expect(result).toContain("s2 --> s3")
        expect(result).toContain("s3 -. verifies .-> s4")
        expect(result).toContain("s3 --> s4")
        expect(result).toContain("s4 --> s6")
        expect(result).toContain("selected api")
        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession(memberSid)
    })

    test("dispatchedActor overrides declared member/verifier in both text and mermaid output", async () => {
        const root = tmpRoot("res-workflow-dispatched-actor")
        const sid = "ses_res_workflow_dispatched_actor"
        const memberSid = "ses_res_workflow_dispatched_actor_lead"
        const team = await setupTeam(root, sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)
        await writeRunRecord(tdir, {
            version: 1,
            runId: "run-dispatched-actor",
            teamRunId: "run-alpha-sid",
            teamName: "alpha",
            type: "workflow",
            status: "completed",
            reason: "workflow_complete",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            memberOutputs: {},
            workflow: {
                steps: [
                    { index: 0, step: 1, kind: "task", member: "alice", dispatchedActor: "bob", completed: true, output: "ran by fallback", outputBytes: 14 },
                    { index: 1, step: 2, kind: "gate", verifier: "carol", dispatchedActor: "dave", targetStep: 1, completed: true, verdict: "PASS" },
                ],
            },
        } as RunRecord)

        const textResult = await teamResultGetTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "run-dispatched-actor" },
            makeToolContext(memberSid),
        )
        // text format shows the actual dispatched actor, not the declared primary
        expect(textResult).toContain("[task] bob")
        expect(textResult).not.toContain("[task] alice")
        expect(textResult).toContain("[gate] dave")
        expect(textResult).not.toContain("[gate] carol")

        const mermaidResult = await teamResultGetTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "run-dispatched-actor", format: "mermaid" },
            makeToolContext(memberSid),
        )
        expect(mermaidResult).toContain("task: bob")
        expect(mermaidResult).not.toContain("task: alice")
        expect(mermaidResult).toContain("gate: dave")
        expect(mermaidResult).not.toContain("gate: carol")

        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession(memberSid)
    })
})

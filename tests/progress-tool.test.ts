/**
 * Coverage-gap regression tests for teamProgressTool.execute
 * (src/tools/progress.ts). Audit 2026-06-30 finding #6: 29.07% line coverage
 * on the execute body. formatSnapshot / formatTimeline have implicit coverage
 * via team_details and result-get, but the tool's execute() — auth, path-
 * traversal check, runId resolution, since/limit pagination — had none.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"

import type { ActiveTask, MemberState, RunEvent, TeamState } from "../src/core/types.js"
import { teamProgressTool } from "../src/tools/progress.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { appendJsonl } from "../src/state/locks.js"
import { runEventsPath } from "../src/state/paths.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"

const TEAM = "progress-team"

afterAll(cleanupTmpRoots)
const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

function makeActiveTask(): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
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
        runId: "run-active-1",
    } as ActiveTask
}

async function setup(opts: {
    root: string
    masterSid: string
    members: MemberState[]
    activeTask?: ActiveTask
}): Promise<string> {
    const base = makeState(TEAM, opts.masterSid, opts.members, Date.now())
    const state: TeamState = {
        ...base,
        status: opts.activeTask ? "busy" : base.status,
        activeTask: opts.activeTask,
    }
    await initTeamState(opts.root, state, opts.masterSid)
    await rebuildSessionIndex(opts.root, `${opts.root}__unused`)
    const team = await loadTeamState(opts.root, TEAM, opts.masterSid)
    return team.directory
}

async function seedEvents(directory: string, runId: string, events: RunEvent[]): Promise<void> {
    for (const e of events) {
        await appendJsonl(runEventsPath(directory, runId), JSON.stringify(e) + "\n")
    }
}

describe("teamProgressTool.execute", () => {
    test("non-member → error", async () => {
        const root = tmpRoot("prog-non-member")
        const masterSid = "ses_prog_master_1"
        tracked.push(masterSid)
        await setup({ root, masterSid, members: [] })

        const result = await teamProgressTool(makeCtx(root)).execute(
            { team_id: TEAM },
            { sessionID: "ses_stranger_prog" } as never,
        )
        expect(result).toContain("not a member")
    })

    test("invalid run_id (path traversal) → rejected", async () => {
        const root = tmpRoot("prog-traversal")
        const masterSid = "ses_prog_master_2"
        tracked.push(masterSid)
        await setup({ root, masterSid, members: [] })

        const result = await teamProgressTool(makeCtx(root)).execute(
            { team_id: TEAM, run_id: "../escape" },
            { sessionID: masterSid } as never,
        )
        expect(result).toContain("invalid run_id")
    })

    test("no active task and no run records → 'no runs yet'", async () => {
        const root = tmpRoot("prog-empty")
        const masterSid = "ses_prog_master_3"
        tracked.push(masterSid)
        await setup({ root, masterSid, members: [] })

        const result = await teamProgressTool(makeCtx(root)).execute(
            { team_id: TEAM },
            { sessionID: masterSid } as never,
        )
        expect(result).toContain("Team: progress-team")
        expect(result).toContain("Active: none")
        expect(result).toContain("no runs yet")
    })

    test("happy path with active task → snapshot + timeline from active runId", async () => {
        const root = tmpRoot("prog-active")
        const masterSid = "ses_prog_master_4"
        tracked.push(masterSid)
        const dir = await setup({
            root,
            masterSid,
            members: [makeMember("alice", "ses_prog_alice_4")],
            activeTask: makeActiveTask(),
        })
        await seedEvents(dir, "run-active-1", [
            { timestamp: Date.now() - 1000, kind: "dispatched", member: "alice" },
            { timestamp: Date.now(), kind: "captured", member: "alice", bytes: 42 },
        ])

        const result = await teamProgressTool(makeCtx(root)).execute(
            { team_id: TEAM },
            { sessionID: masterSid } as never,
        )
        expect(result).toContain("Active: parallel/isolated")
        expect(result).toContain("Members:")
        expect(result).toContain("alice")
        expect(result).toContain("dispatched")
        expect(result).toContain("captured")
    })

    test("active workflow displays one-based step progress and timeline stages", async () => {
        const root = tmpRoot("prog-workflow-step")
        const masterSid = "ses_prog_master_wf"
        tracked.push(masterSid)
        const workflowTask: ActiveTask = {
            ...makeActiveTask(),
            type: "workflow",
            mode: undefined,
            currentStageIndex: 1,
            steps: [
                { kind: "task", member: "alice", task: "draft", completed: true, output: "draft" },
                { kind: "gate", verifier: "bob", criteria: "ok", completed: false, startedAt: Date.now() - 1000 },
            ],
        } as ActiveTask
        const dir = await setup({
            root,
            masterSid,
            members: [makeMember("alice", "ses_prog_alice_wf"), makeMember("bob", "ses_prog_bob_wf")],
            activeTask: workflowTask,
        })
        await seedEvents(dir, "run-active-1", [
            { timestamp: Date.now(), kind: "verdict", member: "bob", stage: 1, detail: "PASS" },
        ])

        const result = await teamProgressTool(makeCtx(root)).execute(
            { team_id: TEAM },
            { sessionID: masterSid } as never,
        )

        expect(result).toContain("Active: workflow  step 2/2")
        expect(result).toContain("elapsed=")
        expect(result).toContain("stage 2")
    })

    test("active workflow renders live mermaid with active step status", async () => {
        const root = tmpRoot("prog-workflow-mermaid")
        const masterSid = "ses_prog_master_wf_mermaid"
        tracked.push(masterSid)
        const workflowTask: ActiveTask = {
            ...makeActiveTask(),
            type: "workflow",
            mode: undefined,
            currentStageIndex: 1,
            steps: [
                { kind: "task", member: "alice", task: "draft", completed: true, output: "draft" },
                { kind: "gate", verifier: "bob", criteria: "ok", targetStepIndex: 0, completed: false },
                { kind: "task", member: "carol", task: "ship", completed: false },
            ],
        } as ActiveTask
        await setup({
            root,
            masterSid,
            members: [makeMember("alice", "ses_prog_alice_wfm"), makeMember("bob", "ses_prog_bob_wfm")],
            activeTask: workflowTask,
        })

        const result = await teamProgressTool(makeCtx(root)).execute(
            { team_id: TEAM, format: "mermaid" },
            { sessionID: masterSid } as never,
        )

        expect(result).toContain("flowchart TD")
        expect(result).toContain("s1 -. verifies .-> s2")
        expect(result).toContain("class s1 done;")
        expect(result).toContain("class s2 active;")
        expect(result).toContain("class s3 pending;")
        expect(result).not.toContain("Timeline:")
        expect(result).not.toContain("Members:")
    })

    test("active workflow fanout displays branch frontier instead of the fanout marker", async () => {
        const root = tmpRoot("prog-workflow-frontier")
        const masterSid = "ses_prog_master_frontier"
        tracked.push(masterSid)
        const workflowTask: ActiveTask = {
            ...makeActiveTask(),
            type: "workflow",
            mode: undefined,
            currentStageIndex: 1,
            activeStepIndices: [2, 4],
            steps: [
                { kind: "task", member: "lead", task: "setup", completed: true, output: "setup" },
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "docs"],
                        branchRanges: [{ startIndex: 2, endIndex: 3 }, { startIndex: 4, endIndex: 5 }],
                        joinIndex: 6,
                        maxErrored: 1,
                    },
                },
                {
                    kind: "task",
                    member: "alice",
                    task: "api impl",
                    completed: false,
                    branch: { fanoutIndex: 1, branchId: "api", branchIndex: 0, joinIndex: 6 },
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "api ok",
                    completed: false,
                    branch: { fanoutIndex: 1, branchId: "api", branchIndex: 0, joinIndex: 6 },
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "docs impl",
                    completed: false,
                    branch: { fanoutIndex: 1, branchId: "docs", branchIndex: 1, joinIndex: 6 },
                },
                {
                    kind: "gate",
                    verifier: "dave",
                    criteria: "docs ok",
                    completed: false,
                    branch: { fanoutIndex: 1, branchId: "docs", branchIndex: 1, joinIndex: 6 },
                },
                {
                    kind: "join",
                    completed: false,
                    join: { fanoutIndex: 1, branchTailIndices: [3, 5], maxErrored: 1 },
                },
            ],
        } as ActiveTask
        const dir = await setup({
            root,
            masterSid,
            members: [makeMember("alice", "ses_prog_alice_frontier"), makeMember("carol", "ses_prog_carol_frontier")],
            activeTask: workflowTask,
        })
        await seedEvents(dir, "run-active-1", [
            { timestamp: Date.now(), kind: "dispatched", member: "alice", stage: 2 },
            { timestamp: Date.now() + 1, kind: "dispatched", member: "carol", stage: 4 },
        ])

        const result = await teamProgressTool(makeCtx(root)).execute(
            { team_id: TEAM },
            { sessionID: masterSid } as never,
        )

        expect(result).toContain("Active: workflow  frontier api: step 3/7, docs: step 5/7")
        expect(result).not.toContain("join_policy=")
        expect(result).not.toContain("Active: workflow  step 2/7")
    })

    test("active workflow fanout renders live mermaid branch frontier statuses", async () => {
        const root = tmpRoot("prog-workflow-frontier-mermaid")
        const masterSid = "ses_prog_master_frontier_mermaid"
        tracked.push(masterSid)
        const workflowTask: ActiveTask = {
            ...makeActiveTask(),
            type: "workflow",
            mode: undefined,
            currentStageIndex: 1,
            activeStepIndices: [2, 4],
            steps: [
                { kind: "task", member: "lead", task: "setup", completed: true, output: "setup" },
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "docs"],
                        branchRanges: [{ startIndex: 2, endIndex: 3 }, { startIndex: 4, endIndex: 5 }],
                        joinIndex: 6,
                        maxErrored: 1,
                    },
                },
                { kind: "task", member: "alice", task: "api impl", completed: false, branch: { fanoutIndex: 1, branchId: "api", branchIndex: 0, joinIndex: 6 } },
                { kind: "gate", verifier: "bob", criteria: "api ok", completed: false, branch: { fanoutIndex: 1, branchId: "api", branchIndex: 0, joinIndex: 6 } },
                { kind: "task", member: "carol", task: "docs impl", completed: false, branch: { fanoutIndex: 1, branchId: "docs", branchIndex: 1, joinIndex: 6 } },
                { kind: "gate", verifier: "dave", criteria: "docs ok", completed: false, branch: { fanoutIndex: 1, branchId: "docs", branchIndex: 1, joinIndex: 6 } },
                { kind: "join", completed: false, join: { fanoutIndex: 1, branchTailIndices: [3, 5], maxErrored: 1 } },
            ],
        } as ActiveTask
        await setup({
            root,
            masterSid,
            members: [makeMember("alice", "ses_prog_alice_wffm"), makeMember("carol", "ses_prog_carol_wffm")],
            activeTask: workflowTask,
        })

        const result = await teamProgressTool(makeCtx(root)).execute(
            { team_id: TEAM, format: "mermaid" },
            { sessionID: masterSid } as never,
        )

        expect(result).toContain("subgraph branch_1_0_api")
        expect(result).toContain("subgraph branch_1_1_docs")
        expect(result).toContain("class s1,s2 done;")
        expect(result).toContain("class s3,s5 active;")
        expect(result).toContain("class s4,s6,s7 pending;")
        expect(result).not.toContain("Timeline:")
    })

    test("active workflow fanout displays the active join policy", async () => {
        const root = tmpRoot("prog-workflow-frontier-policy")
        const masterSid = "ses_prog_master_frontier_policy"
        tracked.push(masterSid)
        const workflowTask: ActiveTask = {
            ...makeActiveTask(),
            type: "workflow",
            mode: undefined,
            currentStageIndex: 1,
            activeStepIndices: [2, 4],
            steps: [
                { kind: "task", member: "lead", task: "setup", completed: true, output: "setup" },
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "docs"],
                        branchRanges: [{ startIndex: 2, endIndex: 3 }, { startIndex: 4, endIndex: 5 }],
                        joinIndex: 6,
                        maxErrored: 0,
                        joinPolicy: "quorum",
                        quorum: 0.5,
                    },
                },
                { kind: "task", member: "alice", task: "api impl", completed: false, branch: { fanoutIndex: 1, branchId: "api", branchIndex: 0, joinIndex: 6 } },
                { kind: "gate", verifier: "bob", criteria: "api ok", completed: false, branch: { fanoutIndex: 1, branchId: "api", branchIndex: 0, joinIndex: 6 } },
                { kind: "task", member: "carol", task: "docs impl", completed: false, branch: { fanoutIndex: 1, branchId: "docs", branchIndex: 1, joinIndex: 6 } },
                { kind: "gate", verifier: "dave", criteria: "docs ok", completed: false, branch: { fanoutIndex: 1, branchId: "docs", branchIndex: 1, joinIndex: 6 } },
                { kind: "join", completed: false, join: { fanoutIndex: 1, branchTailIndices: [3, 5], maxErrored: 0, joinPolicy: "quorum", quorum: 0.5 } },
            ],
        } as ActiveTask
        const dir = await setup({
            root,
            masterSid,
            members: [makeMember("alice", "ses_prog_alice_policy"), makeMember("carol", "ses_prog_carol_policy")],
            activeTask: workflowTask,
        })
        await seedEvents(dir, "run-active-1", [
            { timestamp: Date.now(), kind: "dispatched", member: "alice", stage: 2 },
        ])

        const result = await teamProgressTool(makeCtx(root)).execute(
            { team_id: TEAM },
            { sessionID: masterSid } as never,
        )

        expect(result).toContain("Active: workflow  frontier api: step 3/7, docs: step 5/7 join_policy=quorum")
    })

    test("format=mermaid requires an active workflow", async () => {
        const root = tmpRoot("prog-mermaid-no-workflow")
        const masterSid = "ses_prog_master_mermaid_no_workflow"
        tracked.push(masterSid)
        await setup({ root, masterSid, members: [] })

        const idleResult = await teamProgressTool(makeCtx(root)).execute(
            { team_id: TEAM, format: "mermaid" },
            { sessionID: masterSid } as never,
        )
        expect(idleResult).toContain("requires an in-progress team_workflow")

        const activeRoot = tmpRoot("prog-mermaid-parallel")
        const activeMasterSid = "ses_prog_master_mermaid_parallel"
        tracked.push(activeMasterSid)
        await setup({
            root: activeRoot,
            masterSid: activeMasterSid,
            members: [makeMember("alice", "ses_prog_alice_parallel")],
            activeTask: makeActiveTask(),
        })

        const parallelResult = await teamProgressTool(makeCtx(activeRoot)).execute(
            { team_id: TEAM, format: "mermaid" },
            { sessionID: activeMasterSid } as never,
        )
        expect(parallelResult).toContain("requires an in-progress team_workflow")
    })

    test("since filter excludes events at or before the timestamp", async () => {
        const root = tmpRoot("prog-since")
        const masterSid = "ses_prog_master_5"
        tracked.push(masterSid)
        const t0 = Date.now()
        const dir = await setup({
            root,
            masterSid,
            members: [],
            activeTask: makeActiveTask(),
        })
        await seedEvents(dir, "run-active-1", [
            { timestamp: t0, kind: "dispatched", member: "alice" },
            { timestamp: t0 + 500, kind: "captured", member: "alice" },
            { timestamp: t0 + 1000, kind: "errored", member: "alice" },
        ])

        const result = await teamProgressTool(makeCtx(root)).execute(
            { team_id: TEAM, since: t0 + 500 },
            { sessionID: masterSid } as never,
        )
        // Only the errored event is strictly after t0+500.
        expect(result).toContain("errored")
        expect(result).not.toContain("dispatched")
    })

    test("limit slices to the most-recent N events", async () => {
        const root = tmpRoot("prog-limit")
        const masterSid = "ses_prog_master_6"
        tracked.push(masterSid)
        const dir = await setup({
            root,
            masterSid,
            members: [],
            activeTask: makeActiveTask(),
        })
        // Seed 10 events.
        const events: RunEvent[] = []
        for (let i = 0; i < 10; i++) {
            events.push({ timestamp: Date.now() + i, kind: "captured", member: `m${i}` })
        }
        await seedEvents(dir, "run-active-1", events)

        const result = await teamProgressTool(makeCtx(root)).execute(
            { team_id: TEAM, limit: 3 },
            { sessionID: masterSid } as never,
        )
        // The header should mention "last 3 of 10".
        expect(result).toContain("last 3 of 10")
        // Only the last 3 members appear (m7, m8, m9).
        expect(result).toContain("m7")
        expect(result).toContain("m9")
        expect(result).not.toContain("m0")
        expect(result).not.toContain("m5")
    })
})

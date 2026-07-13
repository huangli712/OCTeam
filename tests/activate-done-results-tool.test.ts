/**
 * Coverage-gap regression tests for three tool handlers that previously had
 * NO direct execute() coverage (audit 2026-06-30 Context Mining finding):
 *   - teamActivateTool        (src/tools/lifecycle/activate.ts) — 0% handler covered
 *   - teamDoneTool            (src/tools/control/done.ts)     — 0% handler covered
 *   - teamResultsTool         (src/tools/query/results.ts)  — 0% handler covered
 *
 * Each tool's underlying logic (decideActivate, barrier mechanics, run-record
 * I/O) is tested elsewhere. These tests exercise the tool's execute() body
 * itself: auth gates, schema validation, error paths, happy path.
 */
import { afterEach, describe, expect, test } from "bun:test"

import type { ActiveTask, MemberState, RunRecord, TeamState } from "../src/core/types.js"
import { teamActivateTool } from "../src/tools/lifecycle/activate.js"
import { teamDoneTool } from "../src/tools/control/done.js"
import { teamResultGetTool, teamResultsTool } from "../src/tools/query/results.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { setActiveTeam } from "../src/state/resolve.js"
import { atomicWrite } from "../src/state/locks.js"
import { runDir, runRecordPath } from "../src/state/paths.js"
import path from "node:path"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"

const TEAM = "audit-cov-team"
const tracked: string[] = []

afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})
import { afterAll } from "bun:test"
afterAll(cleanupTmpRoots)

function makeActiveParallelTask(opts: { requireDoneAck?: boolean; mode?: "isolated" | "cooperative" } = {}): ActiveTask {
    return {
        type: "parallel",
        mode: opts.mode ?? "isolated",
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
        requireDoneAck: opts.requireDoneAck ?? false,
        runId: "run-test-1",
    } as ActiveTask
}

async function setupTeam(opts: {
    root: string
    masterSid: string
    members: MemberState[]
    activeTask?: ActiveTask
    activatedAt?: number
}): Promise<{ directory: string; state: TeamState }> {
    const base = makeState(TEAM, opts.masterSid, opts.members, opts.activatedAt)
    const state: TeamState = {
        ...base,
        status: opts.activeTask ? "busy" : base.status,
        activeTask: opts.activeTask,
    }
    await initTeamState(opts.root, state, opts.masterSid)
    await rebuildSessionIndex(opts.root, `${opts.root}__unused`)
    const team = await loadTeamState(opts.root, TEAM, opts.masterSid)
    return { directory: team.directory, state }
}

// =============================================================================
// teamActivateTool
// =============================================================================

describe("teamActivateTool.execute", () => {
    test("unknown team_id → not found error", async () => {
        const root = tmpRoot("act-unknown")
        const masterSid = "ses_act_master_2"
        tracked.push(masterSid)
        await setupTeam({ root, masterSid, members: [] })

        const result = await teamActivateTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: "no-such-team" },
            { sessionID: masterSid } as never,
        )
        expect(result).toContain("not found")
    })

    test("master activates successfully → state reflects activatedAt", async () => {
        const root = tmpRoot("act-happy")
        const masterSid = "ses_act_master_3"
        tracked.push(masterSid)
        const { state } = await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", "ses_act_alice_3")],
        })
        expect(state.activatedAt).toBeUndefined()

        const result = await teamActivateTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM },
            { sessionID: masterSid } as never,
        )
        expect(result).toContain("activated")

        const after = await loadTeamState(root, TEAM, masterSid)
        expect(after.activatedAt).not.toBeUndefined()
    })

    test("idempotent: activating the already-active team → noop message", async () => {
        const root = tmpRoot("act-idem")
        const masterSid = "ses_act_master_4"
        tracked.push(masterSid)
        await setupTeam({
            root,
            masterSid,
            members: [],
            activatedAt: Date.now(),
        })
        setActiveTeam(masterSid, path.join(root, masterSid, "teams", TEAM))

        const result = await teamActivateTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM },
            { sessionID: masterSid } as never,
        )
        expect(result).toContain("already the active team")
    })

    test("refuses when another team is already active (auto-switch disabled)", async () => {
        const root = tmpRoot("act-conflict")
        const masterSid = "ses_act_master_5"
        tracked.push(masterSid)
        // Create first team and activate it.
        await setupTeam({
            root,
            masterSid,
            members: [],
            activatedAt: Date.now(),
        })
        setActiveTeam(masterSid, path.join(root, masterSid, "teams", TEAM))

        // Create a second team in the same scope.
        const otherState = makeState("other-team", masterSid, [])
        await initTeamState(root, otherState, masterSid)

        const result = await teamActivateTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: "other-team" },
            { sessionID: masterSid } as never,
        )
        expect(result).toContain("currently active") // refuse message mentions existing active team
    })

    test("idempotent when stale sibling has activatedAt (idempotence takes precedence)", async () => {
        // Bug: targetIsAlreadyActive was AND'd with activeSibling===undefined, so if a
        // stale sibling still had activatedAt set, activating the already-active target
        // returned an error instead of a noop.
        const root = tmpRoot("act-stale-sibling")
        const masterSid = "ses_act_master_6"
        tracked.push(masterSid)
        // Create target team, already active
        await setupTeam({
            root,
            masterSid,
            members: [],
            activatedAt: Date.now(),
        })
        setActiveTeam(masterSid, path.join(root, masterSid, "teams", TEAM))

        // Create a stale sibling team that also has activatedAt set
        const staleState = makeState("stale-sibling", masterSid, [], Date.now())
        await initTeamState(root, staleState, masterSid)

        const result = await teamActivateTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM },
            { sessionID: masterSid } as never,
        )
        // Must be noop ("already the active team"), NOT an error about stale sibling
        expect(result).toContain("already the active team")
    })
})

// =============================================================================
// teamDoneTool
// =============================================================================

describe("teamDoneTool.execute", () => {
    test("caller not a team member → error", async () => {
        const root = tmpRoot("done-non-member")
        const masterSid = "ses_done_master_1"
        tracked.push(masterSid)
        await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", "ses_done_alice_1")],
            activeTask: makeActiveParallelTask({ requireDoneAck: true }),
        })

        const result = await teamDoneTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM },
            { sessionID: "ses_stranger_done_1" } as never,
        )
        expect(result).toContain("not a member of this team")
    })

    test("master caller → member-only error", async () => {
        const root = tmpRoot("done-master")
        const masterSid = "ses_done_master_2"
        tracked.push(masterSid)
        await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", "ses_done_alice_2")],
            activeTask: makeActiveParallelTask({ requireDoneAck: true }),
            activatedAt: Date.now(),
        })
        setActiveTeam(masterSid, path.join(root, masterSid, "teams", TEAM))

        const result = await teamDoneTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM },
            { sessionID: masterSid } as never,
        )
        expect(result).toContain("member-only")
    })

    test("no active task → error", async () => {
        const root = tmpRoot("done-no-task")
        const masterSid = "ses_done_master_3"
        const aliceSid = "ses_done_alice_3"
        tracked.push(masterSid, aliceSid)
        await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", aliceSid)],
        })

        const result = await teamDoneTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM },
            { sessionID: aliceSid } as never,
        )
        expect(result).toContain("nothing to acknowledge")
    })

    test("non-parallel active task → error", async () => {
        const root = tmpRoot("done-non-parallel")
        const masterSid = "ses_done_master_4"
        const aliceSid = "ses_done_alice_4"
        tracked.push(masterSid, aliceSid)
        const task = makeActiveParallelTask({ requireDoneAck: true })
        task.type = "pipeline" // mutate to non-parallel
        await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", aliceSid)],
            activeTask: task,
        })

        const result = await teamDoneTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM },
            { sessionID: aliceSid } as never,
        )
        expect(result).toContain("does not apply to pipeline")
    })

    test("parallel without require_done_ack → guidance error", async () => {
        const root = tmpRoot("done-no-ack")
        const masterSid = "ses_done_master_5"
        const aliceSid = "ses_done_alice_5"
        tracked.push(masterSid, aliceSid)
        await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", aliceSid)],
            activeTask: makeActiveParallelTask({ requireDoneAck: false }),
        })

        const result = await teamDoneTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM },
            { sessionID: aliceSid } as never,
        )
        expect(result).toContain("did not enable require_done_ack")
    })

    test("happy path: member acks → declaredDone=true, idempotent on second call", async () => {
        const root = tmpRoot("done-happy")
        const masterSid = "ses_done_master_6"
        const aliceSid = "ses_done_alice_6"
        tracked.push(masterSid, aliceSid)
        const { directory } = await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", aliceSid)],
            activeTask: makeActiveParallelTask({ requireDoneAck: true }),
        })

        const result1 = await teamDoneTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM },
            { sessionID: aliceSid } as never,
        )
        expect(result1).toContain("Acknowledged")

        const after1 = await loadTeamState(root, TEAM, masterSid)
        const alice = after1.members.find(m => m.name === "alice")!
        expect(alice.declaredDone).toBe(true)

        // Idempotent: second call returns "already acknowledged" wording.
        const result2 = await teamDoneTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM },
            { sessionID: aliceSid } as never,
        )
        expect(result2).toContain("Already acknowledged")

        // State unchanged on the no-op second call.
        const after2 = await loadTeamState(root, TEAM, masterSid)
        expect(after2.members.find(m => m.name === "alice")!.declaredDone).toBe(true)
        void directory
    })
})

// =============================================================================
// teamResultsTool + teamResultGetTool
// =============================================================================

async function seedRunRecord(
    directory: string,
    record: RunRecord,
): Promise<void> {
    const dir = runDir(directory, record.runId)
    await atomicWrite(runRecordPath(directory, record.runId), JSON.stringify(record))
    void dir
}

const SAMPLE_RUN: RunRecord = {
    version: 1,
    runId: "run-sample-1",
    teamRunId: "teamrun-test-1",
    teamName: TEAM,
    type: "parallel",
    mode: "isolated",
    status: "completed",
    reason: "parallel_complete:all_members_idle",
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now(),
    tokensUsed: 1234,
    tokensByMember: { alice: 1234 },
    messagesSent: 5,
    memberOutputs: {
        alice: { bytes: 100, file: "alice.md" },
    },
}

describe("teamResultsTool.execute", () => {
    test("non-member → error", async () => {
        const root = tmpRoot("res-non-member")
        const masterSid = "ses_res_master_1"
        tracked.push(masterSid)
        await setupTeam({ root, masterSid, members: [] })

        const result = await teamResultsTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM },
            { sessionID: "ses_stranger_res" } as never,
        )
        expect(result).toContain("not a member")
    })

    test("no run records → empty message", async () => {
        const root = tmpRoot("res-empty")
        const masterSid = "ses_res_master_2"
        tracked.push(masterSid)
        await setupTeam({ root, masterSid, members: [] })

        const result = await teamResultsTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM },
            { sessionID: masterSid } as never,
        )
        expect(result).toContain("No run records")
    })

    test("happy path: list returns one run with mode/status/reason", async () => {
        const root = tmpRoot("res-list")
        const masterSid = "ses_res_master_3"
        tracked.push(masterSid)
        const { directory } = await setupTeam({ root, masterSid, members: [] })
        await seedRunRecord(directory, SAMPLE_RUN)

        const result = await teamResultsTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM },
            { sessionID: masterSid } as never,
        )
        expect(result).toContain("run-sample-1")
        expect(result).toContain("parallel/isolated")
        expect(result).toContain("completed")
    })
})

describe("teamResultGetTool.execute", () => {
    test("invalid run_id (path traversal) → rejected", async () => {
        const root = tmpRoot("res-traversal")
        const masterSid = "ses_res_master_4"
        tracked.push(masterSid)
        await setupTeam({ root, masterSid, members: [] })

        const result = await teamResultGetTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, run_id: "../escape" },
            { sessionID: masterSid } as never,
        )
        expect(result).toContain("invalid run_id")
    })

    test("unknown run_id → not found error", async () => {
        const root = tmpRoot("res-missing")
        const masterSid = "ses_res_master_5"
        tracked.push(masterSid)
        await setupTeam({ root, masterSid, members: [] })

        const result = await teamResultGetTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, run_id: "no-such-run" },
            { sessionID: masterSid } as never,
        )
        expect(result).toContain("not found")
    })

    test("happy path: returns metadata header", async () => {
        const root = tmpRoot("res-get")
        const masterSid = "ses_res_master_6"
        tracked.push(masterSid)
        const { directory } = await setupTeam({ root, masterSid, members: [] })
        await seedRunRecord(directory, SAMPLE_RUN)

        const result = await teamResultGetTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, run_id: "run-sample-1" },
            { sessionID: masterSid } as never,
        )
        expect(result).toContain("Run run-sample-1")
        expect(result).toContain("parallel/isolated")
        expect(result).toContain("Reason: parallel_complete:all_members_idle")
    })

    test("workflow run renders per-step ledger", async () => {
        const root = tmpRoot("res-workflow-ledger")
        const masterSid = "ses_res_master_wf"
        tracked.push(masterSid)
        const { directory } = await setupTeam({ root, masterSid, members: [] })
        await seedRunRecord(directory, {
            ...SAMPLE_RUN,
            runId: "run-workflow-1",
            type: "workflow",
            mode: undefined,
            reason: "workflow_complete",
            workflow: {
                steps: [
                    { index: 0, step: 1, kind: "task", member: "alice", completed: true, output: "draft output", outputBytes: 12 },
                    { index: 1, step: 2, kind: "task", member: "carol", completed: true, output: "tests output", outputBytes: 12 },
                    { index: 2, step: 3, kind: "gate", verifier: "bob", targetStep: 1, targetSteps: [1, 2], verdict: "PASS", attempts: 1, completed: true },
                ],
            },
        })

        const result = await teamResultGetTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, run_id: "run-workflow-1" },
            { sessionID: masterSid } as never,
        )

        expect(result).toContain("### workflow steps")
        expect(result).toContain("Step 1: [task] alice")
        expect(result).toContain("draft output")
        expect(result).toContain("tests output")
        expect(result).toContain("Step 3: [gate] bob verifies steps 1, 2 -> PASS")
    })

    test("workflow run renders issues[] detail per gate step", async () => {
        const root = tmpRoot("res-workflow-issues")
        const masterSid = "ses_res_master_wf_issues"
        tracked.push(masterSid)
        const { directory } = await setupTeam({ root, masterSid, members: [] })
        await seedRunRecord(directory, {
            ...SAMPLE_RUN,
            runId: "run-workflow-issues",
            type: "workflow",
            mode: undefined,
            reason: "workflow_complete",
            workflow: {
                steps: [
                    { index: 0, step: 1, kind: "task", member: "alice", completed: true, output: "impl", outputBytes: 4 },
                    {
                        index: 1,
                        step: 2,
                        kind: "gate",
                        verifier: "bob",
                        targetStep: 1,
                        verdict: "PASS",
                        attempts: 1,
                        completed: true,
                        score: 7,
                        confidence: 0.85,
                        issues: [
                            { severity: "high", message: "missing edge case for empty input" },
                            { severity: "low", message: "typo in docstring" },
                            { severity: "critical" },
                        ],
                    },
                ],
            },
        })

        const result = await teamResultGetTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, run_id: "run-workflow-issues" },
            { sessionID: masterSid } as never,
        )

        // Compact inline metrics preserved.
        expect(result).toContain("score=7")
        expect(result).toContain("confidence=0.85")
        expect(result).toContain("issues=3")
        // Per-issue detail lines, severity-sorted (critical first, then high, then low).
        expect(result).toContain("critical")
        expect(result).toContain("missing edge case for empty input")
        expect(result).toContain("typo in docstring")
        // critical with no message renders its severity-only line, not a dangling colon.
        expect(result).toMatch(/critical\b[^\n]*$/m)
    })

    test("workflow run persists step static control config (approval_before/after, max_output_bytes)", async () => {
        const root = tmpRoot("res-workflow-controls")
        const masterSid = "ses_res_master_wf_ctrl"
        tracked.push(masterSid)
        const { directory } = await setupTeam({ root, masterSid, members: [] })
        await seedRunRecord(directory, {
            ...SAMPLE_RUN,
            runId: "run-workflow-controls",
            type: "workflow",
            mode: undefined,
            reason: "workflow_complete",
            workflow: {
                steps: [
                    {
                        index: 0,
                        step: 1,
                        kind: "task",
                        member: "alice",
                        completed: true,
                        output: "impl",
                        outputBytes: 4,
                        approvalBefore: true,
                        maxOutputBytes: 512,
                    },
                    {
                        index: 1,
                        step: 2,
                        kind: "gate",
                        verifier: "bob",
                        targetStep: 1,
                        verdict: "PASS",
                        attempts: 1,
                        completed: true,
                        approvalAfter: true,
                    },
                ],
            },
        })

        const result = await teamResultGetTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, run_id: "run-workflow-controls" },
            { sessionID: masterSid } as never,
        )

        // Static control config surfaces in the ledger for post-run audit.
        expect(result).toContain("approval_before")
        expect(result).toContain("approval_after")
        expect(result).toContain("max_output_bytes=512")
    })

    test("omitted run_id returns latest run", async () => {
        const root = tmpRoot("res-latest")
        const masterSid = "ses_res_master_7"
        tracked.push(masterSid)
        const { directory } = await setupTeam({ root, masterSid, members: [] })
        const older: RunRecord = { ...SAMPLE_RUN, runId: "run-older", finishedAt: SAMPLE_RUN.finishedAt - 1000 }
        const newer: RunRecord = { ...SAMPLE_RUN, runId: "run-newer", finishedAt: SAMPLE_RUN.finishedAt }
        await seedRunRecord(directory, older)
        await seedRunRecord(directory, newer)

        const result = await teamResultGetTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM },
            { sessionID: masterSid } as never,
        )
        // Newest first → run-newer should be returned.
        expect(result).toContain("Run run-newer")
    })
})

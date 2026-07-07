import { afterEach, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask, MemberState, WorkflowStep, WorkflowTask } from "../src/core/types.js"
import { checkWorkflowInvariants } from "../src/core/workflow-invariants.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import type { Team } from "../src/state/store.js"
import { teamFixWorkflowTool } from "../src/tools/workflow-fix.js"
import { makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"

type DispatchCall = { readonly sessionId: string; readonly text: string }

function makeCtx(root: string, calls: DispatchCall[] = []): PluginContext {
    return {
        storageRoot: root,
        scope: "project",
        directory: root,
        client: {
            session: {
                promptAsync: async (args: { readonly path: { readonly id: string }; readonly body: { readonly parts: readonly [{ readonly text: string }] } }) => {
                    calls.push({ sessionId: args.path.id, text: args.body.parts[0].text })
                    return { data: {} }
                },
            },
        },
    } as unknown as PluginContext
}

function makeWorkflowTask(fields: Partial<WorkflowTask> & { readonly steps: WorkflowStep[] }): WorkflowTask {
    return {
        type: "workflow",
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
        runId: crypto.randomUUID(),
        signoffPolicy: "none",
        ...fields,
    } as WorkflowTask
}

async function setupTeam(root: string, masterSid: string, task: ActiveTask, members: MemberState[]): Promise<Team> {
    await initTeamState(root, makeState("alpha", masterSid, members, Date.now()), masterSid)
    const team = await loadTeamState(root, "alpha", masterSid)
    await team.mutex.runExclusive(async () => {
        team.status = "busy"
        team.activeTask = task
        await saveTeamState(team)
    })
    await rebuildSessionIndex(root, `${root}__unused`)
    return team
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("team_fix_workflow", () => {
    test("redispatches an active workflow step and preserves invariants", async () => {
        // Given
        const root = tmpRoot("fix-wf-redispatch")
        const masterSid = "ses_fix_wf_master"
        const aliceSid = "ses_fix_wf_alice"
        tracked.push(masterSid, aliceSid)
        const task = makeWorkflowTask({
            activeStepIndices: [0],
            steps: [{ kind: "task", member: "alice", task: "retry me", completed: false, dispatchedAt: 1 }],
        })
        await setupTeam(root, masterSid, task, [makeMember("alice", aliceSid)])
        const calls: DispatchCall[] = []

        // When
        const result = await teamFixWorkflowTool(makeCtx(root, calls)).execute(
            { team_id: "alpha", op: "redispatch", step: 1 },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("redispatched step 1")
        expect(calls).toContainEqual({ sessionId: aliceSid, text: "retry me" })
        const after = await loadTeamState(root, "alpha", masterSid)
        expect(after.activeTask?.type).toBe("workflow")
        const check = checkWorkflowInvariants(after.activeTask as WorkflowTask)
        expect(check).toEqual({ ok: true })
    })

    test("skips a wedged workflow step and advances to the next actor", async () => {
        // Given
        const root = tmpRoot("fix-wf-skip")
        const masterSid = "ses_fix_wf_skip_master"
        const aliceSid = "ses_fix_wf_skip_alice"
        const bobSid = "ses_fix_wf_skip_bob"
        tracked.push(masterSid, aliceSid, bobSid)
        const task = makeWorkflowTask({
            activeStepIndices: [0],
            steps: [
                { kind: "task", member: "alice", task: "optional", completed: false },
                { kind: "task", member: "bob", task: "continue", completed: false },
            ],
        })
        await setupTeam(root, masterSid, task, [makeMember("alice", aliceSid), makeMember("bob", bobSid)])
        const calls: DispatchCall[] = []

        // When
        const result = await teamFixWorkflowTool(makeCtx(root, calls)).execute(
            { team_id: "alpha", op: "skip", step: 1 },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("skipped step 1")
        const after = await loadTeamState(root, "alpha", masterSid)
        const afterTask = after.activeTask as WorkflowTask
        expect(afterTask.steps?.[0]?.completed).toBe(true)
        expect(afterTask.steps?.[0]?.skipped).toBe(true)
        expect(afterTask.activeStepIndices).toEqual([1])
        expect(calls.some(call => call.sessionId === bobSid && call.text.includes("continue"))).toBe(true)
        expect(checkWorkflowInvariants(afterTask)).toEqual({ ok: true })
    })

    test("rejects redispatch for a non-active workflow step", async () => {
        // Given
        const root = tmpRoot("fix-wf-nonactive")
        const masterSid = "ses_fix_wf_nonactive_master"
        const aliceSid = "ses_fix_wf_nonactive_alice"
        const bobSid = "ses_fix_wf_nonactive_bob"
        tracked.push(masterSid, aliceSid, bobSid)
        const task = makeWorkflowTask({
            activeStepIndices: [0],
            steps: [
                { kind: "task", member: "alice", task: "active", completed: false },
                { kind: "task", member: "bob", task: "future", completed: false },
            ],
        })
        await setupTeam(root, masterSid, task, [makeMember("alice", aliceSid), makeMember("bob", bobSid)])

        // When
        const result = await teamFixWorkflowTool(makeCtx(root)).execute(
            { team_id: "alpha", op: "redispatch", step: 2 },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("Error: step 2 is not in the active workflow frontier")
    })

    test("advance re-drives a ready join without mutating completed branches", async () => {
        // Given
        const root = tmpRoot("fix-wf-advance")
        const masterSid = "ses_fix_wf_advance_master"
        const carolSid = "ses_fix_wf_advance_carol"
        tracked.push(masterSid, carolSid)
        const task = makeWorkflowTask({
            activeStepIndices: [3],
            steps: [
                { kind: "fanout", completed: true, fanout: { branchIds: ["api", "tests"], branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }], joinIndex: 3, maxErrored: 0 } },
                { kind: "task", member: "alice", task: "api", completed: true, branch: { fanoutIndex: 0, branchId: "api", branchIndex: 0, joinIndex: 3 } },
                { kind: "task", member: "bob", task: "tests", completed: true, branch: { fanoutIndex: 0, branchId: "tests", branchIndex: 1, joinIndex: 3 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2], maxErrored: 0 } },
                { kind: "task", member: "carol", task: "ship", completed: false },
            ],
        })
        await setupTeam(root, masterSid, task, [makeMember("carol", carolSid)])
        const calls: DispatchCall[] = []

        // When
        const result = await teamFixWorkflowTool(makeCtx(root, calls)).execute(
            { team_id: "alpha", op: "advance" },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("advanced workflow")
        const after = await loadTeamState(root, "alpha", masterSid)
        const afterTask = after.activeTask as WorkflowTask
        expect(afterTask.steps?.[3]?.completed).toBe(true)
        expect(afterTask.activeStepIndices).toEqual([4])
        expect(calls.some(call => call.sessionId === carolSid && call.text.includes("ship"))).toBe(true)
        expect(checkWorkflowInvariants(afterTask)).toEqual({ ok: true })
    })

    test("fail terminates the active workflow with an operator reason", async () => {
        // Given
        const root = tmpRoot("fix-wf-fail")
        const masterSid = "ses_fix_wf_fail_master"
        tracked.push(masterSid)
        const task = makeWorkflowTask({ steps: [{ kind: "task", member: "alice", task: "work", completed: false }] })
        await setupTeam(root, masterSid, task, [makeMember("alice", "ses_fix_wf_fail_alice")])
        const calls: DispatchCall[] = []

        // When
        const result = await teamFixWorkflowTool(makeCtx(root, calls)).execute(
            { team_id: "alpha", op: "fail", reason: "operator_reset" },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("failed workflow")
        const after = await loadTeamState(root, "alpha", masterSid)
        expect(after.status).toBe("failed")
        expect(after.activeTask).toBeUndefined()
        expect(calls.some(call => call.sessionId === masterSid && call.text.includes("workflow_failed:operator_reset"))).toBe(true)
    })

    test("rejects non-master callers", async () => {
        // Given
        const root = tmpRoot("fix-wf-nonmaster")
        const masterSid = "ses_fix_wf_nm_master"
        const aliceSid = "ses_fix_wf_nm_alice"
        tracked.push(masterSid, aliceSid)
        const task = makeWorkflowTask({ steps: [{ kind: "task", member: "alice", task: "work", completed: false }] })
        await setupTeam(root, masterSid, task, [makeMember("alice", aliceSid)])

        // When
        const result = await teamFixWorkflowTool(makeCtx(root)).execute(
            { team_id: "alpha", op: "advance" },
            makeToolContext(aliceSid),
        )

        // Then
        expect(result).toContain("master-only")
    })

    test("redispatches a failed workflow checkpoint after resetting errored members", async () => {
        // Given
        const root = tmpRoot("fix-wf-failed-checkpoint")
        const masterSid = "ses_fix_wf_failed_master"
        const aliceSid = "ses_fix_wf_failed_alice"
        tracked.push(masterSid, aliceSid)
        const task = makeWorkflowTask({
            activeStepIndices: [0],
            steps: [{ kind: "task", member: "alice", task: "recover me", completed: false }],
        })
        await initTeamState(root, makeState("alpha", masterSid, [makeMember("alice", aliceSid)], Date.now()), masterSid)
        const team = await loadTeamState(root, "alpha", masterSid)
        await team.mutex.runExclusive(async () => {
            team.status = "failed"
            team.lastInterruptedTask = task
            const alice = team.members.find(member => member.name === "alice")
            if (alice === undefined) throw new Error("Missing alice")
            alice.status = "errored"
            alice.error = "interrupted"
            await saveTeamState(team)
        })
        await rebuildSessionIndex(root, `${root}__unused`)
        const calls: DispatchCall[] = []

        // When
        const result = await teamFixWorkflowTool(makeCtx(root, calls)).execute(
            { team_id: "alpha", op: "redispatch", step: 1 },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("redispatched step 1")
        const after = await loadTeamState(root, "alpha", masterSid)
        expect(after.status).toBe("busy")
        expect(after.lastInterruptedTask).toBeUndefined()
        expect(after.members.find(member => member.name === "alice")?.status).toBe("running")
        expect(after.members.find(member => member.name === "alice")?.error).toBeUndefined()
        expect(calls).toContainEqual({ sessionId: aliceSid, text: "recover me" })
    })

    test("failed checkpoint repair rolls back when the requested step is invalid", async () => {
        // Given
        const root = tmpRoot("fix-wf-failed-rollback")
        const masterSid = "ses_fix_wf_failed_rollback_master"
        const aliceSid = "ses_fix_wf_failed_rollback_alice"
        tracked.push(masterSid, aliceSid)
        const task = makeWorkflowTask({
            activeStepIndices: [0],
            steps: [{ kind: "task", member: "alice", task: "recover me", completed: false }],
        })
        await initTeamState(root, makeState("alpha", masterSid, [makeMember("alice", aliceSid)], Date.now()), masterSid)
        const team = await loadTeamState(root, "alpha", masterSid)
        await team.mutex.runExclusive(async () => {
            team.status = "failed"
            team.lastInterruptedTask = task
            await saveTeamState(team)
        })
        await rebuildSessionIndex(root, `${root}__unused`)
        // When
        const result = await teamFixWorkflowTool(makeCtx(root)).execute(
            { team_id: "alpha", op: "redispatch", step: 99 },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("Error: step 99 does not exist")
        const after = await loadTeamState(root, "alpha", masterSid)
        expect(after.status).toBe("failed")
        expect(after.activeTask).toBeUndefined()
        expect(after.lastInterruptedTask?.type).toBe("workflow")
    })

    test("failed checkpoint repair rolls back mutated step state when redispatch fails", async () => {
        // Given: a failed checkpoint whose active step has a stale dispatchedAt,
        // and the only actor session is gone so redispatch will fail.
        const root = tmpRoot("fix-wf-failed-mutated-rollback")
        const masterSid = "ses_fix_wf_failed_mutated_master"
        const aliceSid = "ses_fix_wf_failed_mutated_alice"
        tracked.push(masterSid, aliceSid)
        const task = makeWorkflowTask({
            activeStepIndices: [0],
            steps: [{ kind: "task", member: "alice", task: "recover me", completed: false, dispatchedAt: 12345 }],
        })
        await initTeamState(root, makeState("alpha", masterSid, [makeMember("alice", aliceSid)], Date.now()), masterSid)
        const team = await loadTeamState(root, "alpha", masterSid)
        await team.mutex.runExclusive(async () => {
            team.status = "failed"
            team.lastInterruptedTask = task
            const alice = team.members.find(member => member.name === "alice")
            if (alice === undefined) throw new Error("Missing alice")
            alice.status = "errored"
            alice.error = "interrupted"
            await saveTeamState(team)
        })
        await rebuildSessionIndex(root, `${root}__unused`)

        // Drop alice's live session so redispatchWorkflowStep reports no live
        // session. The tool runs under team.mutex on the same in-memory team,
        // so mutate before call.
        const prepared = await loadTeamState(root, "alpha", masterSid)
        const preparedAlice = prepared.members.find(member => member.name === "alice")
        if (preparedAlice === undefined) throw new Error("Missing prepared alice")
        preparedAlice.sessionId = undefined
        await prepared.mutex.runExclusive(async () => {
            await saveTeamState(prepared)
        })

        // When
        const result = await teamFixWorkflowTool(makeCtx(root)).execute(
            { team_id: "alpha", op: "redispatch", step: 1 },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("Error: step 1 cannot be redispatched")
        const after = await loadTeamState(root, "alpha", masterSid)
        expect(after.status).toBe("failed")
        expect(after.activeTask).toBeUndefined()
        const restoredTask = after.lastInterruptedTask as WorkflowTask | undefined
        expect(restoredTask?.type).toBe("workflow")
        expect(restoredTask?.steps?.[0]?.dispatchedAt).toBe(12345)
    })

    test("rejects non-workflow active tasks", async () => {
        // Given
        const root = tmpRoot("fix-wf-nonworkflow")
        const masterSid = "ses_fix_wf_nw_master"
        tracked.push(masterSid)
        const task = {
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
        } as ActiveTask
        await setupTeam(root, masterSid, task, [makeMember("alice", "ses_fix_wf_nw_alice")])

        // When
        const result = await teamFixWorkflowTool(makeCtx(root)).execute(
            { team_id: "alpha", op: "advance" },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("active task is not a workflow")
    })

    test("reassign swaps an active step's actor to another live member and redispatches", async () => {
        // Given
        const root = tmpRoot("fix-wf-reassign")
        const masterSid = "ses_fix_wf_reassign_master"
        const aliceSid = "ses_fix_wf_reassign_alice"
        const bobSid = "ses_fix_wf_reassign_bob"
        tracked.push(masterSid, aliceSid, bobSid)
        const task = makeWorkflowTask({
            activeStepIndices: [0],
            steps: [{ kind: "task", member: "alice", task: "do work", completed: false }],
        })
        await setupTeam(root, masterSid, task, [makeMember("alice", aliceSid), makeMember("bob", bobSid)])
        const calls: DispatchCall[] = []

        // When
        const result = await teamFixWorkflowTool(makeCtx(root, calls)).execute(
            { team_id: "alpha", op: "reassign", step: 1, to_member: "bob" },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("reassigned step 1 to \"bob\"")
        const after = await loadTeamState(root, "alpha", masterSid)
        const afterTask = after.activeTask as WorkflowTask
        expect(afterTask.steps?.[0]?.member).toBe("bob")
        expect(calls.some(call => call.sessionId === bobSid && call.text.includes("do work"))).toBe(true)
        expect(checkWorkflowInvariants(afterTask)).toEqual({ ok: true })
    })

    test("reassign rejects when to_member is already active in a sibling fanout branch", async () => {
        // Given
        const root = tmpRoot("fix-wf-reassign-conflict")
        const masterSid = "ses_fix_wf_reassign_conflict_master"
        const aliceSid = "ses_fix_wf_reassign_conflict_alice"
        const carolSid = "ses_fix_wf_reassign_conflict_carol"
        const bobSid = "ses_fix_wf_reassign_conflict_bob"
        tracked.push(masterSid, aliceSid, carolSid, bobSid)
        const task = makeWorkflowTask({
            activeStepIndices: [1, 2],
            steps: [
                { kind: "fanout", completed: true, fanout: { branchIds: ["api", "qa"], branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }], joinIndex: 3, maxErrored: 0 } },
                { kind: "task", member: "alice", task: "api", completed: false, branch: { fanoutIndex: 0, branchId: "api", branchIndex: 0, joinIndex: 3 } },
                { kind: "task", member: "carol", task: "qa", completed: false, branch: { fanoutIndex: 0, branchId: "qa", branchIndex: 1, joinIndex: 3 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2], maxErrored: 0 } },
            ],
        })
        await setupTeam(root, masterSid, task, [
            makeMember("alice", aliceSid), makeMember("carol", carolSid), makeMember("bob", bobSid),
        ])

        // When: try to reassign api branch (step 2, index 1) to carol, who is active in qa.
        const result = await teamFixWorkflowTool(makeCtx(root)).execute(
            { team_id: "alpha", op: "reassign", step: 2, to_member: "carol" },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("Error: \"carol\" is already active in branch \"qa\"")
    })

    test("reassign rejects a non-member target", async () => {
        // Given
        const root = tmpRoot("fix-wf-reassign-nonmember")
        const masterSid = "ses_fix_wf_reassign_nm_master"
        const aliceSid = "ses_fix_wf_reassign_nm_alice"
        tracked.push(masterSid, aliceSid)
        const task = makeWorkflowTask({
            activeStepIndices: [0],
            steps: [{ kind: "task", member: "alice", task: "do work", completed: false }],
        })
        await setupTeam(root, masterSid, task, [makeMember("alice", aliceSid)])

        // When
        const result = await teamFixWorkflowTool(makeCtx(root)).execute(
            { team_id: "alpha", op: "reassign", step: 1, to_member: "ghost" },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("Error: \"ghost\" is not a team member")
    })
})

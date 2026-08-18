import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import type { ActiveTask, MemberState, WorkflowTask } from "../src/core/types.js"
import { checkWorkflowInvariants } from "../src/orchestration/workflow/invariants.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { initTeamState, invalidateTeam, loadTeamState, saveTeamState } from "../src/state/store.js"
import type { Team } from "../src/state/store.js"
import { teamFixWorkflowTool } from "../src/tools/control/fixflow.js"
import { type DispatchCall, cleanupTmpRoots, makeCtx, makeMember, makeState, makeToolContext, makeWorkflowTask, tmpRoot } from './helpers.js';

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
afterAll(cleanupTmpRoots)

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
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root, calls })).execute(
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

    test("redispatches an active workflow step selected by id", async () => {
        // Given
        const root = tmpRoot("fix-wf-redispatch-id")
        const masterSid = "ses_fix_wf_master_id"
        const aliceSid = "ses_fix_wf_alice_id"
        tracked.push(masterSid, aliceSid)
        const task = makeWorkflowTask({
            activeStepIndices: [0],
            steps: [{ kind: "task", id: "impl", member: "alice", task: "retry by id", completed: false, dispatchedAt: 1 }],
        })
        await setupTeam(root, masterSid, task, [makeMember("alice", aliceSid)])
        const calls: DispatchCall[] = []

        // When
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root, calls })).execute(
            { team_id: "alpha", op: "redispatch", step: "impl" },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("redispatched step 1")
        expect(calls).toContainEqual({ sessionId: aliceSid, text: "retry by id" })
        const after = await loadTeamState(root, "alpha", masterSid)
        expect(checkWorkflowInvariants(after.activeTask as WorkflowTask)).toEqual({ ok: true })
    })

    test("rejects an unknown workflow step id without dispatching", async () => {
        // Given
        const root = tmpRoot("fix-wf-redispatch-unknown-id")
        const masterSid = "ses_fix_wf_master_unknown_id"
        const aliceSid = "ses_fix_wf_alice_unknown_id"
        tracked.push(masterSid, aliceSid)
        const task = makeWorkflowTask({
            activeStepIndices: [0],
            steps: [{ kind: "task", id: "impl", member: "alice", task: "retry me", completed: false }],
        })
        await setupTeam(root, masterSid, task, [makeMember("alice", aliceSid)])
        const calls: DispatchCall[] = []

        // When
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root, calls })).execute(
            { team_id: "alpha", op: "redispatch", step: "ghost" },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("Error:")
        expect(calls).toEqual([])
    })

    test("rejects an invalid workflow checkpoint before redispatching", async () => {
        const root = tmpRoot("fix-wf-invalid-checkpoint")
        const masterSid = "ses_fix_wf_invalid_master"
        const aliceSid = "ses_fix_wf_invalid_alice"
        tracked.push(masterSid, aliceSid)
        const task = makeWorkflowTask({
            activeStepIndices: [0, 0],
            steps: [{ kind: "task", member: "alice", task: "must not dispatch", completed: false }],
        })
        await setupTeam(root, masterSid, task, [makeMember("alice", aliceSid)])
        const calls: DispatchCall[] = []

        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root, calls })).execute(
            { team_id: "alpha", op: "redispatch", step: 1 },
            makeToolContext(masterSid),
        )

        expect(result).toContain("workflow invariant violation")
        expect(calls).toEqual([])
    })

    test("redispatches an active fanout branch workflow step without touching sibling branches", async () => {
        // Given
        const root = tmpRoot("fix-wf-redispatch-branch")
        const masterSid = "ses_fix_wf_redispatch_branch_master"
        const aliceSid = "ses_fix_wf_redispatch_branch_alice"
        const carolSid = "ses_fix_wf_redispatch_branch_carol"
        tracked.push(masterSid, aliceSid, carolSid)
        const task = makeWorkflowTask({
            activeStepIndices: [1, 2],
            steps: [
                { kind: "fanout", completed: true, fanout: { branchIds: ["api", "qa"], branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }], joinIndex: 3, maxErrored: 0 } },
                { kind: "task", member: "alice", task: "api", completed: false, dispatchedAt: 12345, branch: { fanoutIndex: 0, branchId: "api", branchIndex: 0, joinIndex: 3 } },
                { kind: "task", member: "carol", task: "qa", completed: false, branch: { fanoutIndex: 0, branchId: "qa", branchIndex: 1, joinIndex: 3 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2], maxErrored: 0 } },
            ],
        })
        await setupTeam(root, masterSid, task, [makeMember("alice", aliceSid), makeMember("carol", carolSid)])
        const calls: DispatchCall[] = []

        // When
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root, calls })).execute(
            { team_id: "alpha", op: "redispatch", step: 2 },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("redispatched step 2")
        expect(calls).toContainEqual({ sessionId: aliceSid, text: "api" })
        expect(calls.some(call => call.sessionId === carolSid)).toBe(false)
        const after = await loadTeamState(root, "alpha", masterSid)
        const afterTask = after.activeTask as WorkflowTask
        expect(afterTask.activeStepIndices).toEqual([1, 2])
        const branchTaskStep = afterTask.steps?.[2]
        if (branchTaskStep?.kind !== "task") throw new Error("Expected task step at index 2")
        expect(branchTaskStep.member).toBe("carol")
        expect(branchTaskStep.completed).toBe(false)
        expect(checkWorkflowInvariants(afterTask)).toEqual({ ok: true })
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
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root, calls })).execute(
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
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root })).execute(
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
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root, calls })).execute(
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
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root, calls })).execute(
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
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root })).execute(
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
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root, calls })).execute(
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
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root })).execute(
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
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root })).execute(
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

    test("restores cached and persisted state when a failed checkpoint redispatch throws", async () => {
        // Given: a failed checkpoint whose active step redispatch reaches a live
        // actor, but promptAsync throws mid-repair — after workflowRepairTarget
        // has already flipped status to busy, revived alice, and cleared the
        // step's dispatchedAt on the registry-cached team.
        const root = tmpRoot("fix-wf-throw-rollback")
        const masterSid = "ses_fix_wf_throw_master"
        const aliceSid = "ses_fix_wf_throw_alice"
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
        const boom = new Error("promptAsync exploded")

        // When
        const call = teamFixWorkflowTool(
            makeCtx({ storageRoot: root, promptAsync: async () => { throw boom } }),
        ).execute(
            { team_id: "alpha", op: "redispatch", step: 1 },
            makeToolContext(masterSid),
        )

        // Then: the error is returned as a string (not thrown), and...
        const out = await call
        expect(out).toContain("Error: team_fix_workflow failed: promptAsync exploded")
        // ...and the registry-cached team is rolled back to the failed checkpoint.
        const after = await loadTeamState(root, "alpha", masterSid)
        expect(after.status).toBe("failed")
        expect(after.activeTask).toBeUndefined()
        const restoredTask = after.lastInterruptedTask as WorkflowTask | undefined
        expect(restoredTask?.type).toBe("workflow")
        expect(restoredTask?.steps?.[0]?.dispatchedAt).toBe(12345)
        expect(after.members.find(member => member.name === "alice")?.status).toBe("errored")
        expect(after.members.find(member => member.name === "alice")?.error).toBe("interrupted")
        // ...and the persisted state on disk matches the restored cache.
        invalidateTeam(after.directory)
        const reloaded = await loadTeamState(root, "alpha", masterSid)
        expect(reloaded.status).toBe("failed")
        expect((reloaded.lastInterruptedTask as WorkflowTask | undefined)?.steps?.[0]?.dispatchedAt).toBe(12345)
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
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", op: "advance" },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("active task is not a workflow")
    })

    test("rejects repair while an approval is pending with a specific message", async () => {
        // Given
        const root = tmpRoot("fix-wf-approval-pending")
        const masterSid = "ses_fix_wf_ap_master"
        const aliceSid = "ses_fix_wf_ap_alice"
        tracked.push(masterSid, aliceSid)
        const task = makeWorkflowTask({
            approvalStage: true,
            activeStepIndices: [0],
            steps: [{ kind: "task", member: "alice", task: "pending work", completed: false, dispatchedAt: 1 }],
        })
        await setupTeam(root, masterSid, task, [makeMember("alice", aliceSid)])
        const calls: DispatchCall[] = []

        // When
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root, calls })).execute(
            { team_id: "alpha", op: "redispatch", step: 1 },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("while an approval is pending")
        expect(calls).toBeEmpty()
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
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root, calls })).execute(
            { team_id: "alpha", op: "reassign", step: 1, to_member: "bob" },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("reassigned step 1 to \"bob\"")
        const after = await loadTeamState(root, "alpha", masterSid)
        const afterTask = after.activeTask as WorkflowTask
        const reassignedTaskStep = afterTask.steps?.[0]
        if (reassignedTaskStep?.kind !== "task") throw new Error("Expected task step at index 0")
        expect(reassignedTaskStep.member).toBe("bob")
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
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root })).execute(
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
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", op: "reassign", step: 1, to_member: "ghost" },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("Error: \"ghost\" is not a team member")
    })
})

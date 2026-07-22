import { describe, expect, test } from 'bun:test';

import type { RecurseTask, Task } from "../src/core/types.js"
import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import { teamApproveTool, teamRejectTool } from "../src/tools/control/approve.js"
import { createTask, getTask, listAllTasks, updateTask } from "../src/state/tasks.js"
import { saveTeamState, type Team } from "../src/state/store.js"
import { type DispatchCall, makeCtx, makeHitlLifecycle, makeMember, makeToolContext, tmpRoot } from './helpers.js';

const DECOMPOSE = '<decompose>{"subtasks":[{"subject":"part A","description":"do A"},{"subject":"part B","description":"do B"}]}</decompose>'

const { setupTeam } = makeHitlLifecycle()

async function setRecurseTask(team: Team, task: RecurseTask): Promise<void> {
    await team.mutex.runExclusive(async () => {
        team.status = "busy"
        team.activeTask = task
        await saveTeamState(team)
    })
}

function recurseTask(rootTaskId?: string): RecurseTask {
    return {
        type: "recurse",
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
        task: "solve root",
        decomposerMember: "alice",
        maxDepth: 3,
        maxSubtasks: 5,
        rootTaskId,
        signoffPolicy: "none",
        humanApproval: true,
        approvalHistory: [],
    }
}

async function seedClaimedTask(team: Team, owner: string, subject = "root"): Promise<Task> {
    const task = await createTask(team.directory, { subject, description: subject, depth: 0 })
    return updateTask(team.directory, task.id, { owner, status: "claimed" })
}

describe("HITL recurse decomposition approval", () => {
    test("pauses before creating subtasks and team_approve creates children", async () => {
        const root = tmpRoot("hitl-recurse-approve")
        const sid = "ses_hitl_recurse_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [makeMember("alice", "ses_alice")])
        const claimed = await seedClaimedTask(team, "alice")
        const task = recurseTask(claimed.id)
        await setRecurseTask(team, task)
        const ctx = makeCtx({ storageRoot: root, outputs: { ses_alice: DECOMPOSE }, calls, abort: async () => ({}), status: async () => ({ data: {} }) })

        await processIdle(ctx, team, team.members[0], "ses_alice")

        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest?.kind).toBe("recurse_decompose")
        expect((await listAllTasks(team.directory)).filter(t => t.depth === 1)).toHaveLength(0)

        const result = await teamApproveTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))

        expect(result).toContain("Approved")
        const all = await listAllTasks(team.directory)
        const children = all.filter(t => t.depth === 1)
        expect(children).toHaveLength(2)
        const parent = await getTask(team.directory, claimed.id)
        expect(parent?.status).toBe("pending")
        expect(parent?.owner).toBeUndefined()
        expect(parent?.blockedBy).toHaveLength(2)
    })

    test("team_reject completes the task as a leaf and creates no children", async () => {
        const root = tmpRoot("hitl-recurse-reject")
        const sid = "ses_hitl_recurse_reject_master"
        const team = await setupTeam(root, sid, [makeMember("alice", "ses_alice")])
        const claimed = await seedClaimedTask(team, "alice")
        const task = recurseTask(claimed.id)
        await setRecurseTask(team, task)
        const ctx = makeCtx({ storageRoot: root, outputs: { ses_alice: DECOMPOSE }, calls: [], abort: async () => ({}), status: async () => ({ data: {} }) })

        await processIdle(ctx, team, team.members[0], "ses_alice")
        const result = await teamRejectTool(ctx).execute({ team_id: "alpha", feedback: "solve directly" }, makeToolContext(sid))

        expect(result).toContain("Rejected")
        const parent = await getTask(team.directory, claimed.id)
        expect(parent?.status).toBe("completed")
        expect(parent?.result).toContain("decompose")
        expect((await listAllTasks(team.directory)).filter(t => t.depth === 1)).toHaveLength(0)
    })

    test("pending recurse approval globally pauses other task-pool idles", async () => {
        const root = tmpRoot("hitl-recurse-global-pause")
        const sid = "ses_hitl_recurse_pause_master"
        const team = await setupTeam(root, sid, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const aliceTask = await seedClaimedTask(team, "alice", "decompose me")
        const bobTask = await seedClaimedTask(team, "bob", "finish me")
        const task = recurseTask(aliceTask.id)
        await setRecurseTask(team, task)
        const ctx = makeCtx({ storageRoot: root, outputs: { ses_alice: DECOMPOSE, ses_bob: "bob solved it" }, calls: [], abort: async () => ({}), status: async () => ({ data: {} }) })

        await processIdle(ctx, team, team.members[0], "ses_alice")
        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.approvalStage).toBe(true)
        const bobAfter = await getTask(team.directory, bobTask.id)
        expect(bobAfter?.status).toBe("claimed")
        expect(bobAfter?.result).toBeUndefined()
    })
})

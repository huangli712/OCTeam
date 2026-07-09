import { afterEach, describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { MemberState, RecurseTask, Task } from "../src/core/types.js"
import { processIdle } from "../src/orchestration/idle.js"
import { teamApproveTool, teamRejectTool } from "../src/tools/approve.js"
import { createTask, getTask, listAllTasks, updateTask } from "../src/state/tasks.js"
import { initTeamState, loadTeamState, saveTeamState, type Team } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { makeMember, makeState, makeToolContext, tmpRoot, type DispatchCall } from "./helpers.js"

type PromptRequest = { readonly path: { readonly id: string }; readonly body: { readonly parts: readonly [{ readonly text: string }] } }

const DECOMPOSE = '<decompose>{"subtasks":[{"subject":"part A","description":"do A"},{"subject":"part B","description":"do B"}]}</decompose>'

function makeCtx(root: string, outputs: Record<string, string>, calls: DispatchCall[] = []): PluginContext {
    return {
        storageRoot: root,
        scope: "project",
        directory: "/app",
        project: { id: "project", directory: "/app" },
        projectStorageRoot: root,
        userStorageRoot: `${root}__user_unused`,
        client: {
            app: { log: mock(async () => ({})) },
            session: {
                messages: mock(async ({ path }: { readonly path: { readonly id: string } }) => {
                    const text = outputs[path.id] ?? ""
                    return {
                        data: [
                            { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
                            ...(text ? [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }] : []),
                        ],
                    }
                }),
                promptAsync: mock(async (req: PromptRequest) => {
                    calls.push({ sessionId: req.path.id, text: req.body.parts[0].text })
                    return { data: {} }
                }),
                abort: mock(async () => ({})),
                status: mock(async () => ({ data: {} })),
            },
        },
    } as unknown as PluginContext
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

async function setupTeam(root: string, sid: string, members: MemberState[]): Promise<Team> {
    tracked.push(sid)
    for (const member of members) {
        if (member.sessionId) tracked.push(member.sessionId)
    }
    await initTeamState(root, makeState("alpha", sid, members, Date.now()), sid)
    await rebuildSessionIndex(root, `${root}__user_unused`)
    return loadTeamState(root, "alpha", sid)
}

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
        const ctx = makeCtx(root, { ses_alice: DECOMPOSE }, calls)

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
        const ctx = makeCtx(root, { ses_alice: DECOMPOSE })

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
        const ctx = makeCtx(root, { ses_alice: DECOMPOSE, ses_bob: "bob solved it" })

        await processIdle(ctx, team, team.members[0], "ses_alice")
        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.approvalStage).toBe(true)
        const bobAfter = await getTask(team.directory, bobTask.id)
        expect(bobAfter?.status).toBe("claimed")
        expect(bobAfter?.result).toBeUndefined()
    })
})

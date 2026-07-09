import { afterEach, describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { ConsensusTask, MemberState } from "../src/core/types.js"
import { handleConsensusIdle } from "../src/orchestration/consensus.js"
import { teamApproveTool, teamRejectTool } from "../src/tools/approve.js"
import { initTeamState, loadTeamState, saveTeamState, type Team } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { makeMember, makeState, makeToolContext, tmpRoot, type DispatchCall } from "./helpers.js"

type PromptRequest = { readonly path: { readonly id: string }; readonly body: { readonly parts: readonly [{ readonly text: string }] } }

const AGREE = '<consensus>{"agreed":true}</consensus>'
const DISAGREE = '<consensus>{"agreed":false}</consensus>'

function makeCtx(root: string, calls: DispatchCall[] = []): PluginContext {
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
                promptAsync: mock(async (req: PromptRequest) => {
                    calls.push({ sessionId: req.path.id, text: req.body.parts[0].text })
                    return { data: {} }
                }),
                abort: mock(async () => ({})),
                status: mock(async () => ({ data: {} })),
                messages: mock(async () => ({ data: [] })),
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

async function setConsensusTask(team: Team, task: ConsensusTask): Promise<void> {
    await team.mutex.runExclusive(async () => {
        team.status = "busy"
        team.activeTask = task
        await saveTeamState(team)
    })
}

function consensusTask(): ConsensusTask {
    return {
        type: "consensus",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300_000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: { alice: AGREE, bob: DISAGREE },
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        topic: "Should we adopt the new format?",
        currentRound: 3,
        maxRounds: 3,
        signoffPolicy: "none",
        humanApproval: true,
        approvalHistory: [],
    }
}

describe("HITL consensus deadlock approval", () => {
    test("pauses at max_rounds without consensus and team_approve accepts", async () => {
        const root = tmpRoot("hitl-cons-approve")
        const sid = "ses_hitl_cons_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const task = consensusTask()
        await setConsensusTask(team, task)
        const ctx = makeCtx(root, calls)

        await handleConsensusIdle(ctx, team)

        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest?.kind).toBe("consensus_deadlock")
        expect(calls.some(call => call.sessionId === sid && call.text.includes("team_approve"))).toBe(true)

        const result = await teamApproveTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))

        expect(result).toContain("Approved")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.status).toBe("idle")
        expect(after.activeTask).toBeUndefined()
    })

    test("team_reject fails the deadlocked consensus", async () => {
        const root = tmpRoot("hitl-cons-reject")
        const sid = "ses_hitl_cons_reject_master"
        const team = await setupTeam(root, sid, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const task = consensusTask()
        await setConsensusTask(team, task)
        const ctx = makeCtx(root)

        await handleConsensusIdle(ctx, team)
        const result = await teamRejectTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))

        expect(result).toContain("Rejected")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.status).toBe("failed")
        expect(after.activeTask).toBeUndefined()
    })
})

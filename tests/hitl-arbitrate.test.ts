import { afterEach, describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { ArbitrateTask, MemberState } from "../src/core/types.js"
import { handleArbitrateIdle } from "../src/orchestration/arbitrate.js"
import { teamApproveTool, teamRejectTool } from "../src/tools/approve.js"
import { initTeamState, loadTeamState, saveTeamState, type Team } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { makeMember, makeState, makeToolContext, tmpRoot, type DispatchCall } from "./helpers.js"

type PromptRequest = { readonly path: { readonly id: string }; readonly body: { readonly parts: readonly [{ readonly text: string }] } }

const RULING = '<ruling>{"decision":"ship Friday","rationale":"risk is low"}</ruling>'

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

async function setArbitrateTask(team: Team, task: ArbitrateTask): Promise<void> {
    await team.mutex.runExclusive(async () => {
        team.status = "busy"
        team.activeTask = task
        await saveTeamState(team)
    })
}

function arbitrateTask(): ArbitrateTask {
    return {
        type: "arbitrate",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300_000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: { arbiter: RULING },
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        task: "Should we ship on Friday?",
        arbiterMember: "arbiter",
        disputants: ["alice", "bob"],
        arbitrationStage: true,
        maxRounds: 1,
        currentRound: 1,
        signoffPolicy: "none",
        humanApproval: true,
        approvalHistory: [],
    }
}

describe("HITL arbitrate ruling approval", () => {
    test("pauses after ruling and team_approve delivers", async () => {
        const root = tmpRoot("hitl-arb-approve")
        const sid = "ses_hitl_arb_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("arbiter", "ses_arbiter"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const task = arbitrateTask()
        await setArbitrateTask(team, task)
        const ctx = makeCtx(root, calls)

        await handleArbitrateIdle(ctx, team)

        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest?.kind).toBe("arbitrate_ruling")
        expect(task.arbitrationRuling).toBe("ship Friday")
        expect(calls.some(call => call.sessionId === sid && call.text.includes("team_approve"))).toBe(true)

        const result = await teamApproveTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))

        expect(result).toContain("Approved")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.status).toBe("idle")
        expect(after.activeTask).toBeUndefined()
        expect(calls.some(call => call.text.includes("arbitrate_complete")))
    })

    test("team_reject fails the ruled arbitrate", async () => {
        const root = tmpRoot("hitl-arb-reject")
        const sid = "ses_hitl_arb_reject_master"
        const calls: DispatchCall[] = []
        const team = await setupTeam(root, sid, [
            makeMember("arbiter", "ses_arbiter"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const task = arbitrateTask()
        await setArbitrateTask(team, task)
        const ctx = makeCtx(root, calls)

        await handleArbitrateIdle(ctx, team)
        const result = await teamRejectTool(ctx).execute({ team_id: "alpha", feedback: "unacceptable" }, makeToolContext(sid))

        expect(result).toContain("Rejected")
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.status).toBe("failed")
        expect(after.activeTask).toBeUndefined()
    })
})

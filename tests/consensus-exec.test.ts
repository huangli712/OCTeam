import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { handleConsensusIdle } from "../src/orchestration/parallel-consensus.js"
import type { ActiveTask, MemberState } from "../src/core/types.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { Team } from "../src/state/store.js"
import type { PluginContext } from "../src/core/context.js"

// --- fixtures (consensus execution path) ---

/** A recorded promptAsync call: which session got which text. */
type DispatchCall = { sessionId: string; text: string }

/**
 * Stub PluginContext: handleConsensusIdle only exercises promptAsync (via
 * dispatchToMember on a next round, and deliverSummaryToLeader on completion).
 */
function makeCtx(calls: DispatchCall[] = []): PluginContext {
    return {
        directory: "/app",
        client: {
            session: {
                promptAsync: async (args: any) => {
                    calls.push({ sessionId: args.path.id, text: args.body.parts[0].text })
                    return { data: {} }
                },
            },
        },
    } as unknown as PluginContext
}

function makeConsensusTask(opts: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "consensus",
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
        runId: crypto.randomUUID(),
        topic: "Should we adopt the new format?",
        currentRound: 1,
        maxRounds: 3,
        signoffPolicy: "none",
        ...opts,
    } as ActiveTask
}

function makeTeam(opts: {
    activeTask?: ActiveTask
    members?: Array<Partial<MemberState> & Pick<MemberState, "name">>
}): Team {
    const members: MemberState[] = (opts.members ?? []).map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: m.initialized ?? true,
        turnCount: m.turnCount ?? 0,
        sessionId: m.sessionId,
        agent: m.agent,
        isMaster: m.isMaster,
    }))
    return {
        version: 1,
        teamRunId: "test-run",
        teamName: "test-team",
        status: "busy",
        leadSessionId: "ses_lead",
        members,
        bounds: {
            maxMembers: 8,
            maxParallelMembers: 4,
            maxMessagesPerRun: 100,
            maxWallClockMinutes: 30,
            maxMemberTurns: 50,
            maxTasks: 200,
            messagePayloadMaxBytes: 32768,
            messageUnreadMaxBytes: 1048576,
        },
        createdAt: 0,
        activeTask: opts.activeTask,
        mutex: new AsyncMutex(),
        directory: mkdtempSync(join(tmpdir(), "octeam-cons-")),
    } as unknown as Team
}

const AGREE = '<consensus>{"agreed":true}</consensus>'
const DISAGREE = '<consensus>{"agreed":false}</consensus>'

// --- consensus barrier outcomes ---

describe("handleConsensusIdle: barrier outcomes", () => {
    test("all members agree -> consensus_reached, delivered and idled", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeConsensusTask({
            responses: { alice: `yes ${AGREE}`, bob: `agreed ${AGREE}` },
            currentRound: 1,
            maxRounds: 3,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                { name: "bob", sessionId: "ses_bob", status: "idle" },
            ],
        })

        await handleConsensusIdle(ctx, team)

        expect(task.consensusReached).toBe(true)
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("consensus_reached")
    })

    test("mixed votes with rounds remaining -> advances to the next round", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeConsensusTask({
            responses: { alice: AGREE, bob: DISAGREE },
            currentRound: 1,
            maxRounds: 3,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                { name: "bob", sessionId: "ses_bob", status: "idle" },
            ],
        })

        await handleConsensusIdle(ctx, team)

        expect(task.consensusReached).toBe(false)
        expect(task.currentRound).toBe(2)
        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
        // Both participants re-dispatched with the round-2 prompt.
        const roundCalls = calls.filter(c => c.sessionId === "ses_alice" || c.sessionId === "ses_bob")
        expect(roundCalls).toHaveLength(2)
        expect(roundCalls.every(c => c.text.includes("Round 2"))).toBe(true)
    })

    test("no consensus at max rounds -> fails the run", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeConsensusTask({
            responses: { alice: AGREE, bob: DISAGREE },
            currentRound: 3,
            maxRounds: 3,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                { name: "bob", sessionId: "ses_bob", status: "idle" },
            ],
        })

        await handleConsensusIdle(ctx, team)

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("consensus_max_rounds")
    })
})

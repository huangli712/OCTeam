import { describe, expect, test } from "bun:test"

import { handleConsensusIdle } from "../src/orchestration/consensus.js"
import type { ConsensusTask } from "../src/core/types.js"
import { makeCtx, makeTeam, type DispatchCall } from "./helpers.js"

// --- fixtures (consensus execution path) ---

function makeConsensusTask(opts: Partial<ConsensusTask> = {}): ConsensusTask {
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
    } as ConsensusTask
}

const AGREE = '<consensus>{"agreed":true}</consensus>'
const DISAGREE = '<consensus>{"agreed":false}</consensus>'

// --- consensus barrier outcomes ---

describe("handleConsensusIdle: barrier outcomes", () => {
    test("all members agree -> consensus_reached, delivered and idled", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
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
        const ctx = makeCtx({ calls })
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
        const ctx = makeCtx({ calls })
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

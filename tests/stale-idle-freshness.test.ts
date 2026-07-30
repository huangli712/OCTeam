import { afterAll, describe, expect, test } from "bun:test"

import type { ArenaTask, Message, ParallelTask, SdkMessage } from "../src/core/types.js"
import { writeMailboxMessage } from "../src/messaging/mailbox.js"
import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import { handleArbitrateIdle } from "../src/orchestration/modes/arbitrate.js"
import { handleArenaIdle } from "../src/orchestration/modes/arena.js"
import { handleConsensusIdle } from "../src/orchestration/modes/consensus.js"
import { handleLoopIdle } from "../src/orchestration/modes/loop.js"
import { handleReduceIdle } from "../src/orchestration/modes/reduce.js"
import { handleRouteIdle } from "../src/orchestration/modes/route.js"
import { captureMemberOutput } from "../src/orchestration/records/capture.js"
import { cleanupTmpRoots, makeCtx, makeTask, makeTeam } from "./helpers.js"

afterAll(cleanupTmpRoots)

const staleCapture = { fresh: false, reason: "stale" } as const

function turn(output?: string): SdkMessage[] {
    const messages: SdkMessage[] = [{
        info: {
            role: "user",
            id: "user-message",
            sessionID: "session",
            time: { created: 0 },
            agent: "oct-junior",
            model: { providerID: "provider", modelID: "model" },
        },
        parts: [{ type: "text", text: "work" }],
    }]
    if (output !== undefined) {
        messages.push({
            info: {
                role: "assistant",
                id: "assistant-message",
                sessionID: "session",
                time: { created: 0 },
                parentID: "user-message",
                modelID: "model",
                providerID: "provider",
                mode: "oct-junior",
                path: { cwd: "/", root: "/" },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [{ type: "text", text: output }],
        })
    }
    return messages
}

describe("captureMemberOutput freshness", () => {
    test("returns fresh, stale, and empty as distinct states", async () => {
        const task = makeTask({ runId: crypto.randomUUID() })
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_capture" }],
        })
        const member = team.members[0]

        expect(await captureMemberOutput(team, member, turn("answer"))).toEqual({
            fresh: true,
            output: "answer",
        })
        expect(await captureMemberOutput(team, member, turn("answer"))).toEqual({
            fresh: false,
            reason: "stale",
        })

        const emptyTask = makeTask({ runId: crypto.randomUUID() })
        const emptyTeam = makeTeam({
            activeTask: emptyTask,
            members: [{ name: "bob", sessionId: "ses_empty" }],
        })
        const emptyMember = emptyTeam.members[0]
        expect(await captureMemberOutput(emptyTeam, emptyMember, turn())).toEqual({
            fresh: false,
            reason: "empty",
        })
        expect(await captureMemberOutput(emptyTeam, emptyMember, turn())).toEqual({
            fresh: false,
            reason: "stale",
        })
    })
})

describe("processIdle stale event", () => {
    test("keeps member state and mode state unchanged while re-sending the wake hint", async () => {
        const sessionId = `ses_stale_${crypto.randomUUID()}`
        const calls: Array<{ sessionId: string; text: string }> = []
        const history = turn("old route output")
        const task = makeTask({
            type: "route",
            routerMember: "router",
            routeBranches: [{ name: "target", member: "worker" }],
            responses: { router: "old route output" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "router", sessionId, status: "running", turnCount: 1 },
                { name: "worker", sessionId: "ses_worker" },
            ],
        })
        const router = team.members[0]
        router.lastCapturedMsgCount = history.length
        router.retryingSince = 123
        const message: Message = {
            version: 1,
            id: crypto.randomUUID(),
            from: "master",
            to: "router",
            kind: "message",
            body: "new work",
            timestamp: Date.now(),
            deliveryStatus: "pending",
        }
        await writeMailboxMessage(team.directory, router.name, message)
        const ctx = makeCtx({
            calls,
            messages: async () => ({ data: history }),
        })

        await processIdle(ctx, team, router, sessionId)

        expect(router.status).toBe("running")
        expect(router.retryingSince).toBe(123)
        expect(task.decisionParseFailures).toBe(0)
        expect(team.activeTask).toBe(task)
        expect(calls).toHaveLength(1)
        expect(calls[0].text).toContain("new team message")
    })
})

describe("mode handlers ignore stale capture", () => {
    test("reduce does not consume an empty-output retry", async () => {
        const task = makeTask({
            reduceStage: true,
            reducerMember: "alice",
            reducePolicy: "merge",
            maxRetries: 0,
        }) as ParallelTask
        const team = makeTeam({ activeTask: task, members: [{ name: "alice", sessionId: "ses_a" }] })

        await handleReduceIdle(makeCtx({ calls: [] }), team, team.members[0], staleCapture)

        expect(task.reduceRetries).toBeUndefined()
        expect(team.activeTask).toBe(task)
    })

    test("loop does not complete a stage or consume a parse retry", async () => {
        const task = makeTask({
            type: "loop",
            stages: [{ member: "decider", task: "decide", completed: false }],
            currentStageIndex: 0,
            currentRound: 1,
            maxRounds: 2,
            deciderMember: "decider",
            responses: { decider: "old malformed decision" },
        })
        const team = makeTeam({ activeTask: task, members: [{ name: "decider", sessionId: "ses_d" }] })

        await handleLoopIdle(makeCtx({ calls: [] }), team, team.members[0], staleCapture)

        expect(task.stages[0].completed).toBe(false)
        expect(task.currentStageIndex).toBe(0)
        expect(task.decisionParseFailures).toBe(0)
    })

    test("route does not parse an old router response", async () => {
        const task = makeTask({
            type: "route",
            routerMember: "router",
            routeBranches: [{ name: "target", member: "worker" }],
            responses: { router: "old malformed route" },
            decisionParseFailures: 1,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "router", sessionId: "ses_r" },
                { name: "worker", sessionId: "ses_w" },
            ],
        })

        await handleRouteIdle(makeCtx({ calls: [] }), team, staleCapture)

        expect(task.decisionParseFailures).toBe(1)
        expect(team.activeTask).toBe(task)
    })

    test("arbitrate does not parse an old ruling", async () => {
        const task = makeTask({
            type: "arbitrate",
            arbitrationStage: true,
            arbiterMember: "arbiter",
            responses: { arbiter: "old malformed ruling" },
            decisionParseFailures: 1,
        })
        const team = makeTeam({ activeTask: task, members: [{ name: "arbiter", sessionId: "ses_a" }] })

        await handleArbitrateIdle(makeCtx({ calls: [] }), team, staleCapture)

        expect(task.decisionParseFailures).toBe(1)
        expect(team.activeTask).toBe(task)
    })

    test("consensus does not trigger its barrier", async () => {
        const task = makeTask({
            type: "consensus",
            currentRound: 1,
            maxRounds: 2,
            responses: {
                alice: '<consensus>{"agreed":true}</consensus>',
                bob: '<consensus>{"agreed":false}</consensus>',
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_a", status: "idle" },
                { name: "bob", sessionId: "ses_b", status: "idle" },
            ],
        })

        await handleConsensusIdle(makeCtx({ calls: [] }), team, staleCapture)

        expect(task.currentRound).toBe(1)
        expect(team.activeTask).toBe(task)
    })

    test("arena does not consume an evaluator retry", async () => {
        const task = makeTask({
            type: "arena",
            arenaPhase: "evaluate",
            candidates: ["alice"],
            survivingCandidates: ["alice"],
            evaluatorMember: "evaluator",
            scoreDirection: "max",
            winnerMetric: "score",
            maxEvalRetries: 0,
            responses: { evaluator: "old malformed scoreboard" },
        }) as ArenaTask
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_a" },
                { name: "evaluator", sessionId: "ses_e" },
            ],
        })

        await handleArenaIdle(makeCtx({ calls: [] }), team, team.members[1], staleCapture)

        expect(task.evalAttempts).toBeUndefined()
        expect(team.activeTask).toBe(task)
    })
})

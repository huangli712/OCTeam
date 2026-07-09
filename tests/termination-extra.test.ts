import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, mock, test } from "bun:test"

import { checkTermination } from "../src/orchestration/termination.js"
import type { ActiveTask, MemberState } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { AsyncMutex } from "../src/state/locks.js"
import { makeCtx } from "./helpers.js"
import type { PluginContext } from "../src/core/context.js"

function makeTeam(opts: {
    startedAt?: number
    wallClockTimeoutMs?: number
    tokenBudget?: number
    tokensUsed?: number
    members: Array<Partial<MemberState> & Pick<MemberState, "name">>
    type?: ActiveTask["type"]
    maxMemberTurns?: number
}): Team {
    const members: MemberState[] = opts.members.map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: m.initialized ?? true,
        turnCount: m.turnCount ?? 0,
        error: m.error,
        ...(m.isMaster ? { isMaster: true } : {}),
    }))
    const task: ActiveTask = {
        type: opts.type ?? "parallel",
        mode: "cooperative",
        startedAt: opts.startedAt ?? Date.now(),
        wallClockTimeoutMs: opts.wallClockTimeoutMs ?? 300_000,
        tokenBudget: opts.tokenBudget,
        tokensUsed: opts.tokensUsed ?? 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
    } as ActiveTask
    return {
        version: 1,
        teamRunId: "term-test-run",
        teamName: "term-team",
        status: "busy",
        leadSessionId: "ses_term_lead",
        members,
        bounds: {
            maxMembers: 8,
            maxParallelMembers: 4,
            maxMessagesPerRun: 100,
            maxWallClockMinutes: 30,
            maxMemberTurns: opts.maxMemberTurns ?? 50,
            maxTasks: 200,
            messagePayloadMaxBytes: 32768,
            messageUnreadMaxBytes: 1048576,
        },
        createdAt: 0,
        activeTask: task,
        mutex: new AsyncMutex(),
        directory: mkdtempSync(join(tmpdir(), "octeam-term-extra-")),
    } as unknown as Team
}

// ============================================================
// termination.ts: budget_exceeded + member_turn_limit branches.
// failure-isolation.test.ts covers the member_error branch;
// these tests cover the two remaining fail-fast paths.
// ============================================================

describe("checkTermination: token budget exceeded", () => {
    test("tokensUsed > tokenBudget → failed with reason budget_exceeded", async () => {
        const promptAsync = mock(async () => ({ data: {} }))
        const ctx = {
            client: { session: { promptAsync } },
        } as unknown as PluginContext
        const team = makeTeam({
            tokenBudget: 1000,
            tokensUsed: 1500, // over budget
            members: [{ name: "alice" }],
        })

        await checkTermination(ctx, team)

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        // The leader got the failure summary with budget_exceeded marker.
        expect(promptAsync).toHaveBeenCalledTimes(1)
        const req = (promptAsync.mock.calls[0] as Array<{ body: { parts: Array<{ text: string }> } }>)[0]
        expect(req.body.parts[0].text).toContain("budget_exceeded")
    })

    test("tokensUsed === tokenBudget: NOT over (strict >), no termination", async () => {
        const team = makeTeam({
            tokenBudget: 1000,
            tokensUsed: 1000, // equal — boundary, NOT exceeded
            members: [{ name: "alice" }],
        })

        await checkTermination(makeCtx({ promptAsync: async () => ({ data: {} }) }), team)

        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
    })

    test("no tokenBudget set: budget check skipped entirely", async () => {
        const team = makeTeam({
            tokensUsed: 1_000_000, // huge usage but no budget cap
            members: [{ name: "alice" }],
        })

        await checkTermination(makeCtx({ promptAsync: async () => ({ data: {} }) }), team)

        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
    })
})

describe("checkTermination: per-member turn limit", () => {
    test("any non-master member over maxMemberTurns → failed with reason member_turn_limit:<name>", async () => {
        const promptAsync = mock(async () => ({ data: {} }))
        const ctx = {
            client: { session: { promptAsync } },
        } as unknown as PluginContext
        const team = makeTeam({
            maxMemberTurns: 5,
            members: [
                { name: "alice", turnCount: 3 }, // under
                { name: "bob", turnCount: 6 },   // over → triggers termination
            ],
        })

        await checkTermination(ctx, team)

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const req = (promptAsync.mock.calls[0] as Array<{ body: { parts: Array<{ text: string }> } }>)[0]
        expect(req.body.parts[0].text).toContain("member_turn_limit:bob")
    })

    test("turnCount === maxMemberTurns: NOT over (strict >), no termination", async () => {
        const team = makeTeam({
            maxMemberTurns: 5,
            members: [{ name: "alice", turnCount: 5 }], // equal — boundary
        })

        await checkTermination(makeCtx({ promptAsync: async () => ({ data: {} }) }), team)

        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
    })

    test("master member is excluded from the turn-limit check", async () => {
        const team = makeTeam({
            maxMemberTurns: 5,
            members: [{ name: "master", turnCount: 999, isMaster: true }],
        })

        await checkTermination(makeCtx({ promptAsync: async () => ({ data: {} }) }), team)

        // master's turnCount doesn't count — run continues.
        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
    })
})

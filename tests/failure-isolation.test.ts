import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { checkTermination } from "../src/orchestration/termination.js"
import type { ActiveTask, MemberState, TeamState } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { PluginContext } from "../src/core/context.js"

/**
 * Stub PluginContext: only ctx.client.session.promptAsync is exercised by
 * deliverSummaryToLeader. Everything else is unused by checkTermination's
 * member-error branch (parallel mode → buildSummary concatenates responses,
 * no extra IO).
 */
function makeCtx(): PluginContext {
    return {
        client: {
            session: {
                promptAsync: async () => ({ data: {} }),
            },
        },
    } as unknown as PluginContext
}

/** Minimal busy parallel Team with the given members + tolerance. */
function makeTeam(opts: {
    members: Array<Partial<MemberState> & Pick<MemberState, "name">>
    type?: ActiveTask["type"]
    maxErroredMembers?: number
}): Team {
    const members: MemberState[] = opts.members.map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: m.initialized ?? true,
        turnCount: m.turnCount ?? 0,
        error: m.error,
    }))
    const task: ActiveTask = {
        type: opts.type ?? "parallel",
        mode: "collaborative",
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
        maxErroredMembers: opts.maxErroredMembers,
    }
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
        activeTask: task,
        mutex: new AsyncMutex(),
        directory: mkdtempSync(join(tmpdir(), "octeam-term-")),
    } as unknown as Team
}

describe("checkTermination: member-error tolerance (failure isolation)", () => {
    test("default tolerance 0: any errored member → whole team failed (backward-compat sentinel)", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", status: "idle" },
                { name: "bob", status: "errored", error: "boom" },
            ],
        })
        await checkTermination(makeCtx(), team)
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
    })

    test("within tolerance with survivors → NO-OP (task stays live, barrier delivers)", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", status: "idle" },
                { name: "bob", status: "errored", error: "boom" },
            ],
            maxErroredMembers: 1,
        })
        await checkTermination(makeCtx(), team)
        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
    })

    test("over tolerance → failed", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", status: "errored", error: "a" },
                { name: "bob", status: "errored", error: "b" },
                { name: "carol", status: "idle" },
            ],
            maxErroredMembers: 1,
        })
        await checkTermination(makeCtx(), team)
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
    })

    test("all errored → failed regardless of tolerance (no survivors)", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", status: "errored", error: "a" },
                { name: "bob", status: "errored", error: "b" },
            ],
            maxErroredMembers: 5,
        })
        await checkTermination(makeCtx(), team)
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
    })

    test("sequential mode (pipeline) ignores tolerance: one errored → failed", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", status: "idle" },
                { name: "bob", status: "errored", error: "boom" },
            ],
            type: "pipeline",
            maxErroredMembers: 5, // ignored for sequential modes
        })
        await checkTermination(makeCtx(), team)
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
    })

    test("no errored members → no-op", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", status: "idle" },
                { name: "bob", status: "idle" },
            ],
            maxErroredMembers: 1,
        })
        await checkTermination(makeCtx(), team)
        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
    })
})

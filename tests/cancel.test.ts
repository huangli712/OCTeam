import { afterEach, describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask } from "../src/core/types.js"
import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import { teamCancelTool } from "../src/tools/cancel.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

// --- helpers ---

function makeCtx(storageRoot: string, overrides?: {
    abort?: (req: unknown) => Promise<void>
    promptAsync?: (req: unknown) => Promise<void>
    directory?: string
    sessionID?: string
}): PluginContext {
    return {
        storageRoot,
        scope: "project",
        directory: overrides?.directory ?? "/app",
        client: {
            app: {
                log: mock(async () => {}),
            },
            session: {
                abort: overrides?.abort ?? mock(async () => {}),
                promptAsync: overrides?.promptAsync ?? mock(async () => {}),
                messages: mock(async () => ({ data: [] })),
            },
        },
    } as unknown as PluginContext
}

/** Build a Team wrapper via real disk state, then set busy + activeTask + running members. */
async function makeBusyTeam(
    root: string,
    leadSessionId: string,
    memberNames: string[],
    memberStatuses: Record<string, "running" | "idle"> = {},
    activeTaskOverride?: Partial<ActiveTask>,
) {
    const members = memberNames.map(name =>
        makeMember(name, `ses_${name}`),
    )
    // set statuses
    for (const m of members) {
        if (memberStatuses[m.name]) m.status = memberStatuses[m.name]
    }
    const state = makeState("alpha", leadSessionId, members)
    state.status = "busy"
    await initTeamState(root, state, leadSessionId)
    const team = await loadTeamState(root, "alpha", leadSessionId)
    await team.mutex.runExclusive(async () => {
        team.activeTask = {
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
            ...activeTaskOverride,
        } as ActiveTask
        await saveTeamState(team)
    })
    return team
}

describe("teamCancelTool", () => {
    let root: string

    afterEach(() => {
        // tmpRoot dirs are cleaned up automatically by the OS,
        // but we null-ref the variable to avoid accidental reuse
    })

    test("happy path: busy team with 2 running members — abort called, team returns to idle", async () => {
        root = tmpRoot("cancel-happy")
        const abort = mock(async (_req: unknown) => {})
        const promptAsync = mock(async (_req: unknown) => {})
        const ctx = makeCtx(root, {
            abort,
            promptAsync,
            sessionID: "ses_master",
        })

        await makeBusyTeam(root, "ses_master", ["alice", "bob"], {
            alice: "running",
            bob: "running",
        })

        const tool = teamCancelTool(ctx)
        const result = await tool.execute(
            { team_id: "alpha" },
            { sessionID: "ses_master" },
        )

        // abort called once per running member with correct shape
        expect(abort).toHaveBeenCalledTimes(2)
        const calls = abort.mock.calls as unknown[][]
        for (const call of calls) {
            const req = call[0] as Record<string, unknown>
            const path = req.path as Record<string, string>
            expect(path.id).toMatch(/^ses_/)
            expect(req.query).toBeDefined()
        }

        // summary delivered
        expect(promptAsync).toHaveBeenCalledTimes(1)

        // team is now idle with no activeTask
        const teamAfter = await loadTeamState(root, "alpha", "ses_master")
        expect(teamAfter.status).toBe("idle")
        expect(teamAfter.activeTask).toBeUndefined()
        for (const m of teamAfter.members) {
            expect(m.status).toBe("idle")
            expect(m.declaredDone).toBe(false)
            expect(m.retryingSince).toBeUndefined()
        }
        expect(result).toContain("cancelled")
        expect(result).toContain("idle and reusable")
    })

    test("precondition: team with no activeTask returns error, NO abort/summary, state untouched", async () => {
        root = tmpRoot("cancel-notbusy")
        const abort = mock(async (_req: unknown) => {})
        const promptAsync = mock(async (_req: unknown) => {})
        const ctx = makeCtx(root, {
            abort,
            promptAsync,
            sessionID: "ses_master",
        })

        // Build a team that is "busy" but has NO activeTask (simulating
        // a team that was re-loaded or a state edge case where status
        // and activeTask are out of sync — we use "live" here to bypass
        // the status check and instead rely on activeTask === undefined).
        const state = makeState("alpha", "ses_master", [
            makeMember("alice", "ses_alice"),
        ])
        state.status = "idle" // not busy → precondition rejects
        await initTeamState(root, state, "ses_master")

        const tool = teamCancelTool(ctx)
        const result = await tool.execute(
            { team_id: "alpha" },
            { sessionID: "ses_master" },
        )

        expect(result).toContain("no active orchestration")
        expect(abort).toHaveBeenCalledTimes(0)
        expect(promptAsync).toHaveBeenCalledTimes(0)

        const teamAfter = await loadTeamState(root, "alpha", "ses_master")
        expect(teamAfter.status).toBe("idle")
        expect(teamAfter.activeTask).toBeUndefined()
    })

    test("master-only: non-master sessionID returns error", async () => {
        root = tmpRoot("cancel-masteronly")
        const abort = mock(async (_req: unknown) => {})
        const promptAsync = mock(async (_req: unknown) => {})
        const ctx = makeCtx(root, {
            abort,
            promptAsync,
            sessionID: "ses_master",
        })

        // Store the team under the intruder's directory so loadTeamState finds
        // it, but set leadSessionId to a different session (the real master).
        const state = makeState("alpha", "ses_real_master", [
            makeMember("alice", "ses_alice"),
        ])
        state.status = "busy"
        await initTeamState(root, state, "ses_intruder")
        const team = await loadTeamState(root, "alpha", "ses_intruder")
        await team.mutex.runExclusive(async () => {
            team.activeTask = {
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
            team.members[0].status = "running"
            await saveTeamState(team)
        })

        // Call with the intruder's sessionID (can load, but leadSessionId mismatch)
        const tool = teamCancelTool(ctx)
        const result = await tool.execute(
            { team_id: "alpha" },
            { sessionID: "ses_intruder" },
        )

        expect(result).toContain("master-only")
        expect(abort).toHaveBeenCalledTimes(0)
        expect(promptAsync).toHaveBeenCalledTimes(0)
    })

    test("abort failure is non-fatal: cancel still completes to idle", async () => {
        root = tmpRoot("cancel-abortfail")
        // abort rejects for the second member
        let callCount = 0
        const abort = mock(async (_req: unknown) => {
            callCount++
            if (callCount === 2) throw new Error("abort failed")
        })
        const promptAsync = mock(async (_req: unknown) => {})
        const ctx = makeCtx(root, {
            abort,
            promptAsync,
            sessionID: "ses_master",
        })

        await makeBusyTeam(root, "ses_master", ["alice", "bob"], {
            alice: "running",
            bob: "running",
        })

        const tool = teamCancelTool(ctx)
        const result = await tool.execute(
            { team_id: "alpha" },
            { sessionID: "ses_master" },
        )

        // Both aborts were attempted (first succeeds, second throws caught)
        expect(abort).toHaveBeenCalledTimes(2)
        // Summary still delivered
        expect(promptAsync).toHaveBeenCalledTimes(1)
        // Team still transitions to idle
        const teamAfter = await loadTeamState(root, "alpha", "ses_master")
        expect(teamAfter.status).toBe("idle")
        expect(teamAfter.activeTask).toBeUndefined()
        expect(result).toContain("cancelled")
    })

    test("lingering idle after cancel is a no-op: activeTask cleared, no throw", async () => {
        root = tmpRoot("cancel-lingering")
        const abort = mock(async (_req: unknown) => {})
        const promptAsync = mock(async (_req: unknown) => {})
        const ctx = makeCtx(root, {
            abort,
            promptAsync,
            sessionID: "ses_master",
        })

        await makeBusyTeam(root, "ses_master", ["alice"], { alice: "running" })

        const tool = teamCancelTool(ctx)
        await tool.execute(
            { team_id: "alpha" },
            { sessionID: "ses_master" },
        )

        // After cancel, activeTask is undefined — an idle member event
        // would hit processIdle's early-return guard. Verify the
        // post-cancel state directly (the guard itself is tested in
        // dispatch-context.test.ts; here we confirm the precondition).
        const teamAfter = await loadTeamState(root, "alpha", "ses_master")
        expect(teamAfter.activeTask).toBeUndefined()
        expect(teamAfter.status).toBe("idle")
        // No throw, no side effect — the team is cleanly idle.
    })
})

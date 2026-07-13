import { describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask } from "../src/core/types.js"
import { teamDeactivateTool } from "../src/tools/lifecycle/deactivate.js"
import { initTeamState, invalidateTeam, loadTeamState } from "../src/state/store.js"
import {
    indexMasterTeam,
    isMasterSession,
    resolveMasterTeams,
    setActiveTeam,
    unindexSession,
} from "../src/state/resolve.js"
import { makeCtx, makeState, makeToolContext, tmpRoot } from './helpers.js';

/** Minimal ActiveTask for the busy-state fixture. */
function busyTask(): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
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
    }
}

describe("team_deactivate", () => {
    test("active team → deactivated (disk cleared + memory active pointer cleared)", async () => {
        const root = tmpRoot("deact-active")
        const sid = "ses_deact_active"
        const team = await initTeamState(root, makeState("alpha", sid, [], Date.now()), sid)
        // Seed master index so the post-deactivate memory state is observable.
        indexMasterTeam(sid, team.teamName, sid, root, team.directory)
        setActiveTeam(sid, team.directory)
        expect(isMasterSession(sid)).toBe(true)

        const tool = teamDeactivateTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        expect(result).toContain("deactivated")
        expect(result).toContain("alpha")
        // Disk: activatedAt cleared.
        const reloaded = await loadTeamState(root, "alpha", sid)
        expect(reloaded.activatedAt).toBeUndefined()
        // Memory: team still indexed (deactivate is NOT unindex — only team_delete unindexes),
        // but the session has no active team pointer.
        expect(isMasterSession(sid)).toBe(true)
        expect(resolveMasterTeams(sid).length).toBe(1)

        // Cleanup
        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("inactive team → idempotent no-op with 'already inactive'", async () => {
        const root = tmpRoot("deact-inactive")
        const sid = "ses_deact_inactive"
        const team = await initTeamState(root, makeState("beta", sid), sid) // no activatedAt

        const tool = teamDeactivateTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "beta" },
            makeToolContext(sid),
        )

        expect(result).toContain("already inactive")
        // Disk unchanged: still no activatedAt.
        const reloaded = await loadTeamState(root, "beta", sid)
        expect(reloaded.activatedAt).toBeUndefined()

        // Cleanup
        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("busy team → rejected (preserves busy ⟹ active invariant)", async () => {
        const root = tmpRoot("deact-busy")
        const sid = "ses_deact_busy"
        const state = makeState("gamma", sid, [], Date.now())
        state.status = "busy"
        state.activeTask = busyTask()
        const team = await initTeamState(root, state, sid)

        const tool = teamDeactivateTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "gamma" },
            makeToolContext(sid),
        )

        expect(result).toContain("Error")
        expect(result).toContain("busy")
        // Disk unchanged: still active and busy.
        const reloaded = await loadTeamState(root, "gamma", sid)
        expect(reloaded.activatedAt).not.toBeUndefined()
        expect(reloaded.status).toBe("busy")

        // Cleanup
        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("non-master caller → rejected with master-only", async () => {
        const root = tmpRoot("deact-nonmaster")
        const sid = "ses_deact_nonmaster"
        // Use the flat (user-scope) layout by passing undefined pathLeadSessionId
        // so the team path does NOT depend on the caller's sessionID. In project
        // scope, a non-master caller would fail path resolution first and never
        // reach the leadSessionId check (returns "not found" instead).
        const state = makeState("delta", sid, [], Date.now())
        const team = await initTeamState(root, state, undefined)

        const ctx = { storageRoot: root, scope: "user" } as unknown as PluginContext
        const tool = teamDeactivateTool(ctx)
        // Caller is a different session, not the leader.
        const result = await tool.execute(
            { team_id: "delta" },
            makeToolContext("ses_other"),
        )

        expect(result).toContain("Error")
        expect(result).toContain("master-only")
        // Disk unchanged: still active.
        const reloaded = await loadTeamState(root, "delta", undefined)
        expect(reloaded.activatedAt).not.toBeUndefined()

        // Cleanup
        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("non-existent team → 'not found'", async () => {
        const root = tmpRoot("deact-notfound")
        const sid = "ses_deact_notfound"

        const tool = teamDeactivateTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "ghost" },
            makeToolContext(sid),
        )

        expect(result).toContain("not found")
        // No team was created; no cleanup needed.
    })
})

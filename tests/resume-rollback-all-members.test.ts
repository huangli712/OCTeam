/**
 * Regression: team_resume catch-block rollback must process members that
 * were dispatched during Phase 2 (status="running", turnCount incremented)
 * even when they were idle at Phase 1 entry. Pre-fix code only snapshotted
 * errored members in Phase 1, so the catch-block rollback loop skipped
 * Phase-2-dispatched idle members — they kept running with no activeTask to
 * process their idle event, silently dropping their output.
 *
 * The fix snapshots EVERY member in Phase 1, so the catch loop can find and
 * mark errored any member that turned "running" during the partial resume.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"

import type { ActiveTask } from "../src/core/types.js"
import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import { teamResumeTool } from "../src/tools/control/resume.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeTask, makeToolContext, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)
const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("resume rollback marks Phase-2-dispatched idle members as errored", () => {
    test("a member that turned running during partial resume is marked errored on rollback", async () => {
        const root = tmpRoot("h31-resume")
        const sid = "ses_h31_master"
        tracked.push(sid)
        const task = makeTask({}) as ActiveTask
        // Two members: alice (idle) and bob (errored). Phase 1 will reset bob
        // to idle. Phase 2 will dispatch BOTH alice and bob. We engineer Phase 2
        // to throw AFTER the first dispatch (alice) succeeds — bob never gets
        // dispatched but alice is left running.
        // For the test: install a promptAsync that succeeds for alice then
        // throws for bob.
        const state = makeState("alpha", sid, [
            makeMember("alice", "ses_h31_alice"),
            { ...makeMember("bob", "ses_h31_bob"), status: "errored" as const, error: "prev fail" },
        ], Date.now())
        state.status = "failed"
        await initTeamState(root, state, sid)
        const team = await loadTeamState(root, "alpha", sid)
        await team.mutex.runExclusive(async () => {
            team.lastInterruptedTask = task
            await saveTeamState(team)
        })
        await rebuildSessionIndex(root, `${root}__unused`)

        let dispatchCount = 0
        const ctx = makeCtx({
            storageRoot: root,
            promptAsync: async () => {
                dispatchCount += 1
                if (dispatchCount >= 2) {
                    throw new Error("synthesized Phase 2 failure on second dispatch")
                }
                return { data: {} }
            },
        })

        const result = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        // Resume failed and checkpoint preserved.
        expect(result).toMatch(/resume failed/i)
        expect(result).toContain("checkpoint preserved")

        // Reload to inspect persisted state.
        const after = await loadTeamState(root, "alpha", sid)
        // Contract: alice (Phase-2-dispatched, turned running) MUST be
        // marked errored. Pre-fix: she was not in the Phase 1 snapshot, so the
        // rollback loop skipped her — she stayed "running" with no activeTask.
        const alice = after.members.find(m => m.name === "alice")!
        expect(alice.status).toBe("errored")
        expect(alice.error).toMatch(/resume dispatch failed/i)
        // activeTask MUST be cleared (rolled back).
        expect(after.activeTask).toBeUndefined()
        expect(after.status).toBe("failed")
    })
})

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import type { ActiveTask } from "../src/core/types.js"
import { startOrchestration } from "../src/orchestration/start-orchestration.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})
afterAll(cleanupTmpRoots)

async function setupTeam(
    root: string,
    sid: string,
    members = [makeMember("alice", "ses_alice"), makeMember("bob", "ses_bob")],
    activatedAt?: number,
): Promise<void> {
    await initTeamState(root, makeState("alpha", sid, members, activatedAt), sid)
    await rebuildSessionIndex(root, `${root}__unused`)
}

// Regression test for finding "dispatch-failure-wedges-team".
//
// startOrchestration() persists team.status="busy" + team.activeTask (and
// saveTeamState()) BEFORE invoking the dispatch callback. If dispatch throws,
// there is no synchronous rollback: the team is left wedged in busy state with
// an active orchestration recorded, requiring external recovery to clear.
//
// On the CURRENT (unfixed) code this test MUST FAIL — the post-throw team is
// still busy with an activeTask. Once rollback is added, it passes.
describe("startOrchestration dispatch-failure rollback", () => {
    test("dispatch throw does not wedge team in busy+activeTask state", async () => {
        const root = tmpRoot("dispatch-wedge")
        const sid = "ses_wedge_master"
        tracked.push(sid)
        // Members carry sessionIds so ensureMembersReady() is a no-op; the
        // team is activated so the activation gate passes.
        await setupTeam(root, sid, undefined, Date.now())

        const dispatchError = new Error("dispatch boom")
        const minimalTask = {
            type: "parallel",
            startedAt: Date.now(),
            wallClockTimeoutMs: 300_000,
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            responses: {},
        } as ActiveTask

        // startOrchestration should reject because dispatch throws.
        expect(
            startOrchestration(
                "alpha",
                makeToolContext(sid),
                makeCtx({ storageRoot: root }),
                "team_test",
                () => null,
                async () => minimalTask,
                async () => {
                    throw dispatchError
                },
                () => "ok",
            ),
        ).rejects.toThrow("dispatch boom")

        // Reload team state from disk and assert rollback occurred: the team
        // must NOT remain wedged in busy + activeTask.
        const team = await loadTeamState(root, "alpha", sid)
        expect(team.status).not.toBe("busy")
        // activeTask?: ActiveTask (ActiveTask | undefined per types.ts). Accept
        // either undefined or null — both mean "no active task remains"; a
        // wedged task object is truthy and would fail this assertion.
        expect(team.activeTask).toBeFalsy()
    })
})

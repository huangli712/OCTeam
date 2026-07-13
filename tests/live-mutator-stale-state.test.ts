/**
 * Regression test for confirmed finding "live-mutators-stale-state-check".
 *
 * Bug: src/tools/lifecycle/add.ts:40, remove.ts:32, rename.ts:42, and fix.ts:43 check
 * live/idle preconditions BEFORE taking team.mutex, then mutate member/team
 * state INSIDE the lock without rechecking. startOrchestration (shared.ts)
 * flips team.status from "live" to "busy" and commits team.activeTask UNDER
 * the same mutex. So a live-mutator that read status==="live" OUTSIDE the lock
 * can have its critical section serialize AFTER orchestration startup's commit
 * — landing its mutation during an active run (members added/removed/renamed
 * while activeTask references the old member set → corrupt state, dangling
 * references in stages/responses/tokensByMember, broken spawn/active-run
 * invariants).
 *
 * Fix: re-check the precondition INSIDE team.mutex.runExclusive before mutating;
 * if status is no longer "live" (or is now "busy"), refuse.
 *
 * This test deterministically reproduces the race for team_add_member (the
 * finding's representative tool). It pre-holds the mutex so add reads
 * status==="live" and passes the gate, flips status to "busy" + commits an
 * activeTask (mimicking startOrchestration Phase 3) while add is blocked, then
 * releases. On UNFIXED code add's critical section runs against the now-busy
 * team and pushes a new member; on FIXED code add re-checks inside the mutex
 * and refuses.
 */

import { afterEach, describe, expect, test } from "bun:test"

import type { ToolContext } from "@opencode-ai/plugin"
import type { ParallelTask } from "../src/core/types.js"
import { teamAddMemberTool } from "../src/tools/lifecycle/add.js"
import { initTeamState, loadTeamState, writeTeamSpec } from "../src/state/store.js"
import { unindexSession } from "../src/state/resolve.js"
import { makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"
import type { TeamSpec } from "../src/core/types.js"


/** Minimal busy parallel task, the shape startOrchestration commits. */
function makeBusyTask(): ParallelTask {
    return {
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
        task: "do work",
    }
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("live-mutator stale-state check (finding: live-mutators-stale-state-check)", () => {
    test("team_add_member that read status='live' must NOT mutate once orchestration flips it to 'busy'", async () => {
        const root = tmpRoot("mutator-stale")
        const leadSid = "ses_lead_mutator"
        tracked.push(leadSid)

        // --- Set up a LIVE team with one existing member + matching spec ---
        const alice = makeMember("alice")
        await initTeamState(root, makeState("alpha", leadSid, [alice]), leadSid)
        const spec: TeamSpec = {
            version: 1,
            name: "alpha",
            createdAt: Date.now(),
            members: [{ name: "alice", role: "coder", prompt: "code", agent: "oct-junior" }],
        }
        await writeTeamSpec(root, spec, leadSid)
        const team = await loadTeamState(root, "alpha", leadSid)
        const membersBefore = team.members.length
        expect(team.status).toBe("live")

        // --- Pre-hold the mutex so add's critical section blocks ---
        let releaseGate!: () => void
        const gate = new Promise<void>(r => { releaseGate = r })
        const mutexHold = team.mutex.runExclusive(async () => { await gate })

        // --- Fire team_add_member (master caller). It reads status==="live"
        //     at add.ts:40 OUTSIDE the mutex, passes the gate, then blocks at
        //     add.ts:104 waiting for the mutex. ---
        const tool = teamAddMemberTool(makeCtx({ storageRoot: root }))
        const addPromise = tool.execute(
            { team_id: "alpha", role: "coder", prompt: "p", agent: "oct-junior" },
            { sessionID: leadSid } as unknown as ToolContext,
        )

        // Drain microtasks so add progresses through loadTeamState, the
        // outside-mutex status check, and parks on team.mutex.runExclusive.
        await new Promise(r => setTimeout(r, 20))

        // --- Simulate concurrent orchestration startup committing a run UNDER
        //     the mutex (mirrors shared.ts Phase 3: status="busy" + activeTask).
        //     We mutate the same in-memory Team object the registry handed both
        //     the test and the tool, so add's critical section WILL observe
        //     these mutations when it enters the mutex next. ---
        team.status = "busy"
        team.activeTask = makeBusyTask()

        // --- Release: add's critical section now runs against the busy team. ---
        releaseGate()
        await mutexHold
        const result = await addPromise

        // The mutator MUST have refused: the team is now "busy" (an active
        // run references the member set). On UNFIXED code add blindly pushes
        // the new member and returns success, so BOTH assertions fail:
        //   - a new member appears despite the busy run
        //   - the tool reports success instead of a stale-state error
        // On FIXED code add re-checks status inside the mutex, refuses, and
        // leaves the member set untouched.
        const addedDuringBusy = team.members.length > membersBefore
        const reportedSuccess = !/Error:.*(?:not "live"|"busy")/i.test(result)

        expect(addedDuringBusy).toBe(false)
        expect(reportedSuccess).toBe(false)
    })
})

/**
 * Regression test for confirmed finding "stale-team-done-ack".
 *
 * Bug: src/tools/done.ts:46 reads team.activeTask OUTSIDE team.mutex and
 * validates the run (type / mode / requireDoneAck). Then at line 61 it enters
 * the mutex and sets member.declaredDone = true (line 68) WITHOUT revalidating
 * that the active run is still the same one that was validated outside. A stale
 * ack — delayed by the race window between the outside-mutex read (line 46) and
 * the inside-mutex write (line 68) — can set declaredDone for a DIFFERENT run,
 * bleeding into that run's require_done_ack barrier and allowing premature
 * completion (barriers.ts:37 treats declaredDone===true as "ready").
 *
 * The race is real because run changes happen INSIDE the mutex
 * (startOrchestration commits activeTask + resets declaredDone at
 * shared.ts:246-254 under team.mutex). team_done's critical section is
 * serialized AFTER such a commit, so it sees the NEW run's state but still
 * applies the OLD run's ack.
 *
 * Fix: inside the mutex, revalidate that team.activeTask is still the same run
 * (by runId or reference equality) before setting declaredDone. If the run
 * changed, refuse the stale ack.
 *
 * This test deterministically reproduces the race by pre-holding the mutex so
 * team_done reads activeTask=runN, then swapping activeTask to a new runN+1
 * (with declaredDone reset, exactly as startOrchestration does) before
 * releasing. On unfixed code the stale ack sets declaredDone=true for the wrong
 * run; on fixed code it is refused and declaredDone stays false.
 */

import { afterEach, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { ToolContext } from "@opencode-ai/plugin"
import type { ParallelTask } from "../src/core/types.js"
import { teamDoneTool } from "../src/tools/done.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { indexMember, unindexSession } from "../src/state/resolve.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

function makeCtx(storageRoot: string): PluginContext {
    return { storageRoot, scope: "project" } as unknown as PluginContext
}

/** Build a minimal parallel/isolated task with require_done_ack enabled. */
function makeParallelAckTask(runId: string, taskText: string): ParallelTask {
    return {
        type: "parallel",
        mode: "isolated",
        requireDoneAck: true,
        runId,
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
        task: taskText,
    }
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("stale team_done ack across runs (finding: stale-team-done-ack)", () => {
    test("a team_done ack that lands during a DIFFERENT run must not set declaredDone", async () => {
        const root = tmpRoot("done-ack-stale")
        const leadSid = "ses_lead_done_ack"
        const aliceSid = "ses_alice_done_ack"
        tracked.push(aliceSid)

        // Set up a live team with alice as a member.
        const alice = makeMember("alice", aliceSid)
        const state = makeState("alpha", leadSid, [alice])
        await initTeamState(root, state, leadSid)
        const team = await loadTeamState(root, "alpha", leadSid)
        indexMember(aliceSid, "alpha", "alice", leadSid, root)

        // --- Run N: parallel/isolated with require_done_ack ---
        const runN = makeParallelAckTask("run-N", "do run N work")
        team.activeTask = runN

        // Pre-hold the team mutex. team_done will read activeTask=runN at
        // done.ts:46 (OUTSIDE the mutex), pass validation, then BLOCK at
        // done.ts:61 waiting for us to release.
        let releaseGate!: () => void
        const gate = new Promise<void>(r => { releaseGate = r })
        const mutexHold = team.mutex.runExclusive(async () => { await gate })

        // Start team_done for alice (don't await yet — it will block on mutex).
        const tool = teamDoneTool(makeCtx(root))
        const donePromise = tool.execute(
            { team_id: "alpha" },
            { sessionID: aliceSid } as unknown as ToolContext,
        )

        // Drain all pending microtasks so team_done progresses through its
        // pre-mutex awaits (resolveCallerInTeam → loadTeamState →
        // loadTeamState), reads activeTask=runN at line 46, validates, and
        // blocks on the mutex at line 61. setTimeout guarantees every
        // chained microtask has flushed before we proceed.
        await new Promise(r => setTimeout(r, 20))

        // --- Simulate the race window: run N ends, run N+1 starts ---
        // startOrchestration commits the new run inside team.mutex and resets
        // declaredDone=false for all members (shared.ts:246-254). We perform
        // the identical mutation directly on the in-memory team object — this
        // is the state team_done's critical section WILL see when it enters
        // the mutex after we release (mutex serializes them in this order).
        // runN+1 has the SAME type/mode/requireDoneAck as runN but a DIFFERENT
        // runId, so only a run-identity revalidation (not a mere type recheck)
        // can catch the stale ack.
        const runNplus1 = makeParallelAckTask("run-N+1", "do run N+1 work")
        team.activeTask = runNplus1
        const aliceMem = team.members.find(m => m.name === "alice")!
        aliceMem.declaredDone = false // reset by run N+1's commit

        // Release the mutex — team_done's critical section now runs.
        releaseGate()
        await mutexHold
        await donePromise

        // The stale ack (intended for run N) must NOT have set declaredDone
        // for run N+1. On the UNFIXED code, done.ts:68 blindly sets
        // declaredDone=true inside the mutex without revalidating the active
        // run, so this assertion FAILS (got true). Once the fix revalidates
        // run identity inside the mutex, the ack is refused and this PASSES.
        expect(aliceMem.declaredDone).toBe(false)
    })
})

/**
 * Regression test for confirmed finding "summary-delivery-failure-swallowed".
 *
 * Bug: src/orchestration/control/completion.ts — deliverSummaryToLeader swallows
 * the leader promptAsync failure:
 *   await ctx.client.session.promptAsync({ ... }).catch(err =>
 *       logSwallowed(ctx, "deliver summary to leader failed", err, ...),
 *   )
 * The function ALWAYS resolves (void), regardless of whether the leader
 * actually received the summary. Callers (parallel.ts:50-52, consensus.ts,
 * loop.ts, delegate.ts, etc.) then unconditionally:
 *   clearActiveTask(team)     // clears the run
 *   team.status = "idle"      // marks the team done
 * The user never receives the completion summary, yet the system proceeds as
 * if delivery succeeded — the active task is cleared and cannot be retried.
 *
 * Harm: a transient leader-session error (leader session gone, host API
 * outage, rate limit) silently drops the entire workflow result. The team
 * transitions to idle/failed with no summary delivered and no way to retry
 * (activeTask is already cleared). The user sees a team "finish" with no
 * output.
 *
 * Fix: deliverSummaryToLeader must propagate the promptAsync failure so
 * callers can decide whether to retry delivery or at minimum avoid clearing
 * the active task / reporting success when the summary was never delivered.
 *
 * This test calls deliverSummaryToLeader with a mock PluginContext whose
 * promptAsync throws, and asserts the failure must propagate (reject).
 *   UNFIXED: .catch(logSwallowed) swallows the error → resolves with void
 *            → rejects assertion FAILS ("Expected promise that rejects").
 *   FIXED:   promptAsync failure propagates → rejects → assertion PASSES.
 */

import { afterAll, describe, expect, mock, test } from "bun:test"

import { deliverSummaryToLeader } from '../src/orchestration/runtime/completion.js';
import type { ActiveTask } from "../src/core/types.js"
import type { PluginContext } from "../src/core/context.js"
import { cleanupTmpRoots, makeTeam, tmpRoot } from "./helpers.js"

/** PluginContext whose promptAsync always throws (simulates leader delivery failure). */
function makeFailingCtx(): PluginContext {
    return {
        directory: "/app",
        client: {
            session: {
                promptAsync: mock(async () => {
                    throw new Error("simulated leader promptAsync failure")
                }),
            },
            app: {
                log: mock(async () => ({})),
            },
        },
    } as unknown as PluginContext
}

function makeParallelTask(): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300_000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: { alice: "task complete" },
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        reducePolicy: "summarize",
        signoffPolicy: "none",
    } as ActiveTask
}


afterAll(cleanupTmpRoots)

describe("deliverSummaryToLeader failure swallowed (finding: summary-delivery-failure-swallowed)", () => {
    test("leader promptAsync failure must propagate, not be swallowed", async () => {
        const root = tmpRoot("summary-swallowed")
        const teamDir = `${root}/team`
        const task = makeParallelTask()
        const team = makeTeam({ directory: teamDir, activeTask: task })

        // deliverSummaryToLeader builds the summary, persists the run record
        // (best-effort), records the terminated event, then calls
        // promptAsync at :48. The .catch at :59 swallows the failure.
        //
        // UNFIXED: .catch(logSwallowed) → resolves with void → rejects FAILS.
        // FIXED:   promptAsync failure propagates → rejects → PASSES.
        expect(
            deliverSummaryToLeader(makeFailingCtx(), team, "parallel_isolated_complete", "completed"),
        ).rejects.toThrow("simulated leader promptAsync failure")
    })
})

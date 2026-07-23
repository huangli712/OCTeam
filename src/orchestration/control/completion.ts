/**
 * Run-completion control: build and deliver the final summary, persist the run
 * record, emit termination telemetry, then clear the active task.
 */

import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
import type { RunStatus } from "../../core/types.js"
import { type Team, clearActiveTask } from "../../state/store.js"
import { recordEvent } from "../records/events.js"
import { persistRun } from "../records/runs.js"
import { buildSummary } from "../records/summary.js"

/**
 * Build and deliver the active run summary to the team leader.
 *
 * Ordering is intentional: emit the terminal event and persist the run while
 * activeTask still carries its runId, then wake the leader. Persistence is
 * best-effort and must not suppress result delivery.
 */
export async function deliverSummaryToLeader(
    ctx: PluginContext,
    team: Team,
    reason: string,
    status?: RunStatus,
): Promise<void> {
    if (!team.activeTask) return
    const summary = await buildSummary(team, team.activeTask, reason)
    recordEvent(team, { timestamp: Date.now(), kind: "terminated", reason })
    await persistRun(team, reason, status).catch(err =>
        logSwallowed(ctx, "persist run record failed", err, {
            team: team.teamName,
            reason,
        }),
    )
    await ctx.client.session.promptAsync({
        path: { id: team.leadSessionId },
        body: {
            parts: [
                {
                    type: "text",
                    text: `<team_result team="${team.teamName}">\n${summary}\n</team_result>\n` +
                        `<!-- OMO_INTERNAL_INITIATOR -->`,
                    synthetic: false,
                },
            ],
        },
    })
}

/**
 * Complete a run through the canonical teardown sequence: deliver the summary,
 * clear activeTask, then expose the terminal team status.
 *
 * Callers that need work between delivery and cleanup must invoke
 * deliverSummaryToLeader directly and perform the remaining steps themselves.
 */
export async function finishRun(
ctx: PluginContext,
team: Team,
reason: string,
status: "idle" | "failed",
): Promise<void> {
    try {
        await deliverSummaryToLeader(
            ctx,
            team,
            reason,
            status === "failed" ? "failed" : "completed",
        )
    } finally {
        // clearActiveTask and terminal status MUST execute even if delivery
        // throws — otherwise the team is stuck in "busy" with an activeTask
        // that can never be cleared.
        clearActiveTask(team)
        team.status = status
    }
}

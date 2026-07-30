/**
 * Run-completion control: build and deliver the final summary, persist the run
 * record, emit termination telemetry, then clear the active task.
 */

import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
import type { RunStatus } from "../../core/types.js"
import { type Team, clearActiveTask, saveTeamStateBounded } from "../../state/store.js"
import { asSdkMessages } from "../protocol/output.js"
import { sumMemberTokens } from "../protocol/output.js"
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
    // M-6: persist the run record FIRST (before building the summary), so a
    // summary-build or prompt-throw does not lose the run entirely. Pre-fix
    // code built the summary first; if buildSummary threw (e.g. a transient
    // task-list IO error), persistRun never ran and the run record was
    // permanently lost. The persisted record carries the minimal metadata
    // (runId, tokens, members, steps) without the formatted summary, so even
    // a failed summary leaves a queryable run entry.
    recordEvent(team, { timestamp: Date.now(), kind: "terminated", reason })
    await persistRun(team, reason, status).catch(err =>
        logSwallowed(ctx, "persist run record failed", err, {
            team: team.teamName,
            reason,
        }, "warn"),
    )
    // Build and deliver the summary. A throw here is caught by finishRun's
    // finally block; the run record is already persisted.
    const summary = await buildSummary(team, team.activeTask, reason)
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
runStatusOverride?: RunStatus,
): Promise<void> {
    const runStatus: RunStatus = runStatusOverride ?? (status === "failed" ? "failed" : "completed")
    // M25 fix: best-effort token refresh before terminal persistence.
    // Pre-fix code skipped token refresh on timeout/retry-escalation/session-error
    // paths, so the final token count underestimated actual usage. Refresh
    // for all running members; failures are best-effort (network errors do
    // not block termination).
    if (team.activeTask) {
        for (const m of team.members) {
            if (!m.isMaster && m.sessionId && m.status === "running") {
                try {
                    const msgs = await ctx.client.session.messages({ path: { id: m.sessionId } })
                    const messages = asSdkMessages(msgs.data)
                    const baseline = team.activeTask.tokenBaselineByMember?.[m.name] ?? 0
                    team.activeTask.tokensByMember![m.name] = Math.max(
                        team.activeTask.tokensByMember?.[m.name] ?? 0,
                        Math.max(0, sumMemberTokens(messages) - baseline),
                    )
                } catch {
                    // best-effort — keep existing token count if refresh fails
                }
            }
        }
    }
    try {
        await deliverSummaryToLeader(
            ctx,
            team,
            reason,
            runStatus,
        )
    } finally {
        // clearActiveTask and terminal status MUST execute even if delivery
        // throws — otherwise the team is stuck in "busy" with an activeTask
        // that can never be cleared.
        clearActiveTask(team)
        team.status = status
        // H-12/G: persist the terminal state with bounded retry. Pre-fix code
        // used `.catch(logSwallowed)` which left disk showing "busy" indefinitely
        // after a transient I/O error. saveTeamStateBounded retries 3x before
        // throwing; the catch here logs but cannot rollback (the run IS finished
        // — restoring activeTask would be incorrect).
        try {
            await saveTeamStateBounded(team)
        } catch (err) {
            logSwallowed(ctx, "finishRun: terminal state persist failed after retries", err, {
                team: team.teamName,
                reason,
                status,
            }, "error")
        }
    }
}

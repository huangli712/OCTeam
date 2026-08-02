/**
 * Run-completion control: build and deliver the final summary, persist the run
 * record, emit termination telemetry, then clear the active task.
 */

import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
import type { RunStatus } from "../../core/types.js"
import { type Team, clearActiveTask, saveTeamStateBounded } from "../../state/store.js"
import { trustedLeadSessionId } from "../../state/resolve.js"
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
    // P4: use the index-verified leadSessionId instead of the disk-tamperable
    // team.leadSessionId. A state.json swap cannot redirect run output to an
    // attacker-controlled session. Fall back to team.leadSessionId only when
    // the index has no entry (very early in team_create before indexing).
    const deliveryTarget = trustedLeadSessionId(team.directory) ?? team.leadSessionId
    await ctx.client.session.promptAsync({
        path: { id: deliveryTarget },
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
    // for all running or errored members; failures are best-effort (network errors do
    // not block termination).
    if (team.activeTask) {
        for (const m of team.members) {
            if (!m.isMaster && m.sessionId && (m.status === "running" || m.status === "errored")) {
                try {
                    const msgs = await ctx.client.session.messages({ path: { id: m.sessionId } })
                    const messages = asSdkMessages(msgs.data)
                    const baseline = team.activeTask.tokenBaselineByMember?.[m.name] ?? 0
                    team.activeTask.tokensByMember![m.name] = Math.max(
                        team.activeTask.tokensByMember?.[m.name] ?? 0,
                        Math.max(0, sumMemberTokens(messages) - baseline),
                    )
                } catch (err) {
                    // H-H1: log refresh failures with context so operators can
                    // investigate token underestimation. Pre-fix code swallowed
                    // silently.
                    logSwallowed(ctx, "finishRun: token refresh failed", err, { member: m.name, session: m.sessionId })
                }
            }
        }
        // H-H2: recompute tokensUsed from tokensByMember after refreshing.
        // Pre-fix code updated per-member counts but left tokensUsed stale,
        // so run records and termination summaries reported old totals.
        if (team.activeTask.tokensByMember) {
            team.activeTask.tokensUsed = Object.values(team.activeTask.tokensByMember).reduce((a, b) => a + b, 0)
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
        // #11: best-effort abort any still-running member sessions before
        // clearing activeTask. On timeout/budget-failure/partial-spawn-
        // failure, running sessions are not stopped — their late output can
        // be misattributed to the next run. A best-effort abort is better
        // than nothing; failures are swallowed (the run IS terminating).
        for (const m of team.members) {
            // HIGH #8: abort running AND retrying members. Pre-fix code only
            // checked status==="running"; sustained-retry members (errored
            // with retryingSince) keep consuming tokens after the run ends.
            if (!m.isMaster && m.sessionId
                && (m.status === "running" || m.status === "errored" || m.retryingSince !== undefined)) {
                try {
                    await ctx.client.session.abort({
                        path: { id: m.sessionId },
                        query: { directory: m.worktreePath ?? ctx.directory },
                    })
                    // HIGH: set to idle on successful abort so the session
                    // is clean for the next run.
                    m.status = "idle"
                    m.retryingSince = undefined
                } catch (err) {
                    logSwallowed(ctx, "finishRun: best-effort session.abort failed", err, {
                        member: m.name, session: m.sessionId,
                    }, "debug")
                }
            }
        }
        // Persist a terminal view before clearing the live activeTask. If the
        // bounded save fails, the in-memory task remains available for retry.
        const terminalTeam: Team = { ...team, status }
        clearActiveTask(terminalTeam)
        try {
            await saveTeamStateBounded(terminalTeam)
        } catch (err) {
            logSwallowed(ctx, "finishRun: terminal state persist failed after retries", err, {
                team: team.teamName,
                reason,
                status,
            }, "error")
            throw err
        }
        team._diskSnapshot = terminalTeam._diskSnapshot
        team._diskMtime = terminalTeam._diskMtime
        team.status = status
        clearActiveTask(team)
    }
}

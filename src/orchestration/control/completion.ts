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
 * Deliver a message with bounded retries through one shared prompt body.
 */
async function deliverWithRetry(
    ctx: PluginContext,
    session: PluginContext["client"]["session"],
    target: string,
    teamName: string,
    summary: string,
): Promise<void> {
    const text = `<team_result team="${teamName}">\n${summary}\n</team_result>\n<!-- OMO_INTERNAL_INITIATOR -->`
    const maxAttempts = 3
    let lastErr: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await session.promptAsync({
                path: { id: target },
                body: { parts: [{ type: "text", text, synthetic: false }] },
            })
            return  // success
        } catch (err) {
            lastErr = err
            if (attempt < maxAttempts) {
                await new Promise(r => {
                    const t = setTimeout(r, 500 * attempt)
                    t.unref()
                })
            }
        }
    }
    logSwallowed(ctx, "deliverSummaryToLeader: all delivery attempts failed", lastErr as Error, {
        team: teamName, attempts: maxAttempts,
    }, "error")
    throw lastErr
}

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
    // Persist the run record before building the summary so summary or delivery
    // failures cannot erase the run. The record retains queryable metadata even
    // when formatted summary construction fails.
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
    // Prefer the index-verified leadSessionId. The disk-tamperable
    // team.leadSessionId is only used when the trusted index has no entry
    // (very early in team_create before indexing, or sentinel validation
    // failed). In the latter case, log prominently so operators can detect
    // potential tampering.
    const trustedTarget = trustedLeadSessionId(team.directory)
    const deliveryTarget = trustedTarget ?? team.leadSessionId
    if (!trustedTarget) {
        logSwallowed(ctx, "finishRun: trusted leadSessionId unavailable; falling back to team.leadSessionId (possible tampering risk)", undefined, { team: team.teamName })
    }
    await deliverWithRetry(ctx, ctx.client.session, deliveryTarget, team.teamName, summary)
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
    // Refresh token usage before terminal persistence across timeout, retry
    // escalation, and session-error paths. Query failures are best effort and
    // do not block termination.
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
                    // Log refresh failures with context so operators can
                    // investigate token underestimation.
                    logSwallowed(ctx, "finishRun: token refresh failed", err, { member: m.name, session: m.sessionId })
                }
            }
        }
        // Recompute tokensUsed after refreshing per-member counts so run records
        // and termination summaries use the current total.
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
        // Best-effort abort any still-running member sessions before clearing
        // activeTask so late output cannot be misattributed to the next run.
        // Failures are swallowed because the run is already terminating.
        for (const m of team.members) {
            // Abort both running and retrying members so sustained retries do
            // not continue consuming tokens after the run ends.
            if (!m.isMaster && m.sessionId
                && (m.status === "running" || m.status === "errored" || m.retryingSince !== undefined)) {
                try {
                    await ctx.client.session.abort({
                        path: { id: m.sessionId },
                        query: { directory: m.worktreePath ?? ctx.directory },
                    })
                    // Set the member idle on successful abort so the session
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

import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
import type { RunStatus } from "../../core/types.js"
import { type Team, clearActiveTask } from "../../state/store.js"
import { recordEvent } from "../records/events.js"
import { persistRun } from "../records/runs.js"
import { buildSummary } from "../records/summary.js"

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
                    text: `<team_result team="${team.teamName}">\n${summary}\n</team_result>`,
                    synthetic: true,
                },
            ],
        },
    })
}

export async function finishRun(
    ctx: PluginContext,
    team: Team,
    reason: string,
    status: "idle" | "failed",
): Promise<void> {
    await deliverSummaryToLeader(
        ctx,
        team,
        reason,
        status === "failed" ? "failed" : "completed",
    )
    clearActiveTask(team)
    team.status = status
}

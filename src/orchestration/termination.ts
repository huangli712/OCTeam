/**
 * Termination checks (design §6 checkTermination). Enforces wall-clock timeout,
 * token budget, and member-error exit conditions. Called from processIdle after
 * each dispatch AND from the sweep timer so these conditions fire even with no
 * idle events arriving.
 */

import type { PluginContext } from "../context.js"
import type { Team } from "../state/store.js"
import { deliverSummaryToLeader } from "./summary.js"

/**
 * Check the active task's termination conditions and, if met, deliver a summary
 * to the leader and tear down the active task. No-op if no active task.
 */
export async function checkTermination(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task) return

    // Wall-clock timeout
    if (Date.now() - task.startedAt > task.wallClockTimeoutMs) {
        await deliverSummaryToLeader(ctx, team, "timeout")
        team.activeTask = undefined
        team.status = "failed"
        return
    }

    // Token budget
    if (task.tokenBudget !== undefined && task.tokensUsed > task.tokenBudget) {
        await deliverSummaryToLeader(ctx, team, "budget_exceeded")
        team.activeTask = undefined
        team.status = "failed"
        return
    }

    // Member error
    const errored = team.members.find(m => m.status === "errored")
    if (errored) {
        await deliverSummaryToLeader(ctx, team, `member_error:${errored.name}:${errored.error ?? "unknown"}`)
        team.activeTask = undefined
        team.status = "failed"
        return
    }
}

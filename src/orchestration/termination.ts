/**
 * Termination checks (design §6 checkTermination). Enforces wall-clock timeout,
 * token budget, and member-error exit conditions. Called from processIdle after
 * each dispatch AND from the sweep timer so these conditions fire even with no
 * idle events arriving.
 */

import type { PluginContext } from "../core/context.js"
import { clearActiveTask } from '../state/store.js';
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
        clearActiveTask(team)
        team.status = "failed"
        return
    }

    // Token budget
    if (task.tokenBudget !== undefined && task.tokensUsed > task.tokenBudget) {
        await deliverSummaryToLeader(ctx, team, "budget_exceeded")
        clearActiveTask(team)
        team.status = "failed"
        return
    }

    // Member turn limit (§8.1 maxMemberTurns): stop a runaway member. turnCount is
    // bumped at each dispatch; once it exceeds the bound the orchestration is failed.
    const overTurns = team.members.find(
        m => !m.isMaster && m.turnCount > team.bounds.maxMemberTurns,
    )
    if (overTurns) {
        await deliverSummaryToLeader(ctx, team, `member_turn_limit:${overTurns.name}`)
        clearActiveTask(team)
        team.status = "failed"
        return
    }

    // Member error
    const errored = team.members.find(m => m.status === "errored")
    if (errored) {
        await deliverSummaryToLeader(ctx, team, `member_error:${errored.name}:${errored.error ?? "unknown"}`)
        clearActiveTask(team)
        team.status = "failed"
        return
    }
}

/**
 * Termination checks. Enforces wall-clock timeout,
 * token budget, and member-error exit conditions. Called from processIdle after
 * each dispatch AND from the sweep timer so these conditions fire even with no
 * idle events arriving.
 */

import type { PluginContext } from "../core/context.js"
import type { Team } from "../state/store.js"
import { finishRun } from "./summary.js"

/**
 * Check the active task's termination conditions and, if met, deliver a summary
 * to the leader and tear down the active task. No-op if no active task.
 */
export async function checkTermination(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task) return

    // Wall-clock timeout. Human approval pauses suspend wall-clock accounting;
    // team_approve/team_reject shifts startedAt by the paused duration on resume.
    if (!task.approvalStage && Date.now() - task.startedAt > task.wallClockTimeoutMs) {
        await finishRun(ctx, team, "timeout", "failed")
        return
    }

    // Token budget
    if (task.tokenBudget !== undefined && task.tokensUsed > task.tokenBudget) {
        await finishRun(ctx, team, "budget_exceeded", "failed")
        return
    }

    // Member turn limit: stop a runaway member. turnCount is
    // bumped at each dispatch; once it exceeds the bound the orchestration is failed.
    const overTurns = team.members.find(
        m => !m.isMaster && m.turnCount > team.bounds.maxMemberTurns,
    )
    if (overTurns) {
        await finishRun(ctx, team, `member_turn_limit:${overTurns.name}`, "failed")
        return
    }

    // Member error (tolerance-aware fail-fast). Concurrent modes (parallel/
    // delegate) tolerate up to maxErroredMembers; the barrier (handleParallelIdle)
    // / handleDelegateIdle owns succeed-with-survivors. checkTermination owns ONLY
    // the fail decisions: all-errored, or over-tolerance. Sequential modes
    // (pipeline/loop/consensus) get tolerance 0 — one active member, no survivors.
    const erroredMembers = team.members.filter(m => !m.isMaster && m.status === "errored")
    if (erroredMembers.length > 0) {
        const concurrent = task.type === "parallel" || task.type === "delegate" || task.type === "recurse"
        const tolerance = concurrent ? (task.maxErroredMembers ?? 0) : 0
        const survivors = team.members.filter(m => !m.isMaster).length - erroredMembers.length
        if (erroredMembers.length > tolerance || survivors === 0) {
            const first = erroredMembers[0]
            await finishRun(ctx, team, `member_error:${first.name}:${first.error ?? "unknown"}`, "failed")
            return
        }
        // within tolerance with survivors → NO-OP. The barrier delivers survivors.
    }
}

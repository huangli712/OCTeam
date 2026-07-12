/**
 * Loop handler -- round-based decider loop with feedback injection into the
 * next round. Honors genuine-completion and max_rounds checks.
 *
 * STATE MACHINE:
 *   decider_dispatch → parse_decision → [done | no_issues | max_rounds | parse_fail | next_round]
 *   - Decider says "done" → deliver (idle: loop_complete:decider_done)
 *   - All read-only stages report <no_issues/> → deliver (idle: loop_complete:no_issues)
 *   - Max rounds exceeded → deliver (failed: loop_complete:max_rounds)
 *   - Decision parse failure (≥3 retries) → deliver (failed: loop_complete:decision_parse_failure)
 *   - Else → next round with decider feedback injected into member prompts
 */

import type { PluginContext } from "../../core/context.js"
import { logEvent } from "../../core/log.js"
import { type Team, clearActiveTask } from "../../state/store.js"
import type { MemberState } from "../../core/types.js"
import { advanceToStage } from "../runtime/dispatch.js"
import { finishRun } from '../runs/summary.js';
import { deliverSummaryToLeader } from '../runtime/completion';
import { recordEvent } from "../runs/events.js"
import { allReadOnlyStagesReportNoIssues, parseDecision } from "../protocol/decisions.js"
import { maybeRequestApproval } from "../runtime/hitl.js"

async function continueLoopRound(
    ctx: PluginContext,
    team: Team,
    rationale: string,
    nextActions: string[],
): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "loop") return
    task.currentRound = (task.currentRound ?? 0) + 1
    recordEvent(team, { timestamp: Date.now(), kind: "round", round: task.currentRound })
    task.currentStageIndex = 0
    for (const s of task.stages) s.completed = false
    const feedback =
        `[Round ${task.currentRound} — decider feedback]\n${rationale}`
        + (nextActions.length > 0
            ? `\nNext actions:\n${nextActions.map(a => `- ${a}`).join("\n")}`
            : "")
    await advanceToStage(ctx, team, task.stages[0], feedback)
}

/** Approve a loop's completion: parse the decider's decision and deliver with a human-approved reason. */
export async function approveLoopDone(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "loop") return
    const deciderOutput = task.responses[task.deciderMember ?? ""]
    const decision = parseDecision(deciderOutput ?? "")
    // Record the final decision BEFORE delivering so summarizeLoop reads it as
    // the last history entry (final: done + rationale), not after (final: n/a).
    task.decisionHistory.push({ ...decision, round: task.currentRound ?? 0 })
    await deliverSummaryToLeader(ctx, team, "loop_complete:human_approved", "completed")
    clearActiveTask(team)
    team.status = "idle"
}

/** Reject a loop's completion: parse the decision, continue to the next round (or fail if max rounds reached). */
export async function rejectLoopDone(ctx: PluginContext, team: Team, feedback?: string): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "loop") return
    const deciderOutput = task.responses[task.deciderMember ?? ""]
    const decision = parseDecision(deciderOutput ?? "")
    task.decisionHistory.push({ ...decision, round: task.currentRound ?? 0 })
    if ((task.currentRound ?? 0) >= (task.maxRounds ?? 0)) {
        await finishRun(ctx, team, "loop_complete:human_rejected_max_rounds", "failed")
        return
    }
    await continueLoopRound(
        ctx,
        team,
        feedback ?? "Human rejected the completion decision.",
        feedback ? [feedback] : ["Continue after human rejected completion."],
    )
}

/** Round-based decider loop: parse the decider's output after all stages complete and advance or deliver. */
export async function handleLoopIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "loop") return
    const stages = task.stages

    const currentStage = stages[task.currentStageIndex]
    if (!currentStage || currentStage.member !== member.name) return // stray idle

    currentStage.completed = true
    task.currentStageIndex++

    if (task.currentStageIndex < stages.length) {
        // Next stage in current round.
        await advanceToStage(ctx, team, stages[task.currentStageIndex])
        return
    }

    // All stages complete (including decider). Decider output is the last stage.
    const deciderOutput = task.responses[task.deciderMember ?? ""]
    const decision = parseDecision(deciderOutput ?? "")

    if (decision.parseFailed) {
        logEvent(ctx, "warn", "decision parse failed", { team: team.teamName, member: member.name })
        task.decisionParseFailures++
        if (task.decisionParseFailures >= 3) {
            await finishRun(ctx, team, "loop_complete:decision_parse_failure", "failed")
            return
        }
    } else {
        task.decisionParseFailures = 0
    }

    if (decision.decision === "done") {
        if (await maybeRequestApproval(ctx, team, {
            kind: "loop_done",
            round: task.currentRound,
            summary: `Loop decider ${task.deciderMember ?? "unknown"} reported done. Review before the loop completes.\n\nRationale: ${decision.rationale}`,
        })) {
            return
        }
        // Record the final decision BEFORE delivering so summarizeLoop reads it
        // as the last history entry (final: done + rationale), not after.
        task.decisionHistory.push({ ...decision, round: task.currentRound ?? 0 })
        await deliverSummaryToLeader(ctx, team, "loop_complete:decider_done", "completed")
        clearActiveTask(team)
        team.status = "idle"
        return
    }

    // Check genuine completion before the max_rounds cap: if every read-only
    // stage reports <no_issues/>, the work is actually done and the run should
    // succeed -- even on the final round. Checking max_rounds first would
    // misreport a clean final round as a max_rounds failure.
    if (allReadOnlyStagesReportNoIssues(task)) {
        await finishRun(ctx, team, "loop_complete:no_issues", "idle")
        return
    }

    if ((task.currentRound ?? 0) >= (task.maxRounds ?? 0)) {
        await finishRun(ctx, team, "loop_complete:max_rounds", "failed")
        return
    }

    // Continue to next round -- inject the decider's feedback (rationale +
    // nextActions) into stage 0's prompt so the loop is actually corrective.
    // Without this the next round re-sends the original task verbatim.
    task.decisionHistory.push({ ...decision, round: task.currentRound ?? 0 })
    await continueLoopRound(ctx, team, decision.rationale, decision.nextActions)
}

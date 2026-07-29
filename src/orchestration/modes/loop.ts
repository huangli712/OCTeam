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
import { type Team } from "../../state/store.js"
import type { DecisionRecord, MemberState } from "../../core/types.js"
import { advanceToStage } from "./stages.js"
import { finishRun } from "../control/completion.js"
import { recordEvent } from "../records/events.js"
import { allReadOnlyStagesReportNoIssues, parseDecision } from "../protocol/decisions.js"
import { maybeRequestApproval } from "../control/approval.js"
import { truncateOutput } from "../protocol/output.js"

/** Max consecutive decision parse failures before the loop is failed. */
const MAX_DECISION_PARSE_FAILURES = 3

/** Append a parsed decision to the loop's history with the current round. */
function recordLoopDecision(task: { decisionHistory: DecisionRecord[]; currentRound?: number }, decision: DecisionRecord): void {
    task.decisionHistory.push({ ...decision, round: task.currentRound ?? 0 })
}

/**
 * Advance to the next loop round: bump the round counter, reset all stages to
 * incomplete, and re-dispatch stage 0 with the decider's feedback (rationale +
 * next actions) injected as a prefix so the loop is actually corrective.
 */
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
    // HIGH-D: clear stale per-member responses from the prior round. Pre-fix
    // code reset only stages, leaving task.responses populated. On the new
    // round, if a member's dispatch landed but the member produced no output
    // (or crashed), resume treated the OLD round's response as the new one,
    // either falsely advancing the stage or letting a stale <no_issues/>
    // skip the entire round.
    for (const name of Object.keys(task.responses)) {
        delete task.responses[name]
    }
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
    recordLoopDecision(task, decision)
    await finishRun(ctx, team, "loop_complete:human_approved", "idle")
}

/** Reject a loop's completion: parse the decision, continue to the next round (or fail if max rounds reached). */
export async function rejectLoopDone(ctx: PluginContext, team: Team, feedback?: string): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "loop") return
    const deciderOutput = task.responses[task.deciderMember ?? ""]
    const decision = parseDecision(deciderOutput ?? "")
    recordLoopDecision(task, decision)
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
        // H42: allow task-level override of the parse-failure threshold.
        const maxFailures = task.maxDecisionParseFailures ?? MAX_DECISION_PARSE_FAILURES
        if (task.decisionParseFailures >= maxFailures) {
            await finishRun(ctx, team, "loop_complete:decision_parse_failure", "failed")
            return
        }
        // Re-dispatch the decider with a reformat prompt (parity with
        // arbitrate/route which delete the stale response and re-dispatch
        // on parse failure). Roll back the stage advance so the decider
        // stage is re-run instead of progressing to the next round.
        const deciderMember = team.members.find(m => m.name === (task.deciderMember ?? "") && !m.isMaster)
        if (deciderMember) {
            delete task.responses[task.deciderMember ?? ""]
            task.currentStageIndex--  // roll back to the decider stage
            const deciderStage = task.stages[task.currentStageIndex]
            if (deciderStage) deciderStage.completed = false
            const reformatPrompt =
                `[Decision parse failed — attempt ${task.decisionParseFailures}/${maxFailures}]\n`
                + `Your previous response could not be parsed as a valid <decision> or <决策> JSON block.\n`
                + `Please re-emit your decision in the correct format:\n`
                + `<decision>{"decision":"done"|"continue","rationale":"...","nextActions":[...]}</decision>\n`
                + `Previous output (truncated):\n${truncateOutput(deciderOutput ?? "", 2048)}`
            // advanceToStage handles the full dispatch (upstream context + promptAsync +
            // member state). Do NOT also call dispatchToMember — that would double-dispatch.
            await advanceToStage(ctx, team, deciderStage, reformatPrompt)
        }
        return
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
        recordLoopDecision(task, decision)
        await finishRun(ctx, team, "loop_complete:decider_done", "idle")
        return
    }

    // Check genuine completion before the max_rounds cap: if every read-only
    // stage reports <no_issues/>, the work is actually done and the run should
    // succeed -- even on the final round. Checking max_rounds first would
    // misreport a clean final round as a max_rounds failure.
    if (allReadOnlyStagesReportNoIssues(task)) {
        // M-LOOP: record the decision so the summary shows the final state.
        // Pre-fix code skipped this, so the loop summary displayed the
        // previous round's decision (or "n/a" on round 1).
        recordLoopDecision(task, {
            decision: "done",
            rationale: "all read-only stages report no issues",
            nextActions: [],
            timestamp: Date.now(),
        })
        await finishRun(ctx, team, "loop_complete:no_issues", "idle")
        return
    }

    if ((task.currentRound ?? 0) >= (task.maxRounds ?? 0)) {
        // Record the final decision so summarizeLoop shows the decider's last
        // rationale instead of "final: n/a".
        recordLoopDecision(task, decision)
        // Parity with consensus max_rounds: offer HITL approval before
        // failing the run. The leader can approve to deliver the loop's
        // current state (best-effort) instead of failing outright.
        if (await maybeRequestApproval(ctx, team, {
            kind: "loop_done",
            round: task.currentRound,
            summary: `Loop reached max rounds (${task.maxRounds}) without a done decision. The decider's last rationale: ${decision.rationale}. Approve to deliver current state, or reject to fail the run.`,
        })) {
            return
        }
        await finishRun(ctx, team, "loop_complete:max_rounds", "failed")
        return
    }

    // Continue to next round -- inject the decider's feedback (rationale +
    // nextActions) into stage 0's prompt so the loop is actually corrective.
    // Without this the next round re-sends the original task verbatim.
    // Do not record parse-failed decisions to history: they carry a fixed
    // error string as rationale, not the decider's actual judgment.
    if (!decision.parseFailed) {
        recordLoopDecision(task, decision)
    }
    await continueLoopRound(ctx, team, decision.rationale, decision.nextActions)
}

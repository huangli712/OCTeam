/**
 * Sequential-stage handlers: pipeline (linear handoff stage N → stage N+1, with
 * upstream context injection) and loop (round-based decider loop with feedback
 * injection into the next round). Both honor signoff before final delivery.
 */

import type { PluginContext } from "../core/context.js"
import { logEvent } from "../core/log.js"
import { type Team, clearActiveTask } from "../state/store.js"
import type { MemberState } from "../core/types.js"
import { advanceToStage, buildUpstreamContext } from "./dispatch.js"
import { deliverSummaryToLeader } from "./summary.js"
import { recordEvent } from "./events.js"
import { allReadOnlyStagesReportNoIssues, parseDecision } from "./decisions.js"
import { maybeTriggerSignoff } from "./signoff.js"

export async function handlePipelineIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    const task = team.activeTask
    if (!task) return
    const stages = task.stages

    const currentStage = stages[task.currentStageIndex]
    if (!currentStage || currentStage.member !== member.name) return // stray idle

    currentStage.completed = true

    const nextIndex = stages.findIndex(s => !s.completed)
    if (nextIndex === -1) {
        // All stages complete → maybe trigger signoff, then deliver.
        if (await maybeTriggerSignoff(ctx, team)) {
            return  // signoff in progress
        }
        await deliverSummaryToLeader(ctx, team, "pipeline_complete")
        clearActiveTask(team)
        team.status = "idle"
        return
    }

    task.currentStageIndex = nextIndex
    const nextStage = stages[nextIndex]
    const nextMember = team.members.find(m => m.name === nextStage.member)
    if (!nextMember || !nextMember.sessionId) return

    const upstream = buildUpstreamContext(stages, task.responses, nextIndex)
    const fullTask = upstream
        ? `${upstream}\n\n[Your task]\n${nextStage.task}`
        : nextStage.task

    await ctx.client.session.promptAsync({
        path: { id: nextMember.sessionId },
        body: {
            parts: [{ type: "text", text: fullTask, synthetic: true }],
            agent: nextMember.agent ?? "build",
        },
        query: { directory: nextMember.worktreePath ?? ctx.directory },
    })
    nextMember.status = "running"
    nextMember.turnCount++
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "stage_advanced",
        member: nextMember.name,
        stage: nextIndex,
    })
}

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
            await deliverSummaryToLeader(ctx, team, "loop_complete:decision_parse_failure")
            clearActiveTask(team)
            team.status = "failed"
            return
        }
    } else {
        task.decisionParseFailures = 0
    }

    if (decision.decision === "done") {
        await deliverSummaryToLeader(ctx, team, "loop_complete:decider_done")
        task.decisionHistory.push({ ...decision, round: task.currentRound ?? 0 })
        clearActiveTask(team)
        team.status = "idle"
        return
    }

    // Check genuine completion before the max_rounds cap: if every read-only
    // stage reports <no_issues/>, the work is actually done and the run should
    // succeed — even on the final round. Checking max_rounds first would
    // misreport a clean final round as a max_rounds failure.
    if (allReadOnlyStagesReportNoIssues(task)) {
        await deliverSummaryToLeader(ctx, team, "loop_complete:no_issues")
        clearActiveTask(team)
        team.status = "idle"
        return
    }

    if ((task.currentRound ?? 0) >= (task.maxRounds ?? 0)) {
        await deliverSummaryToLeader(ctx, team, "loop_complete:max_rounds")
        clearActiveTask(team)
        team.status = "failed"
        return
    }

    // Continue to next round — inject the decider's feedback (rationale +
    // nextActions) into stage 0's prompt so the loop is actually corrective.
    // Without this the next round re-sends the original task verbatim.
    task.decisionHistory.push({ ...decision, round: task.currentRound ?? 0 })
    task.currentRound = (task.currentRound ?? 0) + 1
    recordEvent(team, { timestamp: Date.now(), kind: "round", round: task.currentRound })
    task.currentStageIndex = 0
    for (const s of task.stages) s.completed = false
    const feedback =
        `[Round ${task.currentRound} — decider feedback]\n${decision.rationale}`
        + (decision.nextActions.length > 0
            ? `\nNext actions:\n${decision.nextActions.map(a => `- ${a}`).join("\n")}`
            : "")
    await advanceToStage(ctx, team, stages[0], feedback)
}

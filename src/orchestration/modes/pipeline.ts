/**
 * Pipeline handler -- linear handoff stage N -> stage N+1, with upstream
 * context injection. Honors signoff before final delivery.
 *
 * STATE MACHINE:
 *   stage[0]_dispatch → stage[0]_barrier → stage[1]_dispatch → ... → all_complete
 *   - All stages complete → check signoff → deliver (idle: pipeline_complete)
 *   - Any stage member errors → termination check fails (tolerance 0)
 */

import type { PluginContext } from "../../core/context.js"
import { type Team } from "../../state/store.js"
import type { MemberState } from "../../core/types.js"
import { buildUpstreamContext } from "./stages.js"
import { prependStandingInstruction } from "../control/dispatch.js"
import { safeMemberAgent } from "../../core/role.js"
import { finishRun } from "../control/completion.js"
import { recordEvent } from "../records/events.js"
import { maybeTriggerSignoff } from "../control/signoff.js"
import { maybeRequestApproval } from "../control/approval.js"

/** Dispatch the next incomplete pipeline stage with upstream context from prior stages. */
export async function advancePipelineAfterStage(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "pipeline") return
    const stages = task.stages

    const nextIndex = stages.findIndex(s => !s.completed)
    if (nextIndex === -1) {
        if (await maybeTriggerSignoff(ctx, team)) return
        await finishRun(ctx, team, "pipeline_complete", "idle")
        return
    }

    task.currentStageIndex = nextIndex
    const nextStage = stages[nextIndex]
    if (!nextStage) {
        await finishRun(ctx, team, "pipeline_failed:missing_stage", "failed")
        return
    }
    const nextMember = team.members.find(m => m.name === nextStage.member)
    if (!nextMember?.sessionId) {
        await finishRun(ctx, team, `pipeline_failed:${nextStage.member}`, "failed")
        return
    }

    const upstream = buildUpstreamContext(stages, task.responses, nextIndex)
    const stageTask = upstream
        ? `${upstream}\n\n[Your task]\n${nextStage.task}`
        : nextStage.task
    const fullTask = prependStandingInstruction(nextMember, stageTask)

    await ctx.client.session.promptAsync({
        path: { id: nextMember.sessionId },
        body: {
            parts: [{ type: "text", text: fullTask, synthetic: false }],
            agent: safeMemberAgent(nextMember.agent),
        },
        query: { directory: nextMember.worktreePath ?? ctx.directory },
    })
    nextMember.promptDelivered = true
    nextMember.status = "running"
    nextMember.turnCount++
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "stage_advanced",
        member: nextMember.name,
        stage: nextIndex,
    })
}

/** Handle a pipeline member's idle: mark the current stage complete and advance to the next stage. */
export async function handlePipelineIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    const task = team.activeTask
    if (!task) return
    const stages = task.stages

    const currentStage = stages[task.currentStageIndex]
    if (!currentStage || currentStage.member !== member.name) return // stray idle

    currentStage.completed = true

    const nextIndex = stages.findIndex(s => !s.completed)
    if (nextIndex !== -1 && await maybeRequestApproval(ctx, team, {
        kind: "pipeline_stage",
        stage: task.currentStageIndex,
        summary: `Pipeline stage ${task.currentStageIndex} completed by ${currentStage.member}. Review before stage ${nextIndex} starts.`,
    })) {
        return
    }
    await advancePipelineAfterStage(ctx, team)
}

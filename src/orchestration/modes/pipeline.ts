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
import { dispatchToMember } from "../control/dispatch.js"
import { finishRun } from "../control/completion.js"
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

    // H-11: route through the canonical dispatch primitive so promptAsync +
    // member state transition + saveTeamState + event recording are atomic.
    await dispatchToMember(
        ctx,
        nextMember,
        stageTask,
        nextMember.worktreePath ?? ctx.directory,
        team,
    )
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

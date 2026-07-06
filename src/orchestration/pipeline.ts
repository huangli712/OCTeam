/**
 * Pipeline handler -- linear handoff stage N -> stage N+1, with upstream
 * context injection. Honors signoff before final delivery.
 *
 * STATE MACHINE:
 *   stage[0]_dispatch → stage[0]_barrier → stage[1]_dispatch → ... → all_complete
 *   - All stages complete → check signoff → deliver (idle: pipeline_complete)
 *   - Any stage member errors → termination check fails (tolerance 0)
 */

import type { PluginContext } from "../core/context.js"
import { type Team } from "../state/store.js"
import type { MemberState } from "../core/types.js"
import { buildUpstreamContext, prependStandingInstruction } from "./dispatch.js"
import { safeMemberAgent } from "../core/role.js"
import { finishRun } from "./summary.js"
import { recordEvent } from "./events.js"
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
        // All stages complete -> maybe trigger signoff, then deliver.
        if (await maybeTriggerSignoff(ctx, team)) {
            return  // signoff in progress
        }
        await finishRun(ctx, team, "pipeline_complete", "idle")
        return
    }

    task.currentStageIndex = nextIndex
    const nextStage = stages[nextIndex]
    const nextMember = team.members.find(m => m.name === nextStage.member)
    if (!nextMember || !nextMember.sessionId) return

    const upstream = buildUpstreamContext(stages, task.responses, nextIndex)
    const stageTask = upstream
        ? `${upstream}\n\n[Your task]\n${nextStage.task}`
        : nextStage.task
    const fullTask = prependStandingInstruction(nextMember, stageTask)

    await ctx.client.session.promptAsync({
        path: { id: nextMember.sessionId },
        body: {
            parts: [{ type: "text", text: fullTask, synthetic: true }],
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

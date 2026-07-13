/**
 * Reduce sub-stage for parallel mode: when the barrier fires with multiple
 * responses, dispatch a single reducer to synthesize them into one final
 * output before signoff/delivery.
 */

import type { PluginContext } from "../../core/context.js"
import type { MemberState } from "../../core/types.js"
import { type Team, saveTeamState } from "../../state/store.js"
import { finishRun } from "../control/completion.js"
import { dispatchToMember } from "../control/dispatch.js"
import { maybeTriggerSignoff } from "../control/signoff.js"
import { buildSummary } from "../records/summary.js"

export function buildReducePrompt(body: string): string {
    return `[Reduce task] You are the reducer for a parallel run. Combine the candidate `
        + `outputs below into ONE final result per the policy. Output ONLY the final `
        + `result, with no preamble.\n\n${body}`
}

export async function maybeTriggerReduce(ctx: PluginContext, team: Team): Promise<boolean> {
    const task = team.activeTask
    if (!task || task.type !== "parallel") return false
    if (!task.reducePolicy || task.reducePolicy === "summarize") return false
    if (task.reduceStage) return true
    if (Object.keys(task.responses).length <= 1) return false
    const reducer = team.members.find(member => member.name === task.reducerMember && !member.isMaster)
    if (!reducer?.sessionId || reducer.status === "errored") return false

    task.reduceStage = true
    const body = await buildSummary(team, task, "pending_reduce")
    const prompt = buildReducePrompt(body)
    await dispatchToMember(ctx, reducer, prompt, reducer.worktreePath ?? ctx.directory, team)
    await saveTeamState(team)
    return true
}

export async function handleReduceIdle(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
): Promise<void> {
    const task = team.activeTask
    if (!task?.reduceStage) return
    if (member.name !== task.reducerMember) return

    task.reducedResult = task.responses[member.name] ?? ""
    task.reduceStage = false
    if (await maybeTriggerSignoff(ctx, team)) return
    await finishRun(ctx, team, `parallel_${task.mode}_reduced:${task.reducePolicy}`, "idle")
}

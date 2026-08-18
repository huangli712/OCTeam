/**
 * Reduce sub-stage for parallel mode: when the barrier fires with multiple
 * responses, dispatch a single reducer to synthesize them into one final
 * output before signoff/delivery.
 */

import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
import type { MemberState } from "../../core/types.js"
import { type Team, saveTeamState } from "../../state/store.js"
import { finishRun } from "../control/completion.js"
import { dispatchToMember } from "../control/dispatch.js"
import { maybeTriggerSignoff } from "../control/signoff.js"
import { findMember } from "../../tools/support.js"
import { buildSummary } from "../records/summary.js"
import type { CaptureMemberOutputResult } from "../records/capture.js"

/** Build the reducer's dispatch prompt: combine candidate outputs into one final result per the policy. */
export function buildReducePrompt(body: string): string {
    return `[Reduce task]\n`
        + `You are the reducer for a parallel run. Combine the candidate `
        + `outputs below into ONE final result per the policy. Output ONLY the final `
        + `result, with no preamble.\n${body}`
}

/**
 * Enter the reduce sub-stage when the parallel barrier fired with multiple
 * responses and a real (non-summarize) reduce policy is configured. Sets
 * reduceStage, dispatches the reducer, and persists state. Returns true when
 * the reducer was dispatched (caller must stop); false otherwise.
 */
export async function maybeTriggerReduce(ctx: PluginContext, team: Team): Promise<boolean> {
    const task = team.activeTask
    if (!task || task.type !== "parallel") return false
    if (!task.reducePolicy || task.reducePolicy === "summarize") return false
    if (task.reduceStage) return true
    if (Object.keys(task.responses).length <= 1) return false
    const reducer = findMember(team, task.reducerMember ?? "")
    if (!reducer?.sessionId || reducer.status === "errored") {
        // Log an unavailable configured reducer so the summarize fallback is
        // distinguishable from a run with no reduction configured.
        logSwallowed(ctx, "maybeTriggerReduce: configured reducer unavailable, falling back to summarize", undefined, {
            reducer: task.reducerMember, status: reducer?.status,
        })
        return false
    }

    task.reduceStage = true
    const body = await buildSummary(team, task, "pending_reduce")
    // Clear the reducer's stale mapper-stage response so a crash between this
    // dispatch and the reducer's capture cannot promote it as reducedResult
    // on resume (resume.ts sees responses[reducer] truthy → handleReduceIdle
    // → task.reducedResult = stale mapper output). Mirrors fanout.ts:218-220.
    // Snapshot the value first so empty-output retries can restore it
    // and rebuild the same input set as the first attempt.
    task._reducerMapperSnapshot = task.responses[reducer.name]
    delete task.responses[reducer.name]
    const prompt = buildReducePrompt(body)
    await dispatchToMember(ctx, reducer, prompt, reducer.worktreePath ?? ctx.directory, team)
    await saveTeamState(team)
    return true
}

/**
 * Handle the reducer's idle: capture the reduced result, clear reduceStage,
 * then proceed to signoff (if configured) or deliver the reduced run.
 */
export async function handleReduceIdle(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
    captureResult?: CaptureMemberOutputResult,
): Promise<void> {
    if (captureResult?.fresh === false && captureResult.reason === "stale") return
    const task = team.activeTask
    if (!task?.reduceStage || task.type !== "parallel") return
    if (member.name !== task.reducerMember) return

    const reduced = task.responses[member.name]
    // An errored reducer cannot produce or be retried. Clear reduceStage and
    // fall back to non-reduced parallel delivery so successful mapper output
    // is preserved and the run cannot stall.
    if (member.status === "errored") {
        task.reduceStage = false
        task.reducedResult = undefined
        // Continue to the normal parallel completion path; the next idle
        // (or sweep) will deliver survivors' outputs without reduction.
        const { maybeAdvanceBarrier } = await import("../control/barriers.js")
        const participants = team.members
            .filter(m => !m.isMaster && m.sessionId)
            .map(m => m.name)
        await maybeAdvanceBarrier(team, participants, async () => {
            // Reuse the same delivery logic from handleParallelIdle. The
            // reducer is already errored; clear its response so it does not
            // leak into the summary.
            delete task.responses[member.name]
            const errored = participants.filter(
                n => team.members.find(m => m.name === n)?.status === "errored",
            )
            const tolerance = task.maxErroredMembers ?? 0
            const survivors = participants.length - errored.length
            if (survivors === 0 || errored.length > tolerance) {
                await finishRun(ctx, team, `member_error:${member.name}:${member.error ?? "unknown"}`, "failed")
                return
            }
            for (const name of errored) delete task.responses[name]
            if (task._reducerMapperSnapshot !== undefined) {
                task.responses[member.name] = task._reducerMapperSnapshot
                task._reducerMapperSnapshot = undefined
            }
            // Honor signoff on the fallback path, matching the normal
            // reduce completion path (line 125). Without this, a parallel
            // task configured with signoffPolicy + a reducer could deliver
            // unreviewed raw mapper outputs when the reducer errors.
            if (await maybeTriggerSignoff(ctx, team)) return
            await finishRun(ctx, team, `parallel_${task.mode}_partial:${errored.length}_errored`, "idle")
        })
        return
    }
    if (reduced === undefined) {
        // No new output was captured for the reducer this turn (stale idle or
        // empty extraction). Re-dispatch the reducer instead of silently
        // completing with an empty result — an empty reduction would discard
        // all mapper outputs.
        const maxRetries = task.maxRetries ?? 0
        task.reduceRetries = (task.reduceRetries ?? 0) + 1
        if (task.reduceRetries > maxRetries) {
            // Restore the mapper snapshot before failing so the
            // summary includes the mapper's original output.
            if (task._reducerMapperSnapshot !== undefined) {
                task.responses[member.name] = task._reducerMapperSnapshot
                task._reducerMapperSnapshot = undefined
            }
            await finishRun(ctx, team, "parallel_reduce_failed:empty_output", "failed")
            return
        }
        const reducer = findMember(team, task.reducerMember ?? "")
        if (!reducer?.sessionId) {
            await finishRun(ctx, team, "parallel_reduce_failed:reducer_unavailable", "failed")
            return
        }
        // Restore the reducer's mapper-stage response before rebuilding the
        // summary so retries receive the same input set as the first attempt.
        if (task._reducerMapperSnapshot !== undefined && !task.responses[member.name]) {
            task.responses[member.name] = task._reducerMapperSnapshot
        }
        const body = await buildSummary(team, task, "pending_reduce")
        delete task.responses[member.name]
        await dispatchToMember(ctx, reducer, buildReducePrompt(body), reducer.worktreePath ?? ctx.directory, team)
        await saveTeamState(team)
        return
    }
    task.reducedResult = reduced
    task.reduceStage = false
    // Clear the snapshot once a real reduction is captured so it is
    // not persisted in the run record.
    task._reducerMapperSnapshot = undefined
    if (await maybeTriggerSignoff(ctx, team)) return
    await finishRun(ctx, team, `parallel_${task.mode}_reduced:${task.reducePolicy}`, "idle")
}

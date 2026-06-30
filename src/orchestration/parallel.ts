/**
 * Parallel handler -- single-barrier fan-in with failure isolation, optional
 * reduce and signoff. Relies on waitForBarrier to converge.
 */

import type { PluginContext } from "../core/context.js"
import { type Team, clearActiveTask } from "../state/store.js"
import { deliverSummaryToLeader } from "./summary.js"
import { waitForBarrier } from "./barriers.js"
import { maybeTriggerReduce, maybeTriggerSignoff } from "./signoff.js"

export async function handleParallelIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task) return
    const participants = team.members.filter(m => !m.isMaster).map(m => m.name)

    await waitForBarrier(team, participants, async () => {
        // Failure isolation: count terminally-errored members. Within tolerance ->
        // deliver survivors (partial success); over tolerance or no survivors -> fail.
        const errored = participants.filter(
            n => team.members.find(m => m.name === n)?.status === "errored",
        )
        const tolerance = task.maxErroredMembers ?? 0
        const survivors = participants.length - errored.length
        if (survivors === 0 || errored.length > tolerance) {
            const e = team.members.find(m => m.name === errored[0])
            await deliverSummaryToLeader(ctx, team, `member_error:${e?.name}:${e?.error ?? "unknown"}`)
            clearActiveTask(team)
            team.status = "failed"
            return
        }
        // Reduce (real map-reduce) BEFORE signoff: signoff then reviews the single
        // reduced artifact, not the N raw outputs. Re-entry while reduceStage is
        // still set means the reducer reached a terminal state without idling
        // (errored) -- fall back to non-reduced delivery (reducedResult stays unset)
        // so the successful mappers' work is not wasted and the run cannot hang.
        if (task.reduceStage) {
            task.reduceStage = false
        } else if (await maybeTriggerReduce(ctx, team)) {
            return  // reducer dispatched; handleReduceIdle finishes the run
        }
        // Maybe trigger signoff before delivering.
        if (await maybeTriggerSignoff(ctx, team)) {
            return  // signoff in progress
        }
        // Single barrier: collect outputs -> deliver to leader -> done.
        const reason = errored.length > 0
            ? `parallel_${task.mode}_partial:${errored.length}_errored`
            : `parallel_${task.mode}_complete`
        await deliverSummaryToLeader(ctx, team, reason)
        clearActiveTask(team)
        team.status = "idle"
    })
}

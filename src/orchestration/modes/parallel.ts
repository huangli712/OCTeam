/**
 * Parallel handler -- single-barrier fan-in with failure isolation, optional
 * reduce and signoff. Relies on maybeAdvanceBarrier to converge.
 *
 * STATE MACHINE:
 *   dispatch → barrier_wait → [reduce_stage → signoff_stage →] deliver
 *   - All members complete, within tolerance → reduce → signoff → deliver (idle)
 *   - Over tolerance errored → deliver (failed: member_error)
 *   - All errored / zero survivors → deliver (failed: member_error)
 */

import type { PluginContext } from "../../core/context.js"
import { type Team } from "../../state/store.js"
import { finishRun } from "../control/completion.js"
import { maybeAdvanceBarrier } from "../control/barriers.js"
import { maybeTriggerReduce } from "./reduce.js"
import { maybeTriggerSignoff } from "../control/signoff.js"
import { nonMasterMembers } from "../../tools/support.js"

/** Single-barrier fan-in for parallel mode: wait for all members, then maybe reduce, signoff, and deliver. */
export async function handleParallelIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task) return
    const participants = nonMasterMembers(team).map(m => m.name)

    await maybeAdvanceBarrier(team, participants, async () => {
        // Failure isolation: count terminally-errored members. Within tolerance ->
        // deliver survivors (partial success); over tolerance or no survivors -> fail.
        const errored = participants.filter(
            n => team.members.find(m => m.name === n)?.status === "errored",
        )
        const tolerance = task.maxErroredMembers ?? 0
        const survivors = participants.length - errored.length
        if (survivors === 0 || errored.length > tolerance) {
            const e = team.members.find(m => m.name === errored[0])
            await finishRun(ctx, team, `member_error:${e?.name}:${e?.error ?? "unknown"}`, "failed")
            return
        }
        const missingResponse = participants.some(name => {
            const member = team.members.find(m => m.name === name)
            return member?.status !== "errored"
                && (member?.turnCount ?? 0) > 0
                && !task.responses[name]
        })
        if (missingResponse) return
        // HIGH-D: clear stale responses from errored members BEFORE reduce / signoff.
        // Pre-fix code cleared them only just before final delivery, AFTER
        // reduce / signoff had already read them. A reducer or signoff
        // reviewer then received errored members' (possibly stale) outputs as
        // legitimate inputs, corrupting the reduced artifact or the verdict.
        for (const name of errored) {
            delete task.responses[name]
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
        await finishRun(ctx, team, reason, "idle")
    })
}

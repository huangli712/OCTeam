/**
 * Concurrent-flavor handlers: parallel (single-barrier fan-in with failure
 * isolation, optional reduce and signoff) and consensus (multi-round broadcast
 * until agreement or max_rounds). Both rely on waitForBarrier to converge.
 */

import type { PluginContext } from "../core/context.js"
import { type Team, clearActiveTask } from "../state/store.js"
import { dispatchToMember } from "./dispatch.js"
import { buildRoundSummary, deliverSummaryToLeader } from "./summary.js"
import { recordEvent } from "./events.js"
import { waitForBarrier } from "./barriers.js"
import { allMembersAgree } from "./decisions.js"
import { maybeTriggerReduce, maybeTriggerSignoff } from "./signoff.js"

export async function handleParallelIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task) return
    const participants = team.members.filter(m => !m.isMaster).map(m => m.name)

    await waitForBarrier(team, participants, async () => {
        // Failure isolation: count terminally-errored members. Within tolerance →
        // deliver survivors (partial success); over tolerance or no survivors → fail.
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
        // (errored) — fall back to non-reduced delivery (reducedResult stays unset)
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
        // Single barrier: collect outputs → deliver to leader → done.
        const reason = errored.length > 0
            ? `parallel_${task.mode}_partial:${errored.length}_errored`
            : `parallel_${task.mode}_complete`
        await deliverSummaryToLeader(ctx, team, reason)
        clearActiveTask(team)
        team.status = "idle"
    })
}

export async function handleConsensusIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "consensus") return
    const participants = team.members.filter(m => !m.isMaster).map(m => m.name)

    await waitForBarrier(team, participants, async () => {
        task.consensusReached = allMembersAgree(task.responses)
        if (task.consensusReached) {
            await deliverSummaryToLeader(ctx, team, "consensus_reached")
            clearActiveTask(team)
            team.status = "idle"
            return
        }
        if ((task.currentRound ?? 0) >= (task.maxRounds ?? 0)) {
            // Reached here only when consensus was NOT detected → failed.
            await deliverSummaryToLeader(ctx, team, "consensus_max_rounds")
            clearActiveTask(team)
            team.status = "failed"
            return
        }
        // Next round: broadcast prior-round summary, reset to running.
        task.currentRound = (task.currentRound ?? 0) + 1
        recordEvent(team, { timestamp: Date.now(), kind: "round", round: task.currentRound })
        const summary = buildRoundSummary(task.responses)
        const roundText =
            `[Consensus Round ${task.currentRound}] Others said:\n${summary}\n\n`
            + `Respond, then emit <consensus>{"agreed": true|false}</consensus> (or <共识>{"agreed": ...}</共识>).`
        for (const m of team.members.filter(x => !x.isMaster)) {
            await dispatchToMember(ctx, m, roundText, m.worktreePath ?? ctx.directory, team)
        }
    })
}

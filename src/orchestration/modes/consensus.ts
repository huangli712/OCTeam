/**
 * Consensus handler -- multi-round broadcast until agreement or max_rounds.
 * Relies on maybeAdvanceBarrier to converge each round.
 *
 * STATE MACHINE:
 *   round_N_dispatch → barrier_wait → consensus_reached | max_rounds | next_round
 *   - All members agree → deliver (idle: consensus_reached)
 *   - Max rounds exceeded without agreement → deliver (failed: consensus_max_rounds)
 *   - Else → next round dispatch with prior-round summary
 */

import type { PluginContext } from "../../core/context.js"
import { type Team } from "../../state/store.js"
import { dispatchToMember } from "../control/dispatch.js"
import { buildRoundSummary } from "../records/summary.js"
import { finishRun } from "../control/completion.js"
import { recordEvent } from "../records/events.js"
import { maybeAdvanceBarrier } from "../control/barriers.js"
import { allMembersAgree } from "../protocol/decisions.js"
import { maybeRequestApproval } from "../control/approval.js"

/**
 * Consensus idle handler: wait for the round barrier, then either deliver on
 * agreement, fail on max rounds (with optional HITL deadlock approval), or
 * dispatch the next round with a prior-round summary broadcast.
 */
export async function handleConsensusIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "consensus") return
    const participants = team.members.filter(m => !m.isMaster).map(m => m.name)

    await maybeAdvanceBarrier(team, participants, async () => {
        task.consensusReached = allMembersAgree(task.responses)
        if (task.consensusReached) {
            await finishRun(ctx, team, "consensus_reached", "idle")
            return
        }
        if ((task.currentRound ?? 0) >= (task.maxRounds ?? 0)) {
            if (await maybeRequestApproval(ctx, team, {
                kind: "consensus_deadlock",
                round: task.currentRound,
                summary: `Consensus not reached after ${task.currentRound} round(s) on topic "${task.topic ?? "unknown"}" — ${participants.length} member positions below.`,
            })) {
                return
            }
            await finishRun(ctx, team, "consensus_max_rounds", "failed")
            return
        }
        // Next round: broadcast prior-round summary, reset to running.
        // currentRound is incremented AFTER the dispatch loop so a partial
        // dispatch failure (promptAsync throws mid-loop) does not advance the
        // round counter — the barrier re-fire will retry the same round.
        const nextRound = (task.currentRound ?? 0) + 1
        const summary = buildRoundSummary(task.responses)
        const roundText =
            `[Consensus Round ${nextRound}]\n${summary}\n\n`
            + `Respond, then emit <consensus>{"agreed": true|false}</consensus> (or <共识>{"agreed": ...}</共识>).`
        for (const m of team.members.filter(x => !x.isMaster)) {
            await dispatchToMember(ctx, m, roundText, m.worktreePath ?? ctx.directory, team)
        }
        task.currentRound = nextRound
        recordEvent(team, { timestamp: Date.now(), kind: "round", round: nextRound })
    })
}

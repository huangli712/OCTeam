/**
 * Consensus handler -- multi-round broadcast until agreement or max_rounds.
 * Relies on waitForBarrier to converge each round.
 *
 * STATE MACHINE:
 *   round_N_dispatch → barrier_wait → consensus_reached | max_rounds | next_round
 *   - All members agree → deliver (idle: consensus_reached)
 *   - Max rounds exceeded without agreement → deliver (failed: consensus_max_rounds)
 *   - Else → next round dispatch with prior-round summary
 */

import type { PluginContext } from "../../core/context.js"
import { type Team } from "../../state/store.js"
import { dispatchToMember } from "../runtime/dispatch.js"
import { buildRoundSummary } from '../records/summary.js';
import { finishRun } from '../runtime/completion.js';
import { recordEvent } from "../records/events.js"
import { waitForBarrier } from "../runtime/barriers.js"
import { allMembersAgree } from "../protocol/decisions.js"
import { maybeRequestApproval } from "../runtime/hitl.js"

export async function handleConsensusIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "consensus") return
    const participants = team.members.filter(m => !m.isMaster).map(m => m.name)

    await waitForBarrier(team, participants, async () => {
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

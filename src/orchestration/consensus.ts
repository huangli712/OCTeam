/**
 * Consensus handler -- multi-round broadcast until agreement or max_rounds.
 * Relies on waitForBarrier to converge each round.
 */

import type { PluginContext } from "../core/context.js"
import { type Team, clearActiveTask } from "../state/store.js"
import { dispatchToMember } from "./dispatch.js"
import { buildRoundSummary, deliverSummaryToLeader } from "./summary.js"
import { recordEvent } from "./events.js"
import { waitForBarrier } from "./barriers.js"
import { allMembersAgree } from "./decisions.js"

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
            // Reached here only when consensus was NOT detected -> failed.
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

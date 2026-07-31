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
import { logSwallowed } from "../../core/log.js"
import { type Team, saveTeamState } from "../../state/store.js"
import { dispatchToMember } from "../control/dispatch.js"
import { buildRoundSummary } from "../records/summary.js"
import { finishRun } from "../control/completion.js"
import { recordEvent } from "../records/events.js"
import { maybeAdvanceBarrier } from "../control/barriers.js"
import { allMembersAgree } from "../protocol/decisions.js"
import { maybeRequestApproval } from "../control/approval.js"
import { nonMasterMembers } from "../../tools/support.js"
import type { CaptureMemberOutputResult } from "../records/capture.js"

/**
 * Consensus idle handler: wait for the round barrier, then either deliver on
 * agreement, fail on max rounds (with optional HITL deadlock approval), or
 * dispatch the next round with a prior-round summary broadcast.
 */
export async function handleConsensusIdle(
    ctx: PluginContext,
    team: Team,
    captureResult?: CaptureMemberOutputResult,
): Promise<void> {
    if (captureResult?.fresh === false && captureResult.reason === "stale") return
    const task = team.activeTask
    if (!task || task.type !== "consensus") return
    const participants = nonMasterMembers(team).map(m => m.name)

    await maybeAdvanceBarrier(team, participants, async () => {
        // HIGH #H3: require ALL participants to have responses, not just
        // successfully dispatched ones. Pre-fix code used dispatchedParticipants
        // (which excludes failed dispatches), letting the barrier advance
        // with missing members. Failed-dispatch members need re-dispatch,
        // not silent exclusion.
        const allResponded = participants.every(name => task.responses[name] !== undefined)
        if (!allResponded) {
            // HIGH: re-dispatch members who haven't responded this round.
            // Pre-fix code returned without re-dispatching, causing the
            // barrier to stall until wall-clock timeout.
            const roundText = `[Consensus Round ${task.currentRound ?? 1}]\n${buildRoundSummary(task.responses)}\n\nRespond, then emit <consensus>{"agreed": true|false}</consensus>.`
            for (const m of nonMasterMembers(team)) {
                if (task.responses[m.name] !== undefined) continue
                if (m.status === "running") continue // still working
                try {
                    await dispatchToMember(ctx, m, roundText, m.worktreePath ?? ctx.directory, team)
                } catch (err) {
                    logSwallowed(ctx, "consensus: re-dispatch failed", err, { member: m.name })
                }
            }
            return  // barrier not satisfied yet
        }
        task.consensusReached = allMembersAgree(task.responses, participants)
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
        // Clear stale responses from the previous round so the next barrier
        // fire evaluates agreement on THIS round's fresh responses only.
        // Without this, a member whose round-1 response agrees with their
        // round-2 response could appear to have already agreed before they
        // actually respond in round 2 (stale-response false consensus).
        for (const name of Object.keys(task.responses)) {
            delete task.responses[name]
        }
        // H6: persist currentRound BEFORE dispatching. dispatchToMember saves
        // state internally, so pre-fix code left disk with old round + cleared
        // responses — a crash would resume with wrong round. Setting it first
        // ensures the disk state is consistent with the dispatched prompts.
        task.currentRound = nextRound
        task.dispatchedParticipants = []
        recordEvent(team, { timestamp: Date.now(), kind: "round", round: nextRound })
        const roundText =
            `[Consensus Round ${nextRound}]\n${summary}\n\n`
            + `Respond, then emit <consensus>{"agreed": true|false}</consensus> (or <共识>{"agreed": ...}</共识>).`
        // #15: snapshot the round prompt so late/retry dispatches reuse
        // the same text (not rebuilt from mutable task.responses).
        task.roundPrompt = roundText
        for (const m of nonMasterMembers(team)) {
            try {
                await dispatchToMember(ctx, m, roundText, m.worktreePath ?? ctx.directory, team)
                task.dispatchedParticipants.push(m.name)
            } catch (err) {
                logSwallowed(ctx, "consensus: dispatch failed for member", err, { member: m.name, round: nextRound })
            }
        }
        // HIGH: persist the dispatched roster after the dispatch loop so
        // crash recovery knows which members were successfully prompted.
        await saveTeamState(team)
    })
}

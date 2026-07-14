/**
 * Authoritative Arbitration (arbitrate mode) handler. Two-phase orchestration:
 *   Phase A (debate): the debaters run in parallel over up to maxRounds rounds,
 *     each round broadcasting prior positions (consensus skeleton).
 *   Phase B (ruling): once rounds are exhausted, the arbiter is dispatched with
 *     all positions and emits a binding <ruling>; its idle delivers the result.
 * The debate/arbiter prompt builders live here next to the only callers.
 *
 * STATE MACHINE:
 *   Phase A: debate_round → barrier → next_round | transition_to_ruling
 *   Phase B: arbiter_dispatch → parse_ruling → [signoff →] deliver
 *   - Arbiter rules → check signoff → deliver (idle: arbitrate_complete:ruled)
 *   - Arbiter unavailable → deliver (failed: arbitrate_complete:arbiter_unavailable)
 *   - Ruling parse failure → deliver (failed: arbitrate_complete:decision_parse_failure)
 */

import type { PluginContext } from "../../core/context.js"
import { type Team, saveTeamState } from "../../state/store.js"
import type { ActiveTask, ArbitrateTask } from "../../core/types.js"
import { dispatchToMember } from "../control/dispatch.js"
import { DEFAULT_ARBITRATE_ROUNDS } from "./defaults.js"
import { buildRoundSummary } from "../records/summary.js"
import { finishRun } from "../control/completion.js"
import { recordEvent } from "../records/events.js"
import { truncateOutput } from "../protocol/output.js"
import { maybeAdvanceBarrier } from "../control/barriers.js"
import { parseArbitrationDecision } from "../protocol/decisions.js"
import { maybeTriggerSignoff } from "../control/signoff.js"
import { maybeRequestApproval } from "../control/approval.js"

/**
 * Build a debater's prompt for the current debate round. Round 1 states the
 * dispute subject; later rounds rebut other debaters' positions (drawn from
 * the latest captured responses via buildRoundSummary).
 */
export function buildDebatePrompt(task: ActiveTask): string {
    const round = task.currentRound ?? 1
    if (round <= 1) {
        return (
            `[Arbitration debate — Round 1]\nSubject:\n${task.task ?? ""}\n\n`
            + `State your position with reasoning. An arbiter will weigh all positions and issue a binding ruling.`
        )
    }
    const positions = buildRoundSummary(task.responses)
    return (
        `[Arbitration debate — Round ${round}]\nOther positions:\n${positions}\n\n`
        + `Rebut or refine your position.`
    )
}

/**
 * Build the arbiter's ruling prompt: the dispute plus every debater's final
 * position, requesting exactly one <ruling>{...} decision.
 */
export function buildArbiterPrompt(task: ArbitrateTask): string {
    const positions = (task.disputants ?? [])
        .map(name => `\nby ${name}:\n${truncateOutput(task.responses[name] ?? "")}`)
        .join("\n\n")
    return (
        `[Arbitration ruling]\nDispute:\n${task.task ?? ""}\n\n`
        + `Debater positions:\n${positions}\n\n`
        + `Weigh impartially and issue a BINDING ruling. Emit exactly one:\n`
        + `<ruling>{"decision":"...","rationale":"..."}</ruling> (Chinese <裁决> also accepted)`
    )
}

/**
 * max_rounds is the normal debate length (NOT a failure condition, unlike
 * consensus). Failures: arbiter unavailable, or unparseable ruling.
 */
export async function handleArbitrateIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "arbitrate") return
    const disputants = task.disputants ?? []

    // Phase A: debate (arbitrationStage not yet set).
    if (!task.arbitrationStage) {
        await maybeAdvanceBarrier(team, disputants, async () => {
            if ((task.currentRound ?? 1) >= (task.maxRounds ?? DEFAULT_ARBITRATE_ROUNDS)) {
                // Debate exhausted -> transition to the ruling phase.
                task.arbitrationStage = true
                const arbiter = team.members.find(
                    m => m.name === task.arbiterMember && !m.isMaster,
                )
                if (!arbiter?.sessionId) {
                    // Arbiter unavailable: cannot rule -> fail.
                    await finishRun(ctx, team, "arbitrate_complete:arbiter_unavailable", "failed")
                    return
                }
                await dispatchToMember(
                    ctx,
                    arbiter,
                    buildArbiterPrompt(task),
                    arbiter.worktreePath ?? ctx.directory,
                    team,
                )
                await saveTeamState(team)
                return
            }
            // Next debate round: broadcast prior positions, re-dispatch debaters.
            task.currentRound = (task.currentRound ?? 1) + 1
            recordEvent(team, { timestamp: Date.now(), kind: "round", round: task.currentRound })
            for (const name of disputants) {
                const m = team.members.find(x => x.name === name)
                if (!m?.sessionId) continue
                await dispatchToMember(ctx, m, buildDebatePrompt(task), m.worktreePath ?? ctx.directory, team)
            }
        })
        return
    }

    // Phase B: ruling (only the arbiter's idle reaches here).
    const r = parseArbitrationDecision(task.responses[task.arbiterMember ?? ""] ?? "")
    if (r.parseFailed) {
        await finishRun(ctx, team, "arbitrate_complete:decision_parse_failure", "failed")
        return
    }
    task.arbitrationRuling = r.ruling
    task.arbitrationRationale = r.rationale
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "arbitrated",
        member: task.arbiterMember,
        detail: truncateOutput(r.ruling, 200),
    })
    if (await maybeTriggerSignoff(ctx, team)) {
        return // signoff in progress
    }
    if (await maybeRequestApproval(ctx, team, {
        kind: "arbitrate_ruling",
        summary: `Arbiter ${task.arbiterMember ?? "unknown"} ruled: "${r.ruling}".\n\nRationale: ${r.rationale}`,
    })) {
        return
    }
    await finishRun(ctx, team, "arbitrate_complete:ruled", "idle")
}

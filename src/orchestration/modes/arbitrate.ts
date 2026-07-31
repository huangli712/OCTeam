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
import { logSwallowed } from "../../core/log.js"
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
import { findMember } from "../../tools/support.js"
import type { CaptureMemberOutputResult } from "../records/capture.js"

/** Max consecutive arbiter ruling parse failures before aborting the run. */
const MAX_RULING_PARSE_FAILURES = 2

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
export async function handleArbitrateIdle(
    ctx: PluginContext,
    team: Team,
    captureResult?: CaptureMemberOutputResult,
): Promise<void> {
    if (captureResult?.fresh === false && captureResult.reason === "stale") return
    const task = team.activeTask
    if (!task || task.type !== "arbitrate") return
    const disputants = task.disputants ?? []

    // Phase A: debate (arbitrationStage not yet set).
    if (!task.arbitrationStage) {
        await maybeAdvanceBarrier(team, disputants, async () => {
            // HIGH: verify dispatched disputants have responses before
            // advancing. Only check when a dispatch has occurred this round
            // (dispatchedParticipants is populated). First round or fresh
            // resume has no dispatchedParticipants, so skip the check.
            const dispatched = task.dispatchedParticipants
            if (dispatched && dispatched.length > 0) {
                const missing = dispatched.filter(name => task.responses[name] === undefined)
                if (missing.length > 0) {
                    for (const name of missing) {
                        const m = team.members.find(mm => mm.name === name)
                        if (m?.sessionId && m.status !== "running") {
                            try {
                                await dispatchToMember(ctx, m, buildDebatePrompt({ ...task, currentRound: task.currentRound ?? 1 }), m.worktreePath ?? ctx.directory, team)
                            } catch (err) {
                                logSwallowed(ctx, "arbitrate: re-dispatch failed", err, { member: name })
                            }
                        }
                    }
                    return
                }
            }
            if ((task.currentRound ?? 1) >= (task.maxRounds ?? DEFAULT_ARBITRATE_ROUNDS)) {
                // Debate exhausted -> transition to the ruling phase.
                task.arbitrationStage = true
                // Pre-ruling HITL: leader reviews the debate before the arbiter
                // is dispatched to issue the binding ruling. Mirrors tollgate
                // pre-verify. Triggered when hitlPhase is "pre" (default) or "both".
                const hitlPhase = task.hitlPhase ?? "pre"
                if ((hitlPhase === "pre" || hitlPhase === "both") && await maybeRequestApproval(ctx, team, {
                    kind: "arbitrate_ruling",
                    summary: `Arbitration debate complete after ${task.currentRound} round(s) on "${task.task ?? ""}". Review the debate before the arbiter issues a binding ruling.`,
                })) {
                    return
                }
                const arbiter = team.members.find(
                    m => m.name === task.arbiterMember && !m.isMaster,
                )
                if (!arbiter?.sessionId) {
                    // Arbiter unavailable: cannot rule -> fail.
                    await finishRun(ctx, team, "arbitrate_complete:arbiter_unavailable", "failed")
                    return
                }
                // H56: clear the arbiter's stale response before dispatch,
                // mirroring tollgate.ts startVerification (C17). The comment
                // below about "Arbiter's response preserved" was correct for
                // the round-re-dispatch path (line 124 clears disputants only),
                // but the FIRST dispatch into phase B must start clean.
                delete task.responses[task.arbiterMember ?? ""]
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
            // Increment round AFTER the dispatch loop (not before) so a partial
            // dispatch failure followed by a barrier re-fire does not skip a round.
            const nextRound = (task.currentRound ?? 1) + 1
            // H-M7: build the debate prompt BEFORE clearing responses. The prompt
            // for round > 1 includes prior-round positions via buildRoundSummary,
            // which reads task.responses. Pre-fix code deleted responses first,
            // so every round after 1 received an empty summary — debaters could
            // not see or rebut each other's positions.
            const prompts = new Map<string, string>()
            for (const name of disputants) {
                const m = team.members.find(x => x.name === name)
                if (!m?.sessionId) continue
                prompts.set(name, buildDebatePrompt({ ...task, currentRound: nextRound }))
            }
            // HIGH-D: clear prior-round disputant responses before re-dispatch.
            // Pre-fix code left them populated, so a disputant whose new round
            // produced no output (or crashed mid-turn) would have its stale
            // position counted toward the barrier AND read by the arbiter as
            // the disputant's final stance. Arbiter's response (if any from
            // a prior phase B retry) is preserved — phase B reads it directly.
            for (const name of disputants) {
                delete task.responses[name]
            }
            // H6: persist currentRound BEFORE dispatching. dispatchToMember
            // saves state internally; setting round first ensures disk state
            // is consistent with dispatched prompts. Pre-fix code set it
            // after dispatch — a crash would resume with wrong round.
            task.currentRound = nextRound
            task.dispatchedParticipants = []
            recordEvent(team, { timestamp: Date.now(), kind: "round", round: task.currentRound })
            for (const name of disputants) {
                const m = team.members.find(x => x.name === name)
                if (!m?.sessionId) continue
                try {
                    await dispatchToMember(ctx, m, prompts.get(name)!, m.worktreePath ?? ctx.directory, team)
                    task.dispatchedParticipants.push(name)
                } catch (err) {
                    logSwallowed(ctx, "arbitrate: dispatch failed for disputant", err, { member: name, round: nextRound })
                }
            }
            await saveTeamState(team)
        })
        return
    }

    // Phase B: ruling (only the arbiter's idle reaches here).
    const r = parseArbitrationDecision(task.responses[task.arbiterMember ?? ""] ?? "")
    if (r.parseFailed) {
        // Bounded retry: one re-dispatch before failing the run. LLM format
        // drift is a common operational failure, not an edge case — and here
        // it would discard all prior debate-round tokens. Uses the shared
        // decisionParseFailures counter (ActiveTask base field).
        task.decisionParseFailures++
        // H42: allow task-level override of the ruling parse-failure threshold.
        const maxFailures = task.maxRulingParseFailures ?? MAX_RULING_PARSE_FAILURES
        if (task.decisionParseFailures >= maxFailures) {
            await finishRun(ctx, team, "arbitrate_complete:decision_parse_failure", "failed")
            return
        }
        // Clear the malformed response so the next parse is not poisoned,
        // then re-dispatch the arbiter.
        delete task.responses[task.arbiterMember ?? ""]
        const arbiter = findMember(team, task.arbiterMember ?? "")
        if (!arbiter?.sessionId) {
            await finishRun(ctx, team, "arbitrate_complete:arbiter_unavailable", "failed")
            return
        }
        await dispatchToMember(ctx, arbiter,
            buildArbiterPrompt(task),
            arbiter.worktreePath ?? ctx.directory, team)
        await saveTeamState(team)
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
    // Post-ruling HITL: leader reviews the arbiter's binding ruling before
    // delivery. Triggered when hitlPhase is "post" or "both" (NOT default "pre").
    // Must run BEFORE signoff so a configured post-HITL is not bypassed by
    // the signoff stage's early return.
    const hitlPhase = task.hitlPhase ?? "pre"
    if ((hitlPhase === "post" || hitlPhase === "both") && await maybeRequestApproval(ctx, team, {
        kind: "arbitrate_ruling",
        summary: `Arbiter ${task.arbiterMember ?? "unknown"} ruled: "${r.ruling}".\n\nRationale: ${r.rationale}`,
    })) {
        return
    }
    if (await maybeTriggerSignoff(ctx, team)) {
        return // signoff in progress
    }
    await finishRun(ctx, team, "arbitrate_complete:ruled", "idle")
}

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
const ARBITER_PROMPT_TOTAL_CAP = 65_536

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
    const prefix = `[Arbitration ruling]\nDispute:\n${task.task ?? ""}\n\nDebater positions:\n`
    const suffix =
        `\n\nWeigh impartially and issue a BINDING ruling. Emit exactly one:\n`
        + `<ruling>{"decision":"...","rationale":"..."}</ruling> (Chinese <裁决> also accepted)`
    const positionsBudget = ARBITER_PROMPT_TOTAL_CAP - Buffer.byteLength(prefix + suffix, "utf8")
    return prefix + truncateOutput(positions, positionsBudget) + suffix
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
            const dispatched = task.dispatchedParticipants?.length
                ? task.dispatchedParticipants
                : disputants.filter(name => {
                    const member = team.members.find(m => m.name === name)
                    return (member?.turnCount ?? 0) > 0
                })
            if (dispatched.length > 0) {
                const missing = dispatched.filter(name => !task.responses[name])
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
                // Clear the arbiter's stale response before entering phase B.
                // Debate-round re-dispatch preserves arbiter responses, but the
                // first ruling dispatch must start clean.
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
            const nextRound = (task.currentRound ?? 1) + 1
            // Build the debate prompt before clearing responses because later
            // rounds include prior positions from task.responses. Clearing first
            // would give debaters an empty summary and prevent rebuttals.
            const prompts = new Map<string, string>()
            for (const name of disputants) {
                const m = team.members.find(x => x.name === name)
                if (!m?.sessionId) continue
                prompts.set(name, buildDebatePrompt({ ...task, currentRound: nextRound }))
            }
            // Clear prior-round disputant responses before re-dispatch so stale
            // positions cannot satisfy the barrier or become final stances when
            // a disputant produces no fresh output. Preserve the arbiter's
            // response because phase B reads it directly.
            for (const name of disputants) {
                delete task.responses[name]
            }
            // Persist currentRound before dispatching because dispatchToMember
            // saves state internally. This keeps disk state consistent with the
            // dispatched prompts if the process crashes.
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
                    // Mark the member errored so maybeAdvanceBarrier treats it as
                    // ready. Leaving it idle after a failed dispatch would make
                    // the barrier wait forever for a response.
                    m.status = "errored"
                    m.error = "debate dispatch failed"
                    task.dispatchedParticipants.push(name)
                    logSwallowed(ctx, "arbitrate: dispatch failed for disputant (marked errored)", err, { member: name, round: nextRound })
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
        // Allow a task-level override of the ruling parse-failure threshold.
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

/**
 * Content-Based Routing (route) and authoritative Arbitration (arbitrate)
 * handlers. Both are two-phase orchestrations: route runs router → target
 * barrier; arbitrate runs multi-round debate → arbiter ruling. Their prompt
 * builders live here next to the only callers.
 */

import type { PluginContext } from "../core/context.js"
import { type Team, clearActiveTask, saveTeamState } from "../state/store.js"
import type { ActiveTask, ArbitrateTask } from "../core/types.js"
import { dispatchToMember } from "./dispatch.js"
import { buildRoundSummary, deliverSummaryToLeader } from "./summary.js"
import { recordEvent } from "./events.js"
import { truncateOutput } from "../core/utils.js"
import { waitForBarrier } from "./barriers.js"
import { parseArbitrationDecision, parseRouteDecision } from "./decisions.js"
import { maybeTriggerSignoff } from "./signoff.js"

/**
 * Content-Based Routing (route mode). Two-phase orchestration:
 *   Phase A (router): a single member inspects the input and emits a
 *     <route>{...} decision naming the branch(es) to dispatch to. Only the
 *     router's idle advances the state machine (getExpectedMember gate).
 *   Phase B (targets): the selected branches' members run in parallel; their
 *     barrier converges to delivery (mirrors parallel, including failure
 *     isolation and optional signoff).
 *
 * No default route: a parse failure or zero matching branches fails the run
 * with a reason containing "decision_parse_failure" so runStatusFromReason
 * classifies it as failed.
 */
export async function handleRouteIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "route") return

    // Phase A: router phase (routeStage not yet set).
    if (!task.routeStage) {
        const decision = parseRouteDecision(task.responses[task.routerMember ?? ""] ?? "")
        const branches = task.routeBranches ?? []
        const selected = branches.filter(b => decision.targets.includes(b.name))

        if (decision.parseFailed || selected.length === 0) {
            // No default route: unmatched input fails the run.
            await deliverSummaryToLeader(ctx, team, "route_complete:decision_parse_failure")
            clearActiveTask(team)
            team.status = "failed"
            return
        }

        // Transition to Phase B: resolve targets, fan out.
        task.routeStage = true
        task.routeTargets = selected.map(b => b.member)
        task.routeDecisionRationale = decision.rationale
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "routed",
            member: task.routerMember,
            detail: `targets: ${task.routeTargets.join(",")}`,
        })
        for (const b of selected) {
            const m = team.members.find(x => x.name === b.member && !x.isMaster)
            if (!m?.sessionId) continue
            const text = b.task ?? task.task ?? ""
            await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory, team)
        }
        await saveTeamState(team)
        return
    }

    // Phase B: target barrier (any selected target's idle re-checks readiness).
    const targets = task.routeTargets ?? []
    await waitForBarrier(team, targets, async () => {
        // checkTermination owns fail-fast for route errors (route is excluded
        // from termination's concurrent set, so tolerance is 0); by the time the
        // barrier fires, all targets are idle.
        if (await maybeTriggerSignoff(ctx, team)) {
            return // signoff in progress
        }
        await deliverSummaryToLeader(ctx, team, "route_complete")
        clearActiveTask(team)
        team.status = "idle"
    })
}

/**
 * Build a debater's prompt for the current debate round. Round 1 states the
 * dispute subject; later rounds rebut other debaters' positions (drawn from
 * the latest captured responses via buildRoundSummary).
 */
export function buildDebatePrompt(task: ActiveTask): string {
    const round = task.currentRound ?? 1
    if (round <= 1) {
        return (
            `[Arbitration debate — Round 1] Subject:\n${task.task ?? ""}\n\n`
            + `State your position with reasoning. An arbiter will weigh all positions and issue a binding ruling.`
        )
    }
    const positions = buildRoundSummary(task.responses)
    return (
        `[Arbitration debate — Round ${round}] Other positions:\n${positions}\n\n`
        + `Rebut or refine your position.`
    )
}

/**
 * Build the arbiter's ruling prompt: the dispute plus every debater's final
 * position, requesting exactly one <ruling>{...} decision.
 */
export function buildArbiterPrompt(task: ArbitrateTask): string {
    const positions = (task.disputants ?? [])
        .map(name => `### ${name}\n${truncateOutput(task.responses[name] ?? "")}`)
        .join("\n\n")
    return (
        `[Arbitration ruling] Dispute:\n${task.task ?? ""}\n\n`
        + `Debater positions:\n${positions}\n\n`
        + `Weigh impartially and issue a BINDING ruling. Emit exactly one:\n`
        + `<ruling>{"decision":"...","rationale":"..."}</ruling> (Chinese <裁决> also accepted)`
    )
}

/**
 * Arbitrate (authoritative ruling). Two-phase orchestration:
 *   Phase A (debate): the debaters run in parallel over up to maxRounds rounds,
 *     each round broadcasting prior positions (consensus skeleton). Any
 *     debater's idle re-checks the barrier; it advances only when all are idle.
 *   Phase B (ruling): once rounds are exhausted, the arbiter is dispatched with
 *     all positions and emits a binding <ruling>; its idle delivers the result
 *     (loop decider pattern). Only the arbiter advances Phase B.
 *
 * max_rounds is the normal debate length (NOT a failure condition, unlike
 * consensus). Failures: arbiter unavailable, or unparseable ruling.
 */
export async function handleArbitrateIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "arbitrate") return
    const disputants = task.disputants ?? []

    // Phase A: debate (arbitrationStage not yet set).
    if (!task.arbitrationStage) {
        await waitForBarrier(team, disputants, async () => {
            if ((task.currentRound ?? 1) >= (task.maxRounds ?? 1)) {
                // Debate exhausted -> transition to the ruling phase.
                task.arbitrationStage = true
                const arbiter = team.members.find(
                    m => m.name === task.arbiterMember && !m.isMaster,
                )
                if (!arbiter?.sessionId) {
                    // Arbiter unavailable: cannot rule -> fail.
                    await deliverSummaryToLeader(ctx, team, "arbitrate_complete:arbiter_unavailable")
                    clearActiveTask(team)
                    team.status = "failed"
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
        await deliverSummaryToLeader(ctx, team, "arbitrate_complete:decision_parse_failure")
        clearActiveTask(team)
        team.status = "failed"
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
    await deliverSummaryToLeader(ctx, team, "arbitrate_complete:ruled")
    clearActiveTask(team)
    team.status = "idle"
}

/**
 * Content-Based Routing (route mode) handler. Two-phase orchestration:
 *   Phase A (router): a single member inspects the input and emits a
 *     <route>{...} decision naming the branch(es) to dispatch to.
 *   Phase B (targets): the selected branches' members run in parallel; their
 *     barrier converges to delivery (mirrors parallel, including failure
 *     isolation and optional signoff).
 */

import type { PluginContext } from "../core/context.js"
import { type Team, saveTeamState } from "../state/store.js"
import { dispatchToMember } from "./dispatch.js"
import { finishRun } from "./summary.js"
import { recordEvent } from "./events.js"
import { waitForBarrier } from "./barriers.js"
import { parseRouteDecision } from "./decisions.js"
import { maybeTriggerSignoff } from "./signoff.js"

/**
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
            await finishRun(ctx, team, "route_complete:decision_parse_failure", "failed")
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
        await finishRun(ctx, team, "route_complete", "idle")
    })
}

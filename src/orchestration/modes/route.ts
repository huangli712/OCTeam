/**
 * Content-Based Routing (route mode) handler. Two-phase orchestration:
 *   Phase A (router): a single member inspects the input and emits a
 *     <route>{...} decision naming the branch(es) to dispatch to.
 *   Phase B (targets): the selected branches' members run in parallel; their
 *     barrier converges to delivery (mirrors parallel, including failure
 *     isolation and optional signoff).
 *
 * STATE MACHINE:
 *   Phase A: router_dispatch → parse_route → fan_out_to_targets
 *   Phase B: target_barrier → [signoff →] deliver
 *   - All targets complete → check signoff → deliver (idle: route_complete)
 *   - Route parse failure / no branches selected → deliver (failed: route_complete:decision_parse_failure)
 */

import type { PluginContext } from "../../core/context.js"
import type { RouteBranch } from "../../core/types.js"
import { type Team, saveTeamState } from "../../state/store.js"
import { dispatchToMember } from "../control/dispatch.js"
import { finishRun } from "../control/completion.js"
import { recordEvent } from "../records/events.js"
import { maybeAdvanceBarrier } from "../control/barriers.js"
import { parseRouteDecision } from "../protocol/decisions.js"
import { maybeTriggerSignoff } from "../control/signoff.js"
import { maybeRequestApproval } from "../control/approval.js"
import { findMember } from "../../tools/support.js"

/** Max consecutive router parse failures before aborting the run. */
const MAX_ROUTE_PARSE_FAILURES = 2

/**
 * Build the router member's dispatch prompt: the input to route, the available
 * branches, and the <route> decision format the router must emit.
 *
 * Lives in the orchestration layer so both the initial dispatch path
 * (tools/router.ts) and the crash-recovery path (resume.ts) consume the same
 * source — preventing prompt-format drift between first-run and resume.
 */
export function buildRouterPrompt(teamName: string, input: string, branches: RouteBranch[]): string {
    const list = branches
        .map(b => {
            const desc = b.description ? ` — ${b.description}` : ""
            return `- ${b.name} (-> ${b.member})${desc}`
        })
        .join("\n")
    return (
        `[Route task]\n`
        + `You are the router for team "${teamName}". Analyze the input below and `
        + `select which branch(es) should handle it. Available branches:\n${list}\n\n`
        + `Emit your decision as:\n`
        + `<route>{"branch": "<name>", "rationale": "<why>"}</route>\n`
        + `For multiple branches: <route>{"branches": ["a","b"], "rationale": "..."}</route>\n`
        + `The tags must be the literal English <route> and </route> (Chinese alias <路由> also accepted).\n\n`
        + `[Input]\n${input}`
    )
}

/** Dispatch the selected route targets after the router's decision is parsed. */
export async function advanceRouteAfterDecision(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "route") return
    const branches = task.routeBranches ?? []
    const targets = task.routeTargets ?? []
    const selected = branches.filter(b => targets.includes(b.member))
    for (const b of selected) {
        const m = findMember(team, b.member)
        if (!m?.sessionId) {
            await finishRun(ctx, team, `route_complete:target_unavailable:${b.member}`, "failed")
            return
        }
        const text = b.task ?? task.task ?? ""
        await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory, team)
    }
    await saveTeamState(team)
}

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

        if (decision.parseFailed) {
            // Bounded retry: one re-dispatch before failing the run. LLM
            // format drift is a common operational failure, not an edge case.
            // Uses the shared decisionParseFailures counter (ActiveTask base
            // field, same as loop's parse-failure handling).
            task.decisionParseFailures++
            if (task.decisionParseFailures >= MAX_ROUTE_PARSE_FAILURES) {
                await finishRun(ctx, team, "route_complete:decision_parse_failure", "failed")
                return
            }
            // Clear the malformed response so the next parse is not poisoned
            // by stale output, then re-dispatch the router.
            delete task.responses[task.routerMember ?? ""]
            const router = findMember(team, task.routerMember ?? "")
            if (!router?.sessionId) {
                await finishRun(ctx, team, "route_complete:router_unavailable", "failed")
                return
            }
            await dispatchToMember(ctx, router,
                buildRouterPrompt(team.teamName, task.task ?? "", task.routeBranches ?? []),
                router.worktreePath ?? ctx.directory, team)
            await saveTeamState(team)
            return
        }
        if (selected.length === 0) {
            // No default route: valid decision but unmatched input fails the run.
            await finishRun(ctx, team, "route_complete:no_matching_branch", "failed")
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
        if (await maybeRequestApproval(ctx, team, {
            kind: "route_decision",
            summary: `Router ${task.routerMember ?? "unknown"} selected target member(s): ${task.routeTargets.join(", ")}.\n\nRationale: ${decision.rationale}`,
        })) {
            return
        }
        await advanceRouteAfterDecision(ctx, team)
        return
    }

    // Phase B: target barrier (any selected target's idle re-checks readiness).
    const targets = task.routeTargets ?? []
    // H-29: detect partial fan-out failure. If SOME targets were dispatched
    // (turnCount > 0) but others were NOT (turnCount === 0), the barrier would
    // falsely conclude "all targets idle → run complete" for the undispatched
    // ones. Only check when at least one target has turnCount > 0 (proving the
    // fan-out started) — this avoids false-positives in test fixtures where no
    // dispatch has happened yet.
    const dispatchedCount = targets.filter(name => {
        const m = findMember(team, name)
        return m && (m.turnCount ?? 0) > 0
    }).length
    if (dispatchedCount > 0 && dispatchedCount < targets.length) {
        const undispatched = targets.filter(name => {
            const m = findMember(team, name)
            return !m || (m.turnCount ?? 0) === 0
        })
        await finishRun(ctx, team, `route_complete:partial_fanout:${undispatched.join(",")}`, "failed")
        return
    }
    await maybeAdvanceBarrier(team, targets, async () => {
        // checkTermination owns fail-fast for route errors (route is excluded
        // from termination's concurrent set, so tolerance is 0); by the time the
        // barrier fires, all targets are idle.
        if (await maybeTriggerSignoff(ctx, team)) {
            return // signoff in progress
        }
        await finishRun(ctx, team, "route_complete", "idle")
    })
}

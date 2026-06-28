/**
 * Shared helpers for the nine workflow tools (team_parallel, team_consensus,
 * team_pipeline, team_loop, team_delegate, team_route, team_arbitrate,
 * team_tollgate, team_recurse). Extracted from workflow.ts so each tool group
 * (basic / advanced) can import them without pulling in sibling tools.
 *
 * ALL NINE tools share the same three-phase lock order via startOrchestration
 * (team_resume follows the same Phase 2 contract too — see resume.ts):
 *   1. Pre-checks UNDER team.mutex (reject if already orchestrating; validate)
 *   2. ensureMembersReady OUTSIDE the mutex (the role-setup barrier needs the
 *      event handler to flip member.initialized, which it does inside the
 *      mutex — holding it here would deadlock)
 *   3. Commit activeTask + dispatch the first stage UNDER the mutex
 *
 * INVARIANT: never call ensureMembersReady inside team.mutex.runExclusive — it
 * will deadlock the role-setup barrier. Enforced structurally by
 * startOrchestration; the per-tool callbacks cannot violate it.
 */

import type { ToolContext } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { loadTeamState, saveTeamState, type Team } from "../state/store.js"
import { ensureMembersReady } from "../orchestration/dispatch.js"
import { activationError } from "../core/utils.js"
import { resolveCallerInTeam } from "../state/resolve.js"
import type { ActiveTask, DecisionRecord, ReducePolicy, SignoffPolicy } from "../core/types.js"

export const DEFAULT_TIMEOUT_MS = 600_000
export const DEFAULT_LOOP_TIMEOUT_MS = 900_000

// Named defaults for orchestration parameters (wf-011). Previously these were
// scattered as inline `?? N` literals across the Phase-3 commit blocks, which
// made the effective defaults hard to audit and easy to drift between tools.
export const DEFAULT_CONSENSUS_ROUNDS = 3
export const DEFAULT_ARBITRATE_ROUNDS = 1
export const DEFAULT_RECURSE_DEPTH = 3
export const DEFAULT_RECURSE_SUBTASKS = 5
export const DEFAULT_SIGNOFF_POLICY: SignoffPolicy = "none"
export const DEFAULT_REDUCE_POLICY: ReducePolicy = "summarize"

/**
 * Assert that `name` is a member of `team`. Returns a ready-to-return Error
 * string when the name does not match any member, or null when it is valid
 * (wf-008). `label` identifies the offending field in the message (e.g.
 * "signoff_decider", "decomposer"). The message format is kept identical to the
 * previous inline checks so existing error-string assertions still hold.
 */
export function assertMember(team: Team, name: string, label: string): string | null {
    if (!team.members.some(m => m.name === name)) {
        return `Error: ${label} "${name}" is not a member of team "${team.teamName}"`
    }
    return null
}

/**
 * Effective wall-clock timeout: the requested timeout (or a mode default)
 * clamped to the team's hard cap bounds.maxWallClockMinutes. Without this
 * clamp a caller could pass timeout_ms far above the team's configured limit. A
 * non-positive cap (e.g. a hand-edited state.json) is treated as "no cap" rather
 * than collapsing the timeout to 0, which would abort every orchestration.
 */
export function effectiveTimeoutMs(
    requestedMs: number | undefined,
    defaultMs: number,
    maxWallClockMinutes: number,
): number {
    const requested = requestedMs ?? defaultMs
    const cap = maxWallClockMinutes > 0 ? maxWallClockMinutes * 60_000 : Infinity
    return Math.min(requested, cap)
}

/**
 * Shared three-phase orchestration startup (wf-004). All nine workflow tools
 * follow the same spine — the per-tool boilerplate has been collapsed into
 * this helper. Phases:
 *   1. master-only auth (resolveCallerInTeam + isMaster), auth-first (wf-009)
 *   2. loadTeamState + activationError gate
 *   3. tool-specific validation (validate callback)
 *   4. Phase 1: busy pre-check under mutex
 *   5. Phase 2: ensureMembersReady OUTSIDE mutex (the role-setup barrier needs
 *      the event handler to flip member.initialized, which runs inside the
 *      mutex — holding it here would deadlock)
 *   6. Phase 3: commit activeTask + initial dispatch UNDER mutex
 *   7. success message
 *
 * Tool-specific concerns are supplied via callbacks:
 *   - validate(team): input checks needing team state. Error string | null.
 *   - buildTask(team): construct the type-specific ActiveTask. May perform
 *     pre-commit side effects. Return { error } to bail, or the ActiveTask.
 *   - dispatch(team, task): initial member dispatch(es) after activeTask commit.
 *   - successMessage(): success string.
 */
export async function startOrchestration(
    teamId: string,
    context: ToolContext,
    ctx: PluginContext,
    toolName: string,
    validate: (team: Team) => string | null,
    buildTask: (team: Team) => Promise<ActiveTask | { error: string }>,
    dispatch: (team: Team, task: ActiveTask) => Promise<void>,
    successMessage: () => string,
): Promise<string> {
    // Step 1: master-only auth. Auth-first (wf-009): runs before any parameter
    // validation so a non-master caller never learns whether its arguments
    // were well-formed.
    const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, teamId)
    if (!caller?.isMaster) {
        return `Error: ${toolName} is master-only`
    }

    // Step 2: load + activation gate. The master may only orchestrate the
    // active team.
    const team = await loadTeamState(ctx.storageRoot, teamId, caller.leadSessionId)
    const gate = activationError(team.teamName, team.activatedAt)
    if (gate) return gate

    // Step 3: tool-specific validation.
    const validationError = validate(team)
    if (validationError) return validationError

    // Step 4: Phase 1 — busy pre-check under mutex.
    let busy = false
    await team.mutex.runExclusive(async () => {
        if (team.activeTask) busy = true
    })
    if (busy) return "Error: team already has an active orchestration"
    let raced = false
    let buildError: string | undefined

    // Step 5: Phase 2 — spawn + role-setup barrier (OUTSIDE mutex).
    await ensureMembersReady(ctx, team)

    // Step 6: Phase 3 — commit activeTask + initial dispatch (UNDER mutex).
    await team.mutex.runExclusive(async () => {
        if (team.activeTask) { raced = true; return } // Re-check inside mutex (prevents double-commit race)
        const built = await buildTask(team)
        if ("error" in built) {
            buildError = built.error
            return
        }
        team.status = "busy"
        team.activeTask = built
        await saveTeamState(team)
        // Reset per-member done/retry flags for the new run so a previous
        // run's acks don't bleed in. declaredDone only matters when
        // requireDoneAck is true, but cheap to always reset.
        for (const m of team.members) {
            m.declaredDone = false
            m.retryCount = 0
        }
        await dispatch(team, built)
    })
    if (raced) return "Error: team already has an active orchestration"
    if (buildError) return buildError

    // Step 7: success.
    return successMessage()
}

/**
 * Validate the signoff_policy 'decider' field: requires signoff_decider to be
 * present and name a real team member. Shared by the 7 tools that expose
 * signoff (all except consensus and loop). Returns an error string or null.
 */
export function validateSignoff(
    args: { signoff_policy?: SignoffPolicy; signoff_decider?: string },
    team: Team,
): string | null {
    if (args.signoff_policy !== "decider") return null
    if (!args.signoff_decider) {
        return "Error: signoff_policy 'decider' requires signoff_decider (a member name)"
    }
    return assertMember(team, args.signoff_decider, "signoff_decider")
}

/**
 * The three signoff fields shared by every ActiveTask variant that supports
 * post-completion review. Consensus has its own built-in agreement gate, so it
 * hardcodes DEFAULT_SIGNOFF_POLICY and omits decider/quorum.
 */
export function signoffTaskFields(
    args: { signoff_policy?: SignoffPolicy; signoff_decider?: string; signoff_quorum?: number },
): { signoffPolicy: SignoffPolicy; signoffDecider: string | undefined; signoffQuorum: number | undefined } {
    return {
        signoffPolicy: args.signoff_policy ?? DEFAULT_SIGNOFF_POLICY,
        signoffDecider: args.signoff_decider,
        signoffQuorum: args.signoff_quorum,
    }
}

/**
 * The common ActiveTask base fields shared by all 9 orchestration tools.
 * Tool-specific fields (type discriminant, stages, per-mode fields) are added
 * by the caller AFTER spreading this.
 */
export function baseTaskFields(
    args: { timeout_ms?: number; token_budget?: number; max_retries?: number },
    team: Team,
    defaultTimeoutMs: number,
): {
    runId: string
    startedAt: number
    wallClockTimeoutMs: number
    tokenBudget: number | undefined
    tokensUsed: number
    tokensByMember: Record<string, number>
    messagesSent: number
    responses: Record<string, string>
    currentStageIndex: number
    decisionHistory: DecisionRecord[]
    decisionParseFailures: number
    maxRetries: number | undefined
} {
    return {
        runId: crypto.randomUUID(),
        startedAt: Date.now(),
        wallClockTimeoutMs: effectiveTimeoutMs(args.timeout_ms, defaultTimeoutMs, team.bounds.maxWallClockMinutes),
        tokenBudget: args.token_budget,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        maxRetries: args.max_retries,
    }
}

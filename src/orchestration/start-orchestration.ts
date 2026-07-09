/**
 * Orchestration startup helpers shared by all workflow tools (the 11
 * orchestration modes: parallel, pipeline, loop, delegate, consensus, route,
 * arbitrate, recurse, tollgate, workflow, arena).
 *
 * Extracted from shared.ts so that pure validation/utility helpers
 * (validateMemberName, validateSignoff, defaultBounds, ...) no longer pull in
 * the dispatch/worktree subsystem via ensureMembersReady.
 *
 * ALL workflow tools share the same three-phase lock order via
 * startOrchestration (team_resume follows the same Phase 2 contract too — see
 * resume.ts):
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

import crypto from "node:crypto"
import type { ToolContext } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { loadTeamState, saveTeamState, type Team } from "../state/store.js"
import { ensureMembersReady } from "./dispatch.js"
import { activationError } from "../state/activation.js"
import { resolveCallerInTeam } from "../state/resolve.js"
import type { ActiveTask, DecisionRecord, ReducePolicy, SignoffPolicy } from "../core/types.js"

// ============================================================
// Orchestration defaults
// ============================================================
// Schema field builders (signoffSchemaFields, humanApprovalSchemaFields) live
// in tools/shared-schema.ts — the tool-layer concern. The matching ActiveTask
// field builders below (signoffTaskFields, humanApprovalTaskFields) are the
// runtime-layer counterpart; they are intentionally kept here because they
// depend on runtime types (SignoffPolicy, Team).

/** Default orchestration timeout in milliseconds (10 minutes). */
export const DEFAULT_TIMEOUT_MS = 600_000
/** Default loop orchestration timeout in milliseconds (15 minutes). */
export const DEFAULT_LOOP_TIMEOUT_MS = 900_000

// Named defaults for orchestration parameters (wf-011). Previously these were
// scattered as inline `?? N` literals across the Phase-3 commit blocks, which
// made the effective defaults hard to audit and easy to drift between tools.
// The numeric defaults live in orchestration/defaults.ts (single-sourced for
// both the tool and handler layers); re-exported here for tool-layer callers.
/** Re-export named orchestration defaults from defaults.ts for tool-layer callers. */
export {
    DEFAULT_CONSENSUS_ROUNDS,
    DEFAULT_ARBITRATE_ROUNDS,
    DEFAULT_RECURSE_DEPTH,
    DEFAULT_RECURSE_SUBTASKS,
} from "./defaults.js"
/** Default signoff policy: no post-completion review. */
export const DEFAULT_SIGNOFF_POLICY: SignoffPolicy = "none"
/** Default reduce policy: concatenate member outputs with a header summary. */
export const DEFAULT_REDUCE_POLICY: ReducePolicy = "summarize"

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

// ============================================================
// ActiveTask field builders
// ============================================================

/**
 * The three signoff fields shared by every ActiveTask variant that supports
 * post-completion review. Consensus has its own built-in agreement gate, so it
 * hardcodes DEFAULT_SIGNOFF_POLICY and omits decider/quorum.
 *
 * Runtime counterpart of signoffSchemaFields (tools/shared-schema.ts).
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
 * Build human approval task fields (approval flag + empty history) for
 * ActiveTask construction.
 *
 * Runtime counterpart of humanApprovalSchemaFields (tools/shared-schema.ts).
 */
export function humanApprovalTaskFields(
    args: { human_approval?: boolean },
): { humanApproval: boolean | undefined; approvalHistory: [] } {
    return {
        humanApproval: args.human_approval,
        approvalHistory: [],
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

// ============================================================
// Three-phase orchestration startup
// ============================================================

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

    // Step 4: Phase 1 — busy pre-check under mutex. The spawning guard
    // reserves the spawn slot: a second concurrent caller that also passed
    // Steps 1-3 sees spawning=true here and bails before duplicating
    // member-session spawns in Phase 2 (which runs OUTSIDE the mutex).
    let busy = false
    await team.mutex.runExclusive(async () => {
        if (team.activeTask || team.spawning) busy = true
        else team.spawning = true
    })
    if (busy) return "Error: team already has an active orchestration"
    let raced = false
    let buildError: string | undefined

    // try/finally guarantees team.spawning is cleared on every exit path
    // (success, raced, build error, or exception). Without this a barrier
    // timeout or dispatch throw would leave spawning=true and permanently
    // block the team.
    try {
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
            const prevStatus = team.status
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
            try {
                await dispatch(team, built)
            } catch (err) {
                // Roll back the busy+activeTask commit so a dispatch failure
                // does not wedge the team requiring external recovery.
                team.status = prevStatus
                team.activeTask = undefined
                await saveTeamState(team)
                throw err
            }
        })
    } finally {
        team.spawning = false
    }
    if (raced) return "Error: team already has an active orchestration"
    if (buildError) return buildError

    // Step 7: success.
    return successMessage()
}

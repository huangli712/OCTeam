/**
 * Shared helpers for all team tools (lifecycle + workflow). Merged from the
 * former lifecycle-shared.ts and workflow-shared.ts — the two had no symbol
 * overlap and every tool file imported exactly one of them, so a single
 * shared module removes a split that no longer reflects a real boundary.
 *
 * Lifecycle helpers: defaultBounds.
 * (Activation logic ActivateDecision/decideActivate/withOrderedLocks lives in
 * state/activation.ts — used exclusively by the team_activate tool.)
 *
 * Workflow helpers: startOrchestration (shared three-phase lock order — see
 * the Phase 1/2/3 contract below), baseTaskFields, validateSignoff,
 * signoffTaskFields, assertMember, effectiveTimeoutMs, DEFAULT_*.
 *
 * ALL NINE workflow tools share the same three-phase lock order via
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
import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { OCTEAM_AGENTS, isOCTeamAgent } from "../core/role.js"
import { loadTeamState, saveTeamState, type Team } from "../state/store.js"
import { MEMBER_NAME_POOL } from "../state/naming.js"
import { ensureMembersReady } from "./dispatch.js"
import { activationError } from "../core/utils.js"
import { resolveCallerInTeam } from "../state/resolve.js"
import type { ActiveTask, Bounds, DecisionRecord, ReducePolicy, SignoffPolicy } from "../core/types.js"

// ============================================================
// Bounds + member validation (used by create, add_member, and workflow tools)
// ============================================================

/** Resource bounds with design defaults, overridden by user input. */
export function defaultBounds(override?: Partial<Bounds>): Bounds {
    return {
        maxMembers: 8,
        maxParallelMembers: 4,
        maxMessagesPerRun: 100,
        maxWallClockMinutes: 30,
        maxMemberTurns: 50,
        maxTasks: 200,
        messagePayloadMaxBytes: 32768,
        messageUnreadMaxBytes: 1048576,
        ...override,
    }
}

/**
 * Validate a member name against the reserved-name and name-pool membership
 * rules. Shared by team_create (per-input-member) and team_add_member so the
 * two paths cannot drift. Returns an error string, or null when valid.
 */
export function validateMemberName(name: string): string | null {
    // "master" and "orchestrator" are reserved synthetic identities (the
    // leader pseudo-member and the orchestrator message sender); a real
    // member by either name would collide with them.
    if (name === "master" || name === "orchestrator") {
        return `Error: "${name}" is a reserved name and cannot be a member name`
    }
    if (!(MEMBER_NAME_POOL as readonly string[]).includes(name)) {
        return `Error: name "${name}" is not a preset pool name. Choose one of: ${MEMBER_NAME_POOL.join(", ")}`
    }
    return null
}

/**
 * Validate an agent override: must be one of OCTeam's hardened oct-* agents.
 * A bare host agent (e.g. "build") would bypass the role->agent
 * permission-hardening chokepoint (role.ts). Shared by team_create and
 * team_add_member so the two paths cannot drift. Returns an error string, or
 * null when valid. Callers gate on `agent !== undefined` themselves.
 */
export function validateMemberAgent(agent: string): string | null {
    if (!isOCTeamAgent(agent)) {
        return `Error: agent "${agent}" is not a hardened oct-* agent. Members must run as one of: ${OCTEAM_AGENTS.join(", ")}. Omit 'agent' to derive it from the role.`
    }
    return null
}

// ============================================================
// Workflow helpers (former workflow-shared.ts)
// ============================================================

export const DEFAULT_TIMEOUT_MS = 600_000
export const DEFAULT_LOOP_TIMEOUT_MS = 900_000

/**
 * The three signoff schema fields shared by every workflow tool that supports
 * post-completion review (7 of 9 tools — all except consensus and loop, which
 * have their own built-in agreement gates). Spread into a tool's
 * tool.schema.object({...}) to single-source the descriptions and constraints.
 */
export const signoffSchemaFields = {
    signoff_policy: tool.schema
        .enum(["none", "decider", "peer-quorum"])
        .optional()
        .describe("post-completion review gate. 'none' (default): direct delivery. 'decider': named member reviews. 'peer-quorum': all members vote."),
    signoff_decider: tool.schema
        .string()
        .optional()
        .describe("member name to act as signoff decider (when signoff_policy='decider')"),
    signoff_quorum: tool.schema
        .number()
        .gt(0)
        .max(1)
        .optional()
        .describe("fraction of members needed for peer-quorum (default 0.5 = majority). Only when signoff_policy='peer-quorum'."),
}

export const humanApprovalSchemaFields = {
    human_approval: tool.schema
        .boolean()
        .optional()
        .describe("Pause at supported mid-run boundaries and require the leader to call team_approve/team_reject before continuing."),
}

// Named defaults for orchestration parameters (wf-011). Previously these were
// scattered as inline `?? N` literals across the Phase-3 commit blocks, which
// made the effective defaults hard to audit and easy to drift between tools.
// The numeric defaults live in orchestration/defaults.ts (single-sourced for
// both the tool and handler layers); re-exported here for tool-layer callers.
export {
    DEFAULT_CONSENSUS_ROUNDS,
    DEFAULT_ARBITRATE_ROUNDS,
    DEFAULT_RECURSE_DEPTH,
    DEFAULT_RECURSE_SUBTASKS,
} from "../orchestration/defaults.js"
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

/**
 * Abort every running non-master member session and reset all non-master
 * members to a clean idle state (clears declaredDone / retryingSince). Shared
 * by team_cancel and team_delete (busy-team teardown), which previously
 * duplicated this ~12-line block. Best-effort on abort: a failed abort must
 * not block cancel/delete. Caller MUST already hold team.mutex.
 */
export async function abortAndResetMembers(ctx: PluginContext, team: Team): Promise<void> {
    // Abort running member turns (best-effort).
    for (const m of team.members) {
        if (!m.isMaster && m.sessionId && m.status === "running") {
            await ctx.client.session
                .abort({
                    path: { id: m.sessionId },
                    query: { directory: m.worktreePath ?? ctx.directory },
                })
                .catch(() => {
                    // best-effort: a failed abort must not block teardown
                })
        }
    }
    // Reset every non-master member to a clean idle state.
    for (const m of team.members) {
        if (m.isMaster) continue
        m.status = "idle"
        m.declaredDone = false
        m.retryingSince = undefined
    }
}

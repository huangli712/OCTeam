/**
 * Orchestration startup helpers shared by all workflow tools (the 12
 * orchestration modes: parallel, pipeline, loop, delegate, consensus, route,
 * arbitrate, recurse, tollgate, arena, quorum, workflow).
 *
 * Pure validation and utility helpers remain separate from the dispatch and
 * worktree subsystem used by ensureMembersReady.
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

import type { PluginContext } from "../../core/context.js"
import {
    loadTeamState,
    saveTeamState,
    isValidTeamState,
    type Team
} from "../../state/store.js"
import { teamLifecycleLockPath, statePath } from "../../state/paths.js"
import { withLock, safeReadFile } from "../../state/locks.js"
import { ensureMembersReady } from "../control/members.js"
import { activationError } from "../../state/activation.js"
import { resolveCallerInTeam } from "../../state/resolve.js"
import type {
    ActiveTask,
    DecisionRecord,
    MemberState,
    ReducePolicy,
    SignoffPolicy,
    SdkMessage
} from "../../core/types.js"
import { sumMemberTokens } from "../protocol/output.js"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"

// ============================================================
// Orchestration defaults
// ============================================================

/** Default orchestration timeout in milliseconds (10 minutes). */
export const DEFAULT_TIMEOUT_MS = 600_000

/** Default loop orchestration timeout in milliseconds (15 minutes). */
export const DEFAULT_LOOP_TIMEOUT_MS = 900_000

/** Re-export named orchestration defaults from defaults.ts for tool-layer callers. */
export {
    DEFAULT_CONSENSUS_ROUNDS,
    DEFAULT_ARBITRATE_ROUNDS,
    DEFAULT_RECURSE_DEPTH,
    DEFAULT_RECURSE_SUBTASKS,
} from "../modes/defaults.js"

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
 * Runtime counterpart of signoffSchemaFields (tools/schema.ts).
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
 * Runtime counterpart of humanApprovalSchemaFields (tools/schema.ts).
 */
export function humanApprovalTaskFields(
    args: { human_approval?: boolean; approval_timeout_ms?: number },
): { humanApproval: boolean | undefined; approvalHistory: []; approvalTimeoutMs: number | undefined } {
    return {
        humanApproval: args.human_approval,
        approvalHistory: [],
        // Connect the schema-level approval_timeout_ms to the
        // ActiveTask field so checkTermination's timeout logic is reachable.
        // Default: no timeout (infinite wait) unless explicitly configured.
        approvalTimeoutMs: args.approval_timeout_ms,
    }
}

/**
 * The common ActiveTask base fields shared by all orchestration tools.
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
 * Shared three-phase orchestration startup. All twelve workflow tools
 * follow the same spine — the per-tool boilerplate has been collapsed into
 * this helper. Phases:
 *   1. master-only auth (resolveCallerInTeam + isMaster), auth-first
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
    // Step 1: master-only auth. Auth-first: runs before any parameter
    // validation so a non-master caller never learns whether its arguments
    // were well-formed.
    const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, teamId)
    if (!caller?.isMaster) {
        return `Error: ${toolName} is master-only`
    }

    // Step 2: load + activation gate. The master may only orchestrate the
    // active team.
    let team: Team
    try {
        team = await loadTeamState(ctx.storageRoot, teamId, caller.leadSessionId)
    } catch (err) {
        if (isEnoent(err)) return `Error: team "${teamId}" not found`
        logSwallowed(ctx, "loadTeamState failed", err, { team: teamId })
        return `Error: team "${teamId}" could not be loaded (state file unreadable)`
    }
    const gate = activationError(team.teamName, team.activatedAt)
    if (gate) return gate

    // Step 3: tool-specific validation.
    const validationError = validate(team)
    if (validationError) return validationError

    // Step 4: Phase 1 — busy pre-check under mutex AND cross-process file
    // lock. The spawning guard reserves the spawn slot: a second concurrent
    // caller (including a sibling process) sees spawning=true and bails
    // before duplicating member-session spawns in Phase 2.
    // The file lock serializes the spawning check and state update across
    // sibling processes, complementing the in-process mutex.
    let busy = false
    const spawnOwner = crypto.randomUUID()
    await withLock(teamLifecycleLockPath(team.directory), async () => team.mutex.runExclusive(async () => {
        // Read state.json directly (NOT via loadTeamState, which
        // re-acquires team.mutex internally and self-deadlocks the
        // non-reentrant AsyncMutex). The teamLifecycleLockPath file lock
        // guarantees no sibling process is concurrently writing state.json.
        try {
            const diskRaw = await safeReadFile(team.directory, statePath(team.directory), { maxBytes: 1024 * 1024 })
            if (diskRaw !== undefined) {
                const parsed = JSON.parse(diskRaw) as unknown
                if (isValidTeamState(parsed, team.directory) && (parsed.spawning || parsed.activeTask)) {
                    // Sync our cache with disk state.
                    team.spawning = parsed.spawning
                    team.spawningOwner = parsed.spawningOwner
                    team.activeTask = parsed.activeTask
                    busy = true
                    return
                }
            }
        } catch {
            // Disk read failed — fall through to the cache check. The file
            // lock still protects against siblings.
        }
        if (team.activeTask || team.spawning) { busy = true; return }
        team.spawning = true
        team.spawningOwner = spawnOwner
        try {
            await saveTeamState(team)
        } catch (err) {
            team.spawning = false
            team.spawningOwner = undefined
            throw err
        }
    }), team.directory)
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

        // Snapshot per-member token baselines so run-local token accounting
        // excludes tokens from prior runs on the same persistent session.
        // OpenCode sessions survive across runs; without this baseline, a
        // second run's tokenBudget check would include the first run's tokens.
        const tokenBaselineByMember: Record<string, number> = {}
        const baselineMembers = team.members.filter(
            (m): m is MemberState & { sessionId: string } => !m.isMaster && typeof m.sessionId === "string",
        )
        const baselines = await Promise.all(
            baselineMembers.map(async m => {
                try {
                    const result = await ctx.client.session.messages({ path: { id: m.sessionId } })
                    const data = Array.isArray(result.data) ? result.data : []
                    return [m.name, sumMemberTokens(data as SdkMessage[])] as const
                } catch (err) {
                    // Log the error so operators can distinguish a genuinely
                    // empty session (baseline 0 is correct) from a permission /
                    // protocol / SDK failure (baseline 0 is wrong — it over-counts
                    // tokens for the current run, potentially triggering budget
                    // termination prematurely). The baseline stays 0 either way
                    // (over-counting is safe for budget), but the log makes the
                    // failure diagnosable.
                    logSwallowed(ctx, "startOrchestration: token baseline fetch failed", err, {
                        member: m.name, sessionId: m.sessionId,
                    })
                    return [m.name, 0] as const
                }
            }),
        )
        for (const [name, tokens] of baselines) tokenBaselineByMember[name] = tokens

        // Step 6: Phase 3 — commit activeTask + initial dispatch (UNDER mutex).
        await team.mutex.runExclusive(async () => {
            // Re-check activation, activeTask, and spawning inside the mutex so
            // a concurrent deactivation between Phase 1 and Phase 3 cannot start
            // dispatching on an inactive team.
            if (team.activeTask || !team.spawning) { raced = true; return }
            // Re-validate activation: team_deactivate sets activatedAt=undefined.
            const stillActivated = activationError(team.teamName, team.activatedAt)
            if (stillActivated) { raced = true; return }
            const built = await buildTask(team)
            if ("error" in built) {
                buildError = built.error
                return
            }
            built.tokenBaselineByMember = tokenBaselineByMember
            const prevStatus = team.status
            team.status = "busy"
            team.activeTask = built
            // Record the running process PID so the reconciler can
            // distinguish a crashed process from a live sibling.
            team.runnerPid = process.pid
            // Reset per-member done/retry flags for the new run so a previous
            // run's acks don't bleed in. declaredDone only matters when
            // requireDoneAck is true, but cheap to always reset.
            // Reset lastCapturedMsgCount so the idempotency guard cannot skip a
            // new run's first idle after session compaction changes message count.
            for (const m of team.members) {
                m.declaredDone = false
                m.retryCount = 0
                m.turnCount = 0
                m.lastCapturedMsgCount = undefined
            }
            // Persist AFTER flag resets so a crash between saveTeamState and
            // the reset loop does not leave stale member flags on disk.
            // Persist inside the dispatch try/catch so save and dispatch failures
            // share the same rollback: members become errored, status is restored,
            // and activeTask is cleared.
            try {
                await saveTeamState(team)
                await dispatch(team, built)
                // Persist post-dispatch member states (status="running",
                // turnCount=1) so a crash between dispatch and the first
                // idle event does not leave persisted state showing pre-dispatch
                // member flags while the runtime shows them as running.
                await saveTeamState(team)
            } catch (err) {
                // Roll back the busy+activeTask commit so a dispatch failure
                // does not wedge the team requiring external recovery.
                // Members already dispatched (status="running", turnCount>0) must
                // be marked errored — without this they keep running but their
                // idle events are silently dropped (no activeTask to process
                // them), and the next startup sees them as healthy (re-dispatch
                // collides with the orphaned turn).
                for (const m of team.members) {
                    if (m.status === "running" || (m.turnCount ?? 0) > 0) {
                        // Abort the session before marking errored so
                        // it doesn't keep running and consume tokens.
                        if (m.sessionId) {
                            try {
                                await ctx.client.session.abort({
                                    path: { id: m.sessionId },
                                    query: { directory: m.worktreePath ?? ctx.directory },
                                })
                            } catch { /* best-effort */ }
                        }
                        m.status = "errored"
                    }
                }
                team.status = prevStatus
                team.activeTask = undefined
                await saveTeamState(team)
                throw err
            }
        })
    } finally {
        // Only clear the spawning flag if we still own the lease. Perform
        // the check+clear INSIDE the mutex so a concurrent Phase 1
        // acquiring the lifecycle lock sees the correct on-disk state.
        // Keeping the operation inside the mutex prevents a concurrent startup
        // from observing stale spawning state on disk.
        await team.mutex.runExclusive(async () => {
            if (team.spawningOwner === spawnOwner) {
                team.spawning = false
                team.spawningOwner = undefined
                try { await saveTeamState(team) } catch { /* best-effort */ }
            }
        })
    }
    if (raced) return "Error: team already has an active orchestration"
    if (buildError) return buildError

    // Step 7: success.
    return successMessage()
}

/**
 * Shared validation and utility helpers for all team tools (lifecycle +
 * workflow). Mostly pure validators; the two exceptions (abortAndResetMembers
 * and its session.abort call, and member-state resets) are clearly marked at
 * their definitions.
 *
 * Orchestration startup logic (startOrchestration, baseTaskFields, schema
 * fields, etc.) lives in orchestration/lifecycle/startup.ts so that tools importing these
 * validators do NOT transitively pull in the dispatch/worktree subsystem.
 */

import type { PluginContext } from "../core/context.js"
import type { MemberState } from "../core/types.js"
import type {
    Bounds,
    SignoffPolicy
} from "../core/types.js"
import { logSwallowed } from "../core/log.js"
import {
    OCTEAM_AGENTS,
    isOCTeamAgent
} from "../core/role.js"
import type { Team } from "../state/store.js"
import {
    MEMBER_NAME_POOL,
    RESERVED_NAMES
} from "../state/naming.js"

/** Resource bounds with design defaults, overridden by user input. */
export function defaultBounds(override?: Partial<Bounds>): Bounds {
    return {
        maxMembers: 12,
        maxParallelMembers: 4,
        maxMessagesPerRun: 100,
        maxWallClockMinutes: 30,
        maxMemberTurns: 50,
        maxTasks: 200,
        messagePayloadMaxBytes: 32 * 1024,
        messageUnreadMaxBytes: 1024 * 1024,
        ...override,
    }
}

/**
 * Assert that `name` is a non-master member of `team` (the master
 * pseudo-member is rejected). Returns a ready-to-return Error string when
 * the name does not match any member, or null when it is valid.
 * `label` identifies the offending field in the message (e.g.
 * "signoff_decider", "decomposer"). The stable message format supports existing
 * error-string assertions.
 */
export function assertMember(team: Team, name: string, label: string): string | null {
    if (!team.members.some(m => m.name === name && !m.isMaster)) {
        return `Error: ${label} "${name}" is not a member of team "${team.teamName}"`
    }
    return null
}

/** Return all non-master members of a team (workers only). */
export function nonMasterMembers(team: Team): MemberState[] {
    return team.members.filter(m => !m.isMaster)
}

/** Find a non-master member by name. Returns undefined if not found or is the master. */
export function findMember(team: Team, name: string): MemberState | undefined {
    return team.members.find(m => m.name === name && !m.isMaster)
}

/**
 * Abort every running non-master member session and reset the successfully
 * aborted (and idle) non-master members to a clean idle state (clears
 * declaredDone / retryingSince); members whose session.abort failed are left
 * in "errored" with their error recorded. Shared by team_cancel and
 * team_delete during busy-team teardown. Best-effort on abort: a failed abort
 * must not block cancel/delete. Caller MUST already hold team.mutex.
 */
export async function abortAndResetMembers(
    ctx: PluginContext,
    team: Team,
): Promise<Array<{ member: string; aborted: boolean }>> {
    // Abort running member turns (best-effort).
    // Track abort failures so affected members are marked errored instead of being
    // reset to idle while their sessions may still be running.
    const abortFailed = new Set<string>()
    const abortResults: Array<{ member: string; aborted: boolean }> = []
    for (const m of team.members) {
        if (
            !m.isMaster
            && m.sessionId
            && (m.status === "running" || m.status === "errored" || m.retryingSince !== undefined)
        ) {
            try {
                await ctx.client.session.abort({
                    path: { id: m.sessionId },
                    query: { directory: m.worktreePath ?? ctx.directory },
                })
                abortResults.push({ member: m.name, aborted: true })
            } catch (err) {
                // best-effort: a failed abort must not block teardown
                logSwallowed(ctx, "session.abort failed during teardown", err, { member: m.name, session: m.sessionId })
                abortFailed.add(m.name)
                abortResults.push({ member: m.name, aborted: false })
            }
        }
    }
    // Reset every non-master member to a clean idle state.
    for (const m of team.members) {
        if (m.isMaster) continue
        // Members whose abort failed are marked errored; all others return to idle.
        if (abortFailed.has(m.name)) {
            m.status = "errored"
        } else {
            m.status = "idle"
        }
        m.declaredDone = false
        m.retryingSince = undefined
    }
    return abortResults
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
    if (RESERVED_NAMES.includes(name as (typeof RESERVED_NAMES)[number])) {
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
        return (
            `Error: agent "${agent}" is not a hardened oct-* agent. ` +
            `Members must run as one of: ${OCTEAM_AGENTS.join(", ")}. ` +
            `Omit 'agent' to derive it from the role.`
        )
    }
    return null
}

/**
 * Validate the signoff_policy 'decider' field: requires signoff_decider to be
 * present and name a real team member. Shared by every tool that exposes
 * signoff (all except consensus, loop, quorum, and arena). Returns an error
 * string or null.
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

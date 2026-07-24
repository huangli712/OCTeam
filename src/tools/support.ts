/**
 * Shared validation and utility helpers for all team tools (lifecycle +
 * workflow). Pure functions only — no dispatch/worktree dependencies.
 *
 * Orchestration startup logic (startOrchestration, baseTaskFields, schema
 * fields, etc.) lives in orchestration/lifecycle/startup.ts so that tools importing these
 * validators do NOT transitively pull in the dispatch/worktree subsystem.
 */

import type { PluginContext } from "../core/context.js"
import { OCTEAM_AGENTS, isOCTeamAgent } from "../core/role.js"
import type { Team } from "../state/store.js"
import { MEMBER_NAME_POOL } from "../state/naming.js"
import type { MemberState } from "../core/types.js"
import type { Bounds, SignoffPolicy } from "../core/types.js"

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
 * Assert that `name` is a member of `team`. Returns a ready-to-return Error
 * string when the name does not match any member, or null when it is valid.
 * `label` identifies the offending field in the message (e.g.
 * "signoff_decider", "decomposer"). The message format is kept identical to the
 * previous inline checks so existing error-string assertions still hold.
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

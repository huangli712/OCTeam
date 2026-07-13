/**
 * Session index + member resolution. In-memory process-level bookkeeping that
 * coordinates with on-disk team state (store.ts). Lives in the state layer:
 * reads team state via store.ts and provides O(1) sessionID -> member
 * resolution. The index manipulation functions are pure Map bookkeeping but
 * are co-located here because the resolve/rebuild functions read/write the
 * same private Maps.
 */

import { listAllTeams, loadTeamState } from "./store.js"
import type { MemberState } from "../core/types.js"
import type { PluginContext } from "../core/context.js"
import { logSwallowed } from "../core/log.js"
import { isInteractionForbidden } from "./activation.js"

const memberIndex = new Map<string, MemberIndexEntry>()
const masterIndex = new Map<string, MasterIndexEntry>()

// --- sessionID -> team index (process-level, O(1) resolve) ---
//
// Two maps by role. A member session belongs to exactly one team (1:1), so the
// member index keeps its original shape. A master (leader) session may own
// MULTIPLE teams (1:many) but interacts with at most one "active" team at a
// time, so the master index holds a per-team map plus an active pointer.

type MemberIndexEntry = {
    teamName: string
    memberName: string
    leadSessionId?: string
    storageRoot: string
}

type MasterTeamEntry = {
    teamName: string
    leadSessionId?: string
    storageRoot: string
    directory: string                  // resolved teamDir (absolute) — unique key
}

type MasterIndexEntry = {
    teams: Map<string, MasterTeamEntry> // keyed by directory
    activeDirectory?: string            // the ONE available team; undefined ⇒ none active
}

/** Index a member session by its sessionID, mapping it to a specific team. */
export function indexMember(
    sessionID: string,
    teamName: string,
    memberName: string,
    leadSessionId: string | undefined,
    storageRoot: string,
): void {
    memberIndex.set(sessionID, { teamName, memberName, leadSessionId, storageRoot })
}

/**
 * Add a team to a master session's team map. Does NOT change the active pointer.
 * Replaces the old 1:1 indexMaster — adding a second team no longer overwrites
 * the first (which previously orphaned its result delivery).
 */
export function indexMasterTeam(
    sessionID: string,
    teamName: string,
    leadSessionId: string | undefined,
    storageRoot: string,
    directory: string,
): void {
    let entry = masterIndex.get(sessionID)
    if (!entry) {
        entry = { teams: new Map() }
        masterIndex.set(sessionID, entry)
    }
    entry.teams.set(directory, { teamName, leadSessionId, storageRoot, directory })
}

/** Mark `directory` as the master session's active (available) team. */
export function setActiveTeam(sessionID: string, directory: string): void {
    const entry = masterIndex.get(sessionID)
    if (entry) entry.activeDirectory = directory
}

/** Clear the master session's active pointer (no team available). */
export function clearActiveTeam(sessionID: string): void {
    const entry = masterIndex.get(sessionID)
    if (entry) entry.activeDirectory = undefined
}

/**
 * Remove ONE team from a master session's map (team_delete). Clears the active
 * pointer if it referenced the removed team. Drops the whole master entry once
 * its team map empties. This is what team_delete must call instead of
 * unindexSession, which would wipe EVERY team the session owns.
 */
export function unindexMasterTeam(sessionID: string, directory: string): void {
    const entry = masterIndex.get(sessionID)
    if (!entry) return
    entry.teams.delete(directory)
    if (entry.activeDirectory === directory) entry.activeDirectory = undefined
    if (entry.teams.size === 0) masterIndex.delete(sessionID)
}

/**
 * Remove a session from BOTH indexes entirely. Used on session.deleted (full
 * teardown of a leader or bare member session).
 */
export function unindexSession(sessionID: string): void {
    memberIndex.delete(sessionID)
    masterIndex.delete(sessionID)
}

/** True if this session owns at least one team as master. */
export function isMasterSession(sessionID: string): boolean {
    return masterIndex.has(sessionID)
}

/** Enumerate every team a master session owns (drain-all enumeration). */
export function resolveMasterTeams(sessionID: string): MasterTeamEntry[] {
    const entry = masterIndex.get(sessionID)
    return entry ? Array.from(entry.teams.values()) : []
}

/**
 * True if this session is already indexed as a (non-master) team member. Used by
 * team_create to refuse a member (child) session from spawning its own team —
 * which would overwrite its index entry (orphaning its original team) and let it
 * escalate to master of a new team.
 */
export function isIndexedMember(sessionID: string): boolean {
    return memberIndex.has(sessionID)
}

/** A team member resolved from a sessionID, plus the team context it belongs to. */
export type ResolvedMember = MemberState & {
    teamName: string
    teamRunId: string
    directory: string
    leadSessionId?: string
    /** Storage root this team lives under (project or user scope). */
    storageRoot: string
}

/** Build the synthetic master pseudo-member for a resolved team. */
function syntheticMaster(team: {
    teamName: string
    teamRunId: string
    directory: string
}, leadSessionId: string | undefined, storageRoot: string): ResolvedMember {
    return {
        name: "master",
        isMaster: true,
        status: "idle",
        initialized: true,
        turnCount: 0,
        teamName: team.teamName,
        teamRunId: team.teamRunId,
        directory: team.directory,
        leadSessionId,
        storageRoot,
    }
}

/**
 * Resolve the member-path (1:1) of a sessionID into a ResolvedMember. Returns
 * null when the session is not indexed as a member, or when its on-disk team
 * no longer lists the member. Shared by resolveTeamMember and
 * resolveCallerInTeam so the member resolution lives in exactly one place.
 * Resolves against the scope captured at index time (the LEADER's session
 * segment), NOT the caller's storageRoot.
 */
async function resolveMemberFromIndex(sessionID: string): Promise<ResolvedMember | null> {
    const m = memberIndex.get(sessionID)
    if (!m) return null
    const team = await loadTeamState(m.storageRoot, m.teamName, m.leadSessionId)
    const member = team.members.find(x => x.name === m.memberName)
    return member
        ? {
              ...member,
              teamName: team.teamName,
              teamRunId: team.teamRunId,
              directory: team.directory,
              leadSessionId: m.leadSessionId,
              storageRoot: m.storageRoot,
          }
        : null
}

/**
 * Resolve a sessionID to its team member. Returns null for non-team sessions
 * (the common case — O(1) reject). For a member session, resolves its single
 * team. For a master (leader) session that owns multiple teams, resolves the
 * synthetic master of the ACTIVE team only (or null if none is active) — the
 * synthetic master never participates in orchestration dispatch; it only lets
 * the active team's master mailbox be drained like any other recipient.
 */
export async function resolveTeamMember(
    _storageRoot: string,
    sessionID: string,
): Promise<ResolvedMember | null> {
    // Member path (1:1) — resolution lives in the shared helper.
    const member = await resolveMemberFromIndex(sessionID)
    if (member) return member
    if (memberIndex.has(sessionID)) return null
    // Master path (1:many) — resolve the ACTIVE team only.
    const master = masterIndex.get(sessionID)
    if (!master || !master.activeDirectory) return null
    const entry = master.teams.get(master.activeDirectory)
    if (!entry) return null
    const team = await loadTeamState(entry.storageRoot, entry.teamName, entry.leadSessionId)
    return syntheticMaster(team, entry.leadSessionId, entry.storageRoot)
}

/**
 * Authorization gate for team-scoped tools. Resolves the caller's session and
 * returns it ONLY when the caller belongs to `teamId`. Returns null when the
 * caller is not a team member at all OR belongs to a different team — callers
 * turn null into an "unauthorized" error. This prevents a member of team A from
 * mutating team B's state.
 *
 * For a master, the team is found by explicit `teamId` across ALL owned teams
 * (not via the active pointer). When `opts.requireActive` is true (default),
 * a master interacting with an inactive team is rejected (null) — the
 * single-active interaction gate. Read-only tools pass `requireActive: false`.
 */
export async function resolveCallerInTeam(
    _storageRoot: string,
    sessionID: string,
    teamId: string | undefined,
    opts: { requireActive?: boolean } = {},
): Promise<ResolvedMember | null> {
    const requireActive = opts.requireActive ?? true
    // Member path (1:1) — activation never gates members.
    const m = memberIndex.get(sessionID)
    if (m) {
        // Fallback: a member session is bound 1:1 to exactly one team, so when
        // the caller omits team_id (a common model mistake — the agent does
        // not always know its own team name), resolve to the indexed team
        // instead of failing with a misleading "caller is not a member"
        // error. Master sessions are NOT given this fallback (1:many, ambiguous).
        const effectiveTeamId = (!teamId || teamId === "") ? m.teamName : teamId
        if (m.teamName !== effectiveTeamId) return null
        return resolveMemberFromIndex(sessionID)
    }
    // Master path (1:many) — find the team by explicit teamId.
    const master = masterIndex.get(sessionID)
    if (!master) return null
    const entry = Array.from(master.teams.values()).find(t => t.teamName === teamId)
    if (!entry) return null
    const team = await loadTeamState(entry.storageRoot, entry.teamName, entry.leadSessionId)
    if (requireActive && isInteractionForbidden(true, team.activatedAt)) return null
    return syntheticMaster(team, entry.leadSessionId, entry.storageRoot)
}

/**
 * Rebuild the session index from disk on plugin startup. Scans every team's
 * state.json once (NOT per-turn) and indexes each member session and the
 * leader session. Call from server() init.
 */
export async function rebuildSessionIndex(
    projectStorageRoot: string,
    userStorageRoot: string,
    ctx?: PluginContext,
): Promise<void> {
    // Project scope is segmented (<root>/<sid>/teams); user scope is flat (<root>/teams).
    await indexScope(projectStorageRoot, true, ctx)
    await indexScope(userStorageRoot, false, ctx)
}

/** Index every team in one scope. Shared by the project + user passes above. */
async function indexScope(storageRoot: string, segmented: boolean, ctx?: PluginContext): Promise<void> {
    const teams = await listAllTeams(storageRoot, segmented)
    for (const { leadSessionId, teamName } of teams) {
        try {
            const team = await loadTeamState(storageRoot, teamName, leadSessionId)
            indexMasterTeam(team.leadSessionId, team.teamName, leadSessionId, storageRoot, team.directory)
            // Restart invariant: never auto-activate. The active pointer is NOT
            // restored from persisted activatedAt — reconcileActivation clears
            // all on-disk activatedAt, and the user must team_activate explicitly.
            for (const m of team.members) {
                if (m.sessionId) {
                    indexMember(m.sessionId, team.teamName, m.name, leadSessionId, storageRoot)
                }
            }
        } catch (err) {
            if (ctx) logSwallowed(ctx, "indexScope skipped unreadable state", err, { dir: teamName })
        }
    }
}

/**
 * Session index + member resolution. In-memory process-level bookkeeping that
 * coordinates with on-disk team state (store.ts). Lives in the state layer:
 * reads team state via store.ts and provides O(1) sessionID -> member
 * resolution. The index manipulation functions are pure Map bookkeeping but
 * are co-located here because the resolve/rebuild functions read/write the
 * same private Maps.
 */

import { isEnoent } from "../core/utils.js"
import { listAllTeams, loadTeamState } from "./store.js"
import { masterSentinelPath } from "./paths.js"
import { safeReadFile } from "./locks.js"
import type { MemberState } from "../core/types.js"
import type { PluginContext } from "../core/context.js"
import { logSwallowed, logger } from "../core/log.js"
import { isInteractionForbidden } from "./activation.js"

/** Map of sessionID -> member index entry for non-master team members. */
const memberIndex = new Map<string, MemberIndexEntry>()

/** Map of sessionID -> master index entry for team leader sessions. */
const masterIndex = new Map<string, MasterIndexEntry>()

// --- sessionID -> team index (process-level, O(1) resolve) ---
//
// Two maps by role. A member session belongs to exactly one team (1:1), so the
// member index keeps its original shape. A master (leader) session may own
// MULTIPLE teams (1:many) but interacts with at most one "active" team at a
// time, so the master index holds a per-team map plus an active pointer.

/** A team member indexed by sessionID. */
type MemberIndexEntry = {
    teamName: string
    memberName: string
    leadSessionId?: string
    storageRoot: string
}

/** One team within a master session's team map. */
type MasterTeamEntry = {
    teamName: string
    leadSessionId?: string
    storageRoot: string
    directory: string                  // resolved teamDir (absolute) — unique key
}

/** A master session's team map and active team pointer. */
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
 * Adding another team preserves existing entries and their result-delivery
 * routing.
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

/**
 * Verify that `sessionID` is the master of the team identified by `directory`,
 * using the in-memory index built at startup as an independent trust source.
 * Returns true ONLY when the session is registered in masterIndex as
 * owning a team at exactly this directory. Disk-tampered state.json cannot
 * grant master privileges because the index is built once from trusted
 * startup state and is not re-read from disk on each call.
 *
 * Returns false when the session is not a master at all or owns a different
 * directory. Tools that already compare team.leadSessionId against
 * context.sessionID should ALSO call this to defend against disk tampering.
 */
export function isIndexedMasterOf(
    sessionID: string,
    directory: string,
): boolean {
    const entry = masterIndex.get(sessionID)
    if (!entry) return false
    return entry.teams.has(directory)
}

/** Enumerate every team a master session owns (drain-all enumeration). */
export function resolveMasterTeams(sessionID: string): MasterTeamEntry[] {
    const entry = masterIndex.get(sessionID)
    return entry ? Array.from(entry.teams.values()) : []
}

/**
 * Resolve the trusted (index-verified) leadSessionId for a team at
 * `directory`. Returns undefined when no master session is registered as
 * owning that directory. Use this in delivery paths (finishRun) instead of
 * the disk-tamperable `team.leadSessionId` so a state.json swap cannot
 * redirect sensitive run output to an attacker-controlled session.
 */
export function trustedLeadSessionId(directory: string): string | undefined {
    // Return only a sessionID map key validated against master.sentinel at
    // startup. An empty sessionID marks failed sentinel validation, so fail
    // closed instead of returning the disk-derived leadSessionId.
    for (const [sessionID, entry] of masterIndex) {
        if (sessionID === "") continue  // skip unverified entries
        const team = entry.teams.get(directory)
        if (team) return sessionID
    }
    return undefined
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
    // Propagate loadTeamState errors so the caller's try/catch can log them.
    // Returning null here would make a corrupted-state indexed member look like
    // a non-member, silently swallowing the error instead of logging it.
    const team = await loadTeamState(m.storageRoot, m.teamName, m.leadSessionId)
    const member = team.members.find(x => x.name === m.memberName)
    if (!member) return null
    // Verify 1:1 identity binding. The member's on-disk sessionId must strictly
    // match the lookup key. An undefined sessionId means the member has no
    // active session, so no sessionID may resolve to that member.
    if (member.sessionId !== sessionID) {
        logger.warn("resolveMemberFromIndex: sessionID mismatch (stale index entry)", {
            indexedSessionID: sessionID,
            diskSessionId: member.sessionId,
            teamName: m.teamName,
            memberName: m.memberName,
        })
        return null
    }
    return {
        ...member,
        teamName: team.teamName,
        teamRunId: team.teamRunId,
        directory: team.directory,
        leadSessionId: m.leadSessionId,
        storageRoot: m.storageRoot,
    }
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
    let team
    try {
        team = await loadTeamState(entry.storageRoot, entry.teamName, entry.leadSessionId)
    } catch (err) {
        logger.warn("resolveTeamMember: failed to load team state for active master", {
            team: entry.teamName, error: err instanceof Error ? err.message : String(err),
        })
        return null
    }
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
    storageRoot: string,
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
    // Use scope-aware disambiguation. When multiple teams share the
    // same teamName across different scopes, prefer the one matching the
    // caller's storageRoot. When only one team matches by name, use it
    // regardless of scope (the index already knows its correct storageRoot).
    // A unique name match is unambiguous regardless of caller scope, while
    // multiple matches require an exact storageRoot match.
    const nameMatches = Array.from(master.teams.values()).filter(t => t.teamName === teamId)
    if (nameMatches.length === 0) return null
    const entry = nameMatches.length === 1
        ? nameMatches[0]
        : nameMatches.find(t => t.storageRoot === storageRoot)
    if (!entry) {
        // Multiple teams share this name across scopes and none match the
        // caller's storageRoot. Fail closed so the caller gets a clear
        // "ambiguous team" error instead of operating on the wrong team.
        logger.warn("resolveCallerInTeam: ambiguous team name across scopes; no storageRoot match", {
            teamId, storageRoot, matches: nameMatches.map(m => m.storageRoot),
        })
        return null
    }
    let team
    try {
        team = await loadTeamState(entry.storageRoot, entry.teamName, entry.leadSessionId)
    } catch (err) {
        logger.warn("resolveCallerInTeam: failed to load team state for master caller", {
            team: entry.teamName, error: err instanceof Error ? err.message : String(err),
        })
        return null
    }
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
    const failures = [
        ...await indexScope(projectStorageRoot, true, ctx),
        ...await indexScope(userStorageRoot, false, ctx),
    ]
    if (failures.length > 0) {
        throw new AggregateError(failures, `rebuildSessionIndex failed for ${failures.length} team or scope operation(s)`)
    }
}

/** Index every team in one scope. Shared by the project + user passes above. */
async function indexScope(storageRoot: string, segmented: boolean, ctx?: PluginContext): Promise<unknown[]> {
    const failures: unknown[] = []
    let teams: Awaited<ReturnType<typeof listAllTeams>>
    try {
        teams = await listAllTeams(storageRoot, segmented)
    } catch (err) {
        if (ctx) logSwallowed(ctx, "indexScope failed to list teams", err, { storageRoot })
        failures.push(err)
        return failures
    }
    for (const { leadSessionId, teamName } of teams) {
        try {
            const team = await loadTeamState(storageRoot, teamName, leadSessionId)
            // For project scope (segmented), the authoritative owner is the
            // directory-derived `leadSessionId`
            // (enumerated by listAllTeams from the filesystem layout
            // <root>/<sid>/teams/<team>). The disk-persisted
            // team.leadSessionId must not be trusted here because a member with
            // .octeam/ write access could set it to their own session and gain
            // master privilege on the next rebuild.
            //
            // For user scope (segmented=false), read the master.sentinel
            // file (written once at team_create, read-only) instead of the
            // mutable state.json.leadSessionId. A missing sentinel falls back
            // to state.json with a warning, while a mismatch refuses master
            // privilege. The separate read-only file makes tampering observable.
            let trustedLeadSessionId: string | undefined
            // Project scope also verifies the sentinel because it stores auth
            // state in member-writable .octeam/, so a member could forge a
            // <sid>/teams/...
            // directory to gain master privilege. Requiring the sentinel
            // raises the bar because the attacker must also forge master.sentinel.
            // A sentinel mismatch always refuses master; a missing sentinel
            // (ENOENT) falls back to the directory-derived value and logs a
            // prominent warning.
            try {
                const sentinelPath = masterSentinelPath(team.directory)
                const sentinelContent = await safeReadFile(team.directory, sentinelPath, { maxBytes: 1024 })
                if (sentinelContent === undefined) {
                    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
                }
                const sentinelLead = sentinelContent.trim()
                const expectedLead = segmented ? leadSessionId : team.leadSessionId
                if (sentinelLead && sentinelLead === expectedLead) {
                    trustedLeadSessionId = sentinelLead
                } else {
                    if (ctx) logSwallowed(ctx, `indexScope: ${segmented ? "project" : "user"}-scope master.sentinel mismatches; refusing master privilege`, undefined, {
                        teamName, sentinelLead, expectedLead,
                    })
                    // Do NOT grant master — leave trustedLeadSessionId undefined.
                }
            } catch (sentinelErr) {
                if (isEnoent(sentinelErr)) {
                    if (ctx) logSwallowed(ctx, `indexScope: ${segmented ? "project" : "user"}-scope team has no master.sentinel; using ${segmented ? "directory" : "state.json"} value (less secure)`, sentinelErr, { teamName })
                    trustedLeadSessionId = segmented ? leadSessionId : team.leadSessionId
                } else {
                    if (ctx) logSwallowed(ctx, `indexScope: ${segmented ? "project" : "user"}-scope master.sentinel unreadable; refusing master privilege (fail-closed)`, sentinelErr, { teamName })
                    // trustedLeadSessionId stays undefined
                }
            }
            if (ctx && segmented && team.leadSessionId !== leadSessionId) {
                logSwallowed(ctx, "indexScope: disk leadSessionId mismatches directory layout; using directory value", undefined, {
                    teamName, diskLeadSessionId: team.leadSessionId, dirLeadSessionId: leadSessionId,
                })
            }
            indexMasterTeam(trustedLeadSessionId ?? "", team.teamName, leadSessionId, storageRoot, team.directory)
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
            failures.push(err)
        }
    }
    return failures
}

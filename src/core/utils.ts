/**
 * Shared helpers: session index + member resolution, text/token utilities,
 * polling primitives, and the role-setup prompt builder.
 */

import { listAllTeams, loadTeamState } from "../state/store.js"
import { rolePreset } from "./role-presets.js"
import type { MemberState, MemberSpec, TeamSpec } from "./types.js"

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

const memberIndex = new Map<string, MemberIndexEntry>()
const masterIndex = new Map<string, MasterIndexEntry>()

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

/**
 * Master-only activation gate (pure predicate). Members always pass — a member's
 * team is necessarily active while it is busy (busy ⟹ active), so the gate would
 * never legitimately block a member. A master may only interact with its active
 * team, so an inactive target (activatedAt === undefined) is forbidden.
 */
export function isInteractionForbidden(
    callerIsMaster: boolean,
    targetTeamActivatedAt: number | undefined,
): boolean {
    if (!callerIsMaster) return false
    return targetTeamActivatedAt === undefined
}

/**
 * Actionable error string for a master interacting with an inactive team, or
 * null when the team is active. Centralizes the message used by master-only
 * mutating tools (workflow / team_fix).
 */
export function activationError(
    teamName: string,
    activatedAt: number | undefined,
): string | null {
    return activatedAt === undefined
        ? `Error: team "${teamName}" is not the active team. Call team_activate(team_id="${teamName}") first.`
        : null
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
 * Resolve a sessionID to its team member. Returns null for non-team sessions
 * (the common case — O(1) reject). For a member session, resolves its single
 * team. For a master (leader) session that owns multiple teams, resolves the
 * synthetic master of the ACTIVE team only (or null if none is active) — the
 * synthetic master never participates in orchestration dispatch; it only lets
 * the active team's master mailbox be drained like any other recipient.
 */
export async function resolveTeamMember(
    storageRoot: string,
    sessionID: string,
): Promise<ResolvedMember | null> {
    // Member path (1:1). Resolve against the scope captured at index time, NOT
    // the caller's storageRoot — a project-team member is indexed under its
    // LEADER's session segment.
    const m = memberIndex.get(sessionID)
    if (m) {
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
    storageRoot: string,
    sessionID: string,
    teamId: string,
    opts: { requireActive?: boolean } = {},
): Promise<ResolvedMember | null> {
    const requireActive = opts.requireActive ?? true
    // Member path (1:1) — activation never gates members.
    const m = memberIndex.get(sessionID)
    if (m) {
        if (m.teamName !== teamId) return null
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
): Promise<void> {
    // Project scope is segmented (<root>/<sid>/teams); user scope is flat (<root>/teams).
    await indexScope(projectStorageRoot, true)
    await indexScope(userStorageRoot, false)
}

/** Index every team in one scope. Shared by the project + user passes above. */
async function indexScope(storageRoot: string, segmented: boolean): Promise<void> {
    const teams = await listAllTeams(storageRoot, segmented)
    for (const { leadSessionId, teamName } of teams) {
        try {
            const team = await loadTeamState(storageRoot, teamName, leadSessionId)
            indexMasterTeam(team.leadSessionId, team.teamName, leadSessionId, storageRoot, team.directory)
            // Restore the active pointer from the persisted flag. If >1 team has
            // activatedAt (crash mid-switch), this overwrites — reconcileActivation
            // (run after rebuild) keeps only the latest on disk.
            if (team.activatedAt !== undefined) {
                setActiveTeam(team.leadSessionId, team.directory)
            }
            for (const m of team.members) {
                if (m.sessionId) {
                    indexMember(m.sessionId, team.teamName, m.name, leadSessionId, storageRoot)
                }
            }
        } catch {
            // unreadable team state — skip
        }
    }
}

// --- text / token helpers ---

/** Extract concatenated text from message parts (filters type === "text"). */
export function extractTextFromParts(parts: unknown): string {
    if (!Array.isArray(parts)) return ""
    return parts
        .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n")
}

/** Tools whose invocations represent member work product (code, commands).
 * Excludes team-* coordination tools (send_message, task_*, workflow tools). */
const WORK_TOOLS = new Set([
    "write", "edit", "bash",
    "aft_write", "aft_edit", "aft_bash", "aft_apply_patch",
])

/**
 * Extract member output from an assistant message's parts: text + work-tool
 * invocations (write/edit content, bash commands, patches). Excludes team-*
 * tools (coordination, not deliverables) so that summaries reflect actual
 * work product rather than just conversation text.
 */
export function extractOutputFromParts(parts: unknown): string {
    if (!Array.isArray(parts)) return ""
    const segments: string[] = []
    for (const p of parts as any[]) {
        if (!p) continue
        if (p.type === "text" && typeof p.text === "string") {
            if (p.text.trim()) segments.push(p.text)
        } else if (p.type === "tool_use" && WORK_TOOLS.has(p.name)) {
            const input = p.input ?? {}
            if (typeof input.content === "string" && input.content.trim()) {
                const fp = typeof input.filePath === "string" ? input.filePath : ""
                segments.push(fp ? `[File: ${fp}]\n${input.content}` : input.content)
            } else if (typeof input.command === "string" && input.command.trim()) {
                segments.push(`$ ${input.command}`)
            } else if (typeof input.patchText === "string" && input.patchText.trim()) {
                segments.push(`[Patch]\n${input.patchText}`)
            }
        }
    }
    return segments.join("\n\n")
}

/** Truncate output to maxBytes (default 8KB) to prevent context-window blowups. */
export function truncateOutput(text: string, maxBytes: number = 8192): string {
    if (text.length <= maxBytes) return text
    return text.slice(0, maxBytes) + "\n…[truncated]"
}

/**
 * Sum a single session's assistant-message tokens (input+output+reasoning),
 * recomputed from full history. cache.read/write are intentionally NOT counted
 * (cached reads are typically discounted by providers). Recompute-per-idle
 * semantics — never incrementally += — to avoid double counting.
 */
export function sumMemberTokens(messages: Array<{ info?: any }> | undefined): number {
    let total = 0
    for (const m of messages ?? []) {
        if (m.info?.role !== "assistant") continue
        const t = m.info.tokens
        if (!t) continue
        total += (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0)
    }
    return total
}

// --- polling primitive ---

/** Resolve when predicate is true; reject on timeout. Polls every pollMs. */
export function waitUntil(
    predicate: () => boolean,
    opts: { timeoutMs: number; pollMs?: number },
): Promise<void> {
    const pollMs = opts.pollMs ?? 250
    return new Promise<void>((resolve, reject) => {
        const start = Date.now()
        const tick = () => {
            try {
                if (predicate()) {
                    resolve()
                    return
                }
            } catch (err) {
                reject(err)
                return
            }
            if (Date.now() - start >= opts.timeoutMs) {
                reject(new Error(`waitUntil: timed out after ${opts.timeoutMs}ms`))
                return
            }
            setTimeout(tick, pollMs)
        }
        tick()
    })
}

/** Split an array into batches of size n. */
export function chunk<T>(arr: T[], n: number): T[][] {
    if (n <= 0) return [arr]
    const out: T[][] = []
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
    return out
}

/**
 * Build the role-setup prompt sent to a freshly spawned member session. The
 * role label and the member's instructions (prompt) come from the MemberSpec
 * (config.json), since MemberState does not persist them.
 */
export function buildRolePrompt(
    spec: MemberSpec,
    teamName: string,
    peerNames: string[],
): string {
    const peers = peerNames.filter(n => n !== spec.name)
    const lines: string[] = [
        `[Team Orchestrator] You are now a member of team "${teamName}".`,
        "",
        `Your name: ${spec.name}`,
        `Your role: ${spec.role}`,
    ]
    if (spec.model) lines.push(`Your model: ${spec.model}`)
    if (peers.length > 0) lines.push(`Your teammates: ${peers.join(", ")}`)
    // Preset role guidance (by role label), injected before the user's task
    // instruction. Roles without a preset get no role-instruction block.
    const preset = rolePreset(spec.role)
    if (preset) {
        lines.push("", "<role-instruction>", preset, "</role-instruction>")
    }
    if (spec.prompt) {
        lines.push("", "<user-instruction>", spec.prompt, "</user-instruction>")
    }
    lines.push(
        "",
        "You collaborate via the team tools available to you:",
        "- team_send_message: send a message to a teammate (point-to-point).",
        "- team_task_create / team_task_list / team_task_update / team_task_get: coordinate shared work.",
        "Messages from teammates and the orchestrator are injected automatically each turn — you do not need to read them manually.",
        "",
        "When you have no work, you will idle and be re-prompted when needed. Acknowledge your role in one sentence, then stop.",
    )
    return lines.join("\n")
}

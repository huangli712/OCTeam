/**
 * Shared helpers: session index + member resolution, text/token utilities,
 * polling primitives, and the role-setup prompt builder.
 */

import { listAllTeams, loadTeamState } from "./state/store.js"
import type { RuntimeMember, TeamMemberSpec, TeamSpec } from "./types.js"

// --- sessionID -> member index (process-level, O(1) resolve) ---

type IndexEntry =
    | {
          teamName: string
          memberName: string
          isMaster?: false
          leadSessionId?: string
          storageRoot: string
      }
    | {
          teamName: string
          isMaster: true
          leadSessionId?: string
          storageRoot: string
      }

const sessionIndex = new Map<string, IndexEntry>()

export function indexMember(
    sessionID: string,
    teamName: string,
    memberName: string,
    leadSessionId: string | undefined,
    storageRoot: string,
): void {
    sessionIndex.set(sessionID, { teamName, memberName, leadSessionId, storageRoot })
}

export function indexMaster(
    sessionID: string,
    teamName: string,
    leadSessionId: string | undefined,
    storageRoot: string,
): void {
    sessionIndex.set(sessionID, { teamName, isMaster: true, leadSessionId, storageRoot })
}

export function unindexSession(sessionID: string): void {
    sessionIndex.delete(sessionID)
}

/**
 * True if this session is already indexed as a (non-master) team member. Used by
 * team_create to refuse a member (child) session from spawning its own team —
 * which would overwrite its index entry (orphaning its original team) and let it
 * escalate to master of a new team.
 */
export function isIndexedMember(sessionID: string): boolean {
    const hit = sessionIndex.get(sessionID)
    return hit !== undefined && hit.isMaster !== true
}

/** A team member resolved from a sessionID, plus the team context it belongs to. */
export type ResolvedMember = RuntimeMember & {
    teamName: string
    teamRunId: string
    directory: string
    leadSessionId?: string
    /** Storage root this team lives under (project or user scope). */
    storageRoot: string
}

/**
 * Resolve a sessionID to its team member. Returns null for non-team sessions
 * (the common case — O(1) reject via sessionIndex). For the leader session,
 * returns a synthetic master pseudo-member (B1 fix) that is never persisted and
 * never participates in orchestration dispatch — it only lets the master
 * mailbox be drained like any other recipient.
 */
export async function resolveTeamMember(
    storageRoot: string,
    sessionID: string,
): Promise<ResolvedMember | null> {
    const hit = sessionIndex.get(sessionID)
    if (!hit) return null
    // Resolve against the scope captured at index time (entry.storageRoot +
    // entry.leadSessionId), NOT the caller's storageRoot. A project-team member is
    // indexed under its LEADER's session segment, so it resolves to the leader's
    // team dir rather than anything scoped to the member's own session.
    const team = await loadTeamState(hit.storageRoot, hit.teamName, hit.leadSessionId)
    if (hit.isMaster) {
        return {
            name: "master",
            isMaster: true,
            status: "idle",
            initialized: true,
            turnCount: 0,
            teamName: team.teamName,
            teamRunId: team.teamRunId,
            directory: team.directory,
            leadSessionId: hit.leadSessionId,
            storageRoot: hit.storageRoot,
        }
    }
    const member = team.members.find(m => m.name === hit.memberName)
    return member
        ? {
              ...member,
              teamName: team.teamName,
              teamRunId: team.teamRunId,
              directory: team.directory,
              leadSessionId: hit.leadSessionId,
              storageRoot: hit.storageRoot,
          }
        : null
}

/**
 * Authorization gate for team-scoped tools. Resolves the caller's session to a
 * member (or synthetic master) and returns it ONLY when the caller belongs to
 * `teamId`. Returns null when the caller is not a team member at all OR belongs
 * to a different team — callers turn null into an "unauthorized" error. This is
 * what prevents a member of team A from mutating team B's state.
 */
export async function resolveCallerInTeam(
    storageRoot: string,
    sessionID: string,
    teamId: string,
): Promise<ResolvedMember | null> {
    const caller = await resolveTeamMember(storageRoot, sessionID)
    if (!caller || caller.teamName !== teamId) return null
    return caller
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
            indexMaster(team.leadSessionId, team.teamName, leadSessionId, storageRoot)
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
 * Build the role-setup prompt sent to a freshly spawned member session. Role
 * comes from the TeamMemberSpec (config.json), since RuntimeMember does not
 * persist the role field.
 */
export function buildRolePrompt(
    spec: TeamMemberSpec,
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

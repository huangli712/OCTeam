/**
 * Shared helpers: session index + member resolution, text/token utilities,
 * polling primitives, and the role-setup prompt builder.
 */

import { listTeamNames, loadTeamState } from "./state/store.js"
import type { RuntimeMember, TeamMemberSpec, TeamSpec } from "./types.js"

// --- sessionID -> member index (process-level, O(1) resolve) ---

type IndexEntry =
    | { teamName: string; memberName: string; isMaster?: false }
    | { teamName: string; isMaster: true }

const sessionIndex = new Map<string, IndexEntry>()

export function indexMember(sessionID: string, teamName: string, memberName: string): void {
    sessionIndex.set(sessionID, { teamName, memberName })
}

export function indexMaster(sessionID: string, teamName: string): void {
    sessionIndex.set(sessionID, { teamName, isMaster: true })
}

export function unindexSession(sessionID: string): void {
    sessionIndex.delete(sessionID)
}

/** A team member resolved from a sessionID, plus the team context it belongs to. */
export type ResolvedMember = RuntimeMember & {
    teamName: string
    teamRunId: string
    directory: string
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
    const team = await loadTeamState(storageRoot, hit.teamName)
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
        }
    }
    const member = team.members.find(m => m.name === hit.memberName)
    return member
        ? { ...member, teamName: team.teamName, teamRunId: team.teamRunId, directory: team.directory }
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
export async function rebuildSessionIndex(storageRoot: string): Promise<void> {
    const names = await listTeamNames(storageRoot)
    for (const name of names) {
        try {
            const team = await loadTeamState(storageRoot, name)
            indexMaster(team.leadSessionId, team.teamName)
            for (const m of team.members) {
                if (m.sessionId) indexMember(m.sessionId, team.teamName, m.name)
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

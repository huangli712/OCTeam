/**
 * Session tree data logic for Session Navigator.
 *
 * Fetches child sessions of the current session from the OpenCode host
 * and maps them to display-friendly nodes.
 */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { loadTeams } from "./teams.js"

/** Display status derived from OpenCode SessionStatus. */
export type DisplayStatus = "running" | "idle" | "errored"

/** A child session node for sidebar rendering. */
export type SessionTreeNode = {
    sessionId: string
    agentName: string
    duration: string
    startTime: string
    status: DisplayStatus
    childCount: number
}

/**
 * Map OpenCode's SessionStatus ({ type: "busy" | "idle" | "retry" })
 * to our display status.
 */
export function mapStatus(raw: { type: string } | undefined | null): DisplayStatus {
    if (!raw) return "idle"
    if (raw.type === "busy") return "running"
    if (raw.type === "retry") return "errored"
    return "idle"
}

/**
 * Minimal message shape consumed by the pure helpers below. The real API
 * returns richer Message objects; we only read these optional fields.
 */
type MessageRow = {
    info?: {
        agent?: string
        time?: { created?: number; completed?: number }
    }
}

/**
 * Extract agent name from message data.
 * Message API returns { info: { agent: "explore", ... } }.
 * Falls back to title parsing (@agent subagent) if no messages.
 */
export function extractAgentName(messages: MessageRow[], title: string): string {
    for (const msg of messages) {
        const agent = msg?.info?.agent
        if (agent) return agent
    }
    const match = title.match(/@([\w-]+)\s+subagent/)
    if (match) return match[1]
    return "task"
}

/**
 * Format a timestamp (ms) as MM/DD HH:MM.
 */
function formatTime(created: number | undefined): string {
    if (!created) return ""
    const date = new Date(created)
    const mo = (date.getMonth() + 1).toString().padStart(2, "0")
    const d = date.getDate().toString().padStart(2, "0")
    const h = date.getHours().toString().padStart(2, "0")
    const m = date.getMinutes().toString().padStart(2, "0")
    return `${mo}/${d} ${h}:${m}`
}

/**
 * Format milliseconds as compact duration string.
 */
export function formatMs(ms: number): string {
    if (ms < 0) return ""
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h${minutes % 60}m`
    const days = Math.floor(hours / 24)
    return `${days}d${hours % 24}h`
}

/**
 * Compute real work duration from message timestamps.
 * Message shape: { time: { created: number, completed?: number } }
 * - UserMessage.time has only created
 * - AssistantMessage.time has created + completed
 * Duration = last message time - first message time.
 */
export function computeDuration(messages: MessageRow[]): string {
    if (!messages || messages.length === 0) return ""
    const first = messages[0]?.info?.time?.created
    if (!first) return ""
    let last: number | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
        const t = messages[i]?.info?.time
        last = t?.completed ?? t?.created
        if (last) break
    }
    if (!last) return ""
    return formatMs(last - first)
}

/**
 * Load all direct child sessions of the given session.
 * Uses HTTP API for messages (api.client) — TUI state (api.state) only
 * has message data for sessions that have been viewed.
 *
 * opencode's `session.list()` scopes by directory: a call without
 * `query.directory` only returns sessions whose stored directory equals
 * the caller's CWD. Team members spawned with `worktree: true` have their
 * session.directory set to their worktree path (different from the lead's
 * CWD), so they are filtered out of the default listing. To make worktree
 * members visible in the Tasks panel, we additionally query each distinct
 * worktree directory that the current lead owns (read from team state.json)
 * and merge the results before applying the parentID filter.
 */
export async function loadChildren(
    api: Pick<TuiPluginApi, "client" | "state">,
    currentSessionId: string,
): Promise<SessionTreeNode[]> {
    const mainResult = await api.client.session.list()
    const allSessions = mainResult?.data ?? []

    // Merge in sessions from each worktree directory owned by a team whose
    // lead is the current session. Errors here are best-effort: a failed
    // directory lookup must not break the default listing.
    try {
        const teams = await loadTeams(currentSessionId)
        const worktreeDirs = new Set<string>()
        for (const t of teams) {
            for (const m of t.members) {
                if (m.worktreePath) worktreeDirs.add(m.worktreePath)
            }
        }
        if (worktreeDirs.size > 0) {
            const extras = await Promise.all(
                [...worktreeDirs].map(p =>
                    api.client.session.list({ directory: p })
                        .then(r => r?.data ?? [])
                        .catch(() => [] as typeof allSessions),
                ),
            )
            for (const list of extras) allSessions.push(...list)
        }
    } catch {
        // best effort — fall through with the default listing
    }

    const children = allSessions.filter(s => s.parentID === currentSessionId)

    const childCountByParent = new Map<string, number>()
    for (const s of allSessions) {
        const pid = s.parentID
        if (pid !== undefined) {
            childCountByParent.set(pid, (childCountByParent.get(pid) ?? 0) + 1)
        }
    }

    const nodes = await Promise.all(children.map(async s => {
        let duration = ""
        let messages: MessageRow[] = []
        try {
            const msgResult = await api.client.session.messages({ sessionID: s.id, limit: 100 })
            messages = msgResult?.data ?? []
            duration = computeDuration(messages)
        } catch {
            // best effort
        }
        return {
            sessionId: s.id,
            agentName: extractAgentName(messages, s.title || s.id),
            duration,
            startTime: formatTime(s.time?.created),
            created: s.time?.created ?? 0,
            status: mapStatus(api.state.session.status(s.id)),
            childCount: childCountByParent.get(s.id) ?? 0,
        }
    }))

    // Sort by creation time descending (newest first)
    nodes.sort((a, b) => b.created - a.created)
    return nodes
}

/**
 * Session tree data logic for Session Navigator.
 *
 * Fetches child sessions of the current session from the OpenCode host
 * and maps them to display-friendly nodes.
 */

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
 * Extract agent name from session title.
 * OpenCode subagent sessions have titles like "some task (@explore subagent)".
 * Must match @agent specifically before "subagent" to avoid matching
 * other @mentions in the title (e.g. "@opencode-ai/plugin").
 */
function extractAgentName(title: string): string {
    const match = title.match(/@(\w+)\s+subagent/)
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
function formatMs(ms: number): string {
    if (ms < 0) return ""
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    return `${hours}h${minutes % 60}m`
}

/**
 * Compute real work duration from message timestamps.
 * Message shape: { time: { created: number, completed?: number } }
 * - UserMessage.time has only created
 * - AssistantMessage.time has created + completed
 * Duration = last message time - first message time.
 */
function computeDuration(messages: any[]): string {
    if (!messages || messages.length === 0) return ""
    const first = messages[0]?.time?.created
    if (!first) return ""
    let last: number | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
        const t = messages[i]?.time
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
 */
export async function loadChildren(
    api: {
        client: {
            session: {
                list: (opts?: { query?: { directory?: string } }) => Promise<{ data?: Array<{ id: string; title?: string; parentID?: string; time?: { created?: number } }> }>
                messages: (params: { sessionID: string; limit?: number }) => Promise<{ data?: any[] }>
            }
        }
        state: { session: { status: (id: string) => { type: string } | undefined } }
    },
    currentSessionId: string,
): Promise<SessionTreeNode[]> {
    const result = await api.client.session.list()
    const allSessions = result?.data ?? []
    const children = allSessions.filter(s => s.parentID === currentSessionId)

    const nodes = await Promise.all(children.map(async s => {
        let duration = ""
        try {
            const msgResult = await api.client.session.messages({ sessionID: s.id, limit: 100 })
            duration = computeDuration(msgResult?.data ?? [])
        } catch {
            // best effort
        }
        return {
            sessionId: s.id,
            agentName: extractAgentName(s.title || s.id),
            duration,
            startTime: formatTime(s.time?.created),
            status: mapStatus(api.state.session.status(s.id)),
            childCount: allSessions.filter(c => c.parentID === s.id).length,
        }
    }))

    return nodes
}

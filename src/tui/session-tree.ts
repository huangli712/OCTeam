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
 * OpenCode subagent sessions have titles like "@explore subagent".
 */
function extractAgentName(title: string): string {
    const match = title.match(/@(\w+)/)
    if (match) return match[1]
    return "agent"
}

/**
 * Format a Unix timestamp (seconds) as MM/DD HH:MM.
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
 * Load all direct child sessions of the given session.
 */
export async function loadChildren(
    api: {
        client: { session: { list: (opts?: { query?: { directory?: string } }) => Promise<{ data?: Array<{ id: string; title?: string; parentID?: string; time?: { created?: number } }> }> } }
        state: { session: { status: (id: string) => { type: string } | undefined } }
    },
    currentSessionId: string,
): Promise<SessionTreeNode[]> {
    const result = await api.client.session.list()
    const allSessions = result?.data ?? []
    const children = allSessions.filter(s => s.parentID === currentSessionId)

    return children.map(s => ({
        sessionId: s.id,
        agentName: extractAgentName(s.title || s.id),
        startTime: formatTime(s.time?.created),
        status: mapStatus(api.state.session.status(s.id)),
        childCount: allSessions.filter(c => c.parentID === s.id).length,
    }))
}

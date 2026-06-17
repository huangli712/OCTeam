/**
 * Session tree data logic for Session Navigator.
 *
 * Fetches child sessions of the current session from the OpenCode host
 * and maps them to display-friendly nodes.
 */

/** Display status derived from OpenCode SessionStatus. */
export type DisplayStatus = "running" | "idle"

/** A child session node for sidebar rendering. */
export type SessionTreeNode = {
    sessionId: string
    title: string
    status: DisplayStatus
    childCount: number
}

/**
 * Map OpenCode's SessionStatus ({ type: "busy" | "idle" | "retry" })
 * to our simplified display status.
 *
 * Note: OpenCode has no "completed" or "errored" session status.
 * A finished session is simply "idle". We collapse retry into running.
 */
export function mapStatus(raw: { type: string } | undefined | null): DisplayStatus {
    if (!raw) return "idle"
    if (raw.type === "busy" || raw.type === "retry") return "running"
    return "idle"
}

/**
 * Load all direct child sessions of the given session.
 *
 * Uses api.client.session.list() to fetch all sessions, then filters
 * by parentID. Status is read synchronously from api.state.session.status().
 */
export async function loadChildren(
    api: {
        client: { session: { list: (opts?: { query?: { directory?: string } }) => Promise<{ data?: Array<{ id: string; title?: string; parentID?: string }> }> } }
        state: { session: { status: (id: string) => { type: string } | undefined } }
    },
    currentSessionId: string,
): Promise<SessionTreeNode[]> {
    const result = await api.client.session.list()
    const allSessions = result?.data ?? []
    const children = allSessions.filter(s => s.parentID === currentSessionId)

    return children.map(s => ({
        sessionId: s.id,
        title: truncate(s.title || s.id, 24),
        status: mapStatus(api.state.session.status(s.id)),
        childCount: allSessions.filter(c => c.parentID === s.id).length,
    }))
}

function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen - 1) + "\u2026"
}

/**
 * Phase 2.9: file-based team loader for the sidebar. Team/member/task state is
 * the server module's private TeamState — the TUI reads it
 * straight from disk (<cwd>/.octeam and ~/.octeam) since TUI and server share
 * the same process filesystem. Polls on refresh; child-session info still comes
 * from api.state/api.client.
 */

import fs from "node:fs/promises"
import path from "node:path"

export type TeamMemberRow = {
    name: string
    role?: string
    status: string
    agent?: string
    model?: string
    sessionId?: string
    unread?: number
    totalMessages?: number
    turnCount?: number
    tokens?: number
}

export type TeamSummary = {
    name: string
    status: string
    activated?: boolean        // true ⇒ this is the session's active (available) team
    members: TeamMemberRow[]
    active?: {
        type: string
        mode?: string
        round?: number
        maxRounds?: number
    }
    tokensUsed?: number
}

/**
 * Count mailbox messages for a recipient by reading its inbox and processed
 * jsonl files directly (one non-empty line per message). Computed on read so
 * the sidebar never depends on a persisted counter that could drift. Returns
 * unread (inbox) and total (inbox + processed). Reserved / in-flight messages
 * live in a separate dir and are intentionally not counted.
 */
export async function countMailbox(teamDir: string, recipient: string): Promise<{ unread: number; total: number }> {
    const countLines = async (file: string): Promise<number> => {
        try {
            const raw = await fs.readFile(path.join(teamDir, "mailbox", file), "utf8")
            return raw.split("\n").filter(l => l.length > 0).length
        } catch {
            return 0
        }
    }
    const unread = await countLines(`${recipient}.jsonl`)
    const processed = await countLines(`${recipient}.processed.jsonl`)
    return { unread, total: unread + processed }
}

async function readTeamsFrom(root: string): Promise<TeamSummary[]> {
    const teamsPath = path.join(root, "teams")
    let entries: import("node:fs").Dirent[]
    try {
        entries = await fs.readdir(teamsPath, { withFileTypes: true })
    } catch {
        return []
    }
    const out: TeamSummary[] = []
    for (const e of entries) {
        if (!e.isDirectory()) continue
        try {
            const teamDir = path.join(teamsPath, e.name)
            const raw = await fs.readFile(path.join(teamDir, "state.json"), "utf8")
            const state = JSON.parse(raw)
            // Also read config.json for member roles (role lives in MemberSpec, not MemberState).
            let roleMap: Record<string, string> = {}
            try {
                const configRaw = await fs.readFile(path.join(teamDir, "config.json"), "utf8")
                const config = JSON.parse(configRaw)
                for (const m of (config.members ?? [])) {
                    roleMap[m.name] = m.role
                }
            } catch {
                // config.json may be absent for legacy teams
            }
            out.push({
                name: state.teamName ?? e.name,
                status: state.status ?? "unknown",
                activated: state.activatedAt !== undefined,
                members: await Promise.all((state.members ?? []).map(async (m: any) => {
                    const mailbox = await countMailbox(teamDir, m.name)
                    return {
                        name: m.name,
                        role: roleMap[m.name],
                        status: m.status,
                        agent: m.agent,
                        model: m.model,
                        sessionId: m.sessionId,
                        unread: mailbox.unread,
                        totalMessages: mailbox.total,
                        turnCount: m.turnCount,
                        tokens: state.activeTask?.tokensByMember?.[m.name],
                    }
                })),
                active: state.activeTask
                    ? {
                          type: state.activeTask.type,
                          mode: state.activeTask.mode,
                          round: state.activeTask.currentRound,
                          maxRounds: state.activeTask.maxRounds,
                      }
                    : state.lastMode
                      ? {
                            type: state.lastMode.type,
                            mode: state.lastMode.mode,
                        }
                      : undefined,
                tokensUsed: state.activeTask?.tokensUsed,
            })
        } catch {
            // unreadable state.json — skip
        }
    }
    return out
}

/**
 * Load teams visible to the given session. Session-scoping: only project-scope
 * teams owned by this session (under <cwd>/.octeam/<sessionId>/teams/) show.
 * User-scope (~/.octeam) teams are global and intentionally excluded from the
 * per-session sidebar view.
 */
export async function loadTeams(sessionId: string): Promise<TeamSummary[]> {
    const root = path.join(process.cwd(), ".octeam", sessionId)
    return readTeamsFrom(root)
}

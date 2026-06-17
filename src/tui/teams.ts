/** @jsxImportSource @opentui/solid */
// @ts-nocheck

/**
 * Phase 2.9: file-based team loader for the sidebar. Team/member/task state is
 * the server module's private RuntimeState (design §10) — the TUI reads it
 * straight from disk (<cwd>/.octeam and ~/.octeam) since TUI and server share
 * the same process filesystem. Polls on refresh; child-session info still comes
 * from api.state/api.client (kept separate per §10).
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type TeamMemberRow = {
    name: string
    status: string
    model?: string
    sessionId?: string
    unread?: number
}

export type TeamSummary = {
    name: string
    status: string
    members: TeamMemberRow[]
    active?: {
        type: string
        mode?: string
        round?: number
        maxRounds?: number
    }
    tokensUsed?: number
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
            const raw = await fs.readFile(path.join(teamsPath, e.name, "state.json"), "utf8")
            const state = JSON.parse(raw)
            out.push({
                name: state.teamName ?? e.name,
                status: state.status ?? "unknown",
                members: (state.members ?? []).map((m: any) => ({
                    name: m.name,
                    status: m.status,
                    model: m.model,
                    sessionId: m.sessionId,
                    unread: m.pendingMessageCount,
                })),
                active: state.activeTask
                    ? {
                          type: state.activeTask.type,
                          mode: state.activeTask.mode,
                          round: state.activeTask.currentRound,
                          maxRounds: state.activeTask.maxRounds,
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

/** Load teams from project-local (<cwd>/.octeam) and user (~/.octeam) scopes. */
export async function loadTeams(): Promise<TeamSummary[]> {
    const project = await readTeamsFrom(path.join(process.cwd(), ".octeam"))
    const user = await readTeamsFrom(path.join(os.homedir(), ".octeam"))
    // Project scope takes precedence on name collisions.
    const seen = new Set(project.map(t => t.name))
    return [...project, ...user.filter(t => !seen.has(t.name))]
}

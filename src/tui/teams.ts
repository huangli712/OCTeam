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

/**
 * Count unread mailbox messages for a recipient by reading its inbox jsonl
 * directly (one non-empty line per pending message). Computed on read so the
 * sidebar never depends on a persisted counter that could drift. Reserved /
 * in-flight messages live in a separate dir and are intentionally not counted.
 */
async function countUnread(teamDir: string, recipient: string): Promise<number> {
    try {
        const raw = await fs.readFile(path.join(teamDir, "mailbox", `${recipient}.jsonl`), "utf8")
        return raw.split("\n").filter(l => l.length > 0).length
    } catch {
        return 0
    }
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
            out.push({
                name: state.teamName ?? e.name,
                status: state.status ?? "unknown",
                members: await Promise.all((state.members ?? []).map(async (m: any) => ({
                    name: m.name,
                    status: m.status,
                    model: m.model,
                    sessionId: m.sessionId,
                    unread: await countUnread(teamDir, m.name),
                }))),
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

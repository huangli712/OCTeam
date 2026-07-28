/**
 * Phase 2.9: file-based team loader for the sidebar. Team/member/task state is
 * the server module's private TeamState — the TUI reads it
 * straight from disk (<cwd>/.octeam and ~/.octeam) since TUI and server share
 * the same process filesystem. Polls on refresh; child-session info still comes
 * from api.state/api.client.
 */

import fs from "node:fs/promises"
import path from "node:path"

// Reuse the server's path-construction contract so the sidebar never drifts from
// the on-disk storage layout. src/state/paths.ts is the single source of truth
// for the teams/<name>/{state.json,config.json,mailbox/...} layout.
import { configPath, inboxPath, processedPath, statePath, teamDir, teamsDir } from "../state/paths.js"
import { isValidTeamState } from "../state/store.js"
import { assertNoSymlinkTraversal } from "../state/locks.js"

/** Flat member row for sidebar rendering from on-disk team state. */
export type TeamMemberRow = {
    name: string
    role?: string
    status: string
    agent?: string
    model?: string
    sessionId?: string
    worktreePath?: string
    unread?: number
    totalMessages?: number
    turnCount?: number
    tokens?: number
}

/** Team summary for sidebar display with member rows and active task info. */
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
export async function countMailbox(teamDirectory: string, recipient: string): Promise<{ unread: number; total: number }> {
    const countLines = async (file: string): Promise<number> => {
        try {
            // HIGH-G: cap the file size before reading so a maliciously
            // placed large file (or /dev/zero via symlink) cannot OOM the
            // sidebar process. 1 MiB is far above any legitimate processed.jsonl
            // (the retention cap is 1000 lines, ~100 KB typical).
            const stat = await fs.stat(file)
            if (stat.size > 1_048_576) {
                console.warn(`[octeam] countMailbox: ${file} exceeds 1 MiB cap, refusing to read`)
                return 0
            }
            const raw = await fs.readFile(file, "utf8")
            return raw.split("\n").filter(l => l.length > 0).length
        } catch (err: unknown) {
            // M-22: ENOENT (no inbox yet) is expected — return 0. Other errors
            // (EACCES, EIO, corruption) are real problems; log so operators
            // notice, then fall back to 0 so the sidebar does not crash.
            const code = (err as NodeJS.ErrnoException).code
            if (code !== "ENOENT") {
                console.warn(`[octeam] countMailbox: unreadable ${file}: ${err instanceof Error ? err.message : String(err)}`)
            }
            return 0
        }
    }
    const unread = await countLines(inboxPath(teamDirectory, recipient))
    const processed = await countLines(processedPath(teamDirectory, recipient))
    return { unread, total: unread + processed }
}

async function readTeamsFrom(storageRoot: string, leadSessionId: string): Promise<TeamSummary[]> {
    const teamsPath = teamsDir(storageRoot, leadSessionId)
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
            const dir = teamDir(storageRoot, e.name, leadSessionId)
            // HIGH-G: refuse to read state/config/mailbox through a symlinked
            // team directory. A member with FS write access could symlink the
            // team dir to /etc or an arbitrary large file, causing the TUI to
            // read or OOM on attacker-controlled content.
            await assertNoSymlinkTraversal(storageRoot, dir)
            const raw = await fs.readFile(statePath(dir), "utf8")
            const state = JSON.parse(raw)
            if (!isValidTeamState(state, dir)) continue
            // Also read config.json for member roles (role lives in MemberSpec, not MemberState).
            const roleMap: Record<string, string> = {}
            try {
                const configRaw = await fs.readFile(configPath(dir), "utf8")
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
                members: await Promise.all((state.members ?? []).map(async (m) => {
                    const mailbox = await countMailbox(dir, m.name)
                    return {
                        name: typeof m.name === "string" ? m.name : "?",
                        role: roleMap[m.name],
                        status: typeof m.status === "string" ? m.status : "unknown",
                        agent: typeof m.agent === "string" ? m.agent : undefined,
                        // M-5: validate model is a string — disk tampering can
                        // set it to a number/object, and sidebar.tsx calls
                        // member.model.split() which would throw on non-strings.
                        model: typeof m.model === "string" ? m.model : undefined,
                        sessionId: typeof m.sessionId === "string" ? m.sessionId : undefined,
                        worktreePath: typeof m.worktreePath === "string" ? m.worktreePath : undefined,
                        unread: mailbox.unread,
                        totalMessages: mailbox.total,
                        turnCount: typeof m.turnCount === "number" ? m.turnCount : undefined,
                        tokens: state.activeTask?.tokensByMember?.[m.name] ?? state.lastMode?.tokensByMember?.[m.name],
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
                tokensUsed: state.activeTask?.tokensUsed ?? state.lastMode?.tokensUsed,
            })
        } catch (err: unknown) {
            // M-22: ENOENT means the team dir was removed between readdir and
            // readFile — skip silently. Other errors (EACCES, EIO, corrupt JSON)
            // are real problems; log so operators notice.
            const code = (err as NodeJS.ErrnoException).code
            if (code !== "ENOENT") {
                console.warn(`[octeam] readTeamsFrom: unreadable state for "${e.name}": ${err instanceof Error ? err.message : String(err)}`)
            }
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
    // <cwd>/.octeam mirrors context.ts's project-scope storageRoot; teamsDir()
    // then appends the session segment + "teams".
    const storageRoot = path.join(process.cwd(), ".octeam")
    return readTeamsFrom(storageRoot, sessionId)
}

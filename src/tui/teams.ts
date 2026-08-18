/**
 * File-based team loader for the sidebar. Team/member/task state is
 * the server module's private TeamState — the TUI reads it
 * straight from disk (<workspace>/.octeam and ~/.octeam) since TUI and server share
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
import { assertNoSymlinkTraversal, safeReadFile } from "../state/locks.js"
import { isEnoent } from "../core/utils.js"

/** Result state for sidebar data, including optional partial data on errors. */
export type LoadState<T> =
    | { status: "unknown" }
    | { status: "ok"; data: T }
    | { status: "error"; error: string; data?: T }

/** Unread and total message counts for a mailbox. */
export type MailboxCount = { unread: number; total: number }

/** Flat member row for sidebar rendering from on-disk team state. */
export type TeamMemberRow = {
    name: string
    role?: string
    status: string
    agent?: string
    model?: string
    sessionId?: string
    worktreePath?: string
    mailbox: LoadState<MailboxCount>
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
export async function countMailbox(teamDirectory: string, recipient: string): Promise<LoadState<MailboxCount>> {
    const countLines = async (file: string): Promise<number> => {
        try {
            const raw = await safeReadFile(teamDirectory, file, { maxBytes: 1_048_576 })
            if (raw === undefined) return 0
            return raw.split("\n").filter(l => l.length > 0).length
        } catch (err: unknown) {
            // ENOENT is expected before an inbox exists. Other errors such as
            // EACCES, EIO, or corruption remain distinct from an empty mailbox.
            const code = (err as NodeJS.ErrnoException).code
            if (code === "ENOENT") return 0
            throw err
        }
    }
    try {
        const unread = await countLines(inboxPath(teamDirectory, recipient))
        const processed = await countLines(processedPath(teamDirectory, recipient))
        return { status: "ok", data: { unread, total: unread + processed } }
    } catch (err) {
        console.warn(`[octeam] countMailbox: unavailable for ${recipient}: ${err instanceof Error ? err.message : String(err)}`)
        return { status: "error", error: "mailbox unavailable" }
    }
}

async function readTeamsFrom(storageRoot: string, leadSessionId: string): Promise<LoadState<TeamSummary[]>> {
    const teamsPath = teamsDir(storageRoot, leadSessionId)
    let entries: import("node:fs").Dirent[]
    try {
        entries = await fs.readdir(teamsPath, { withFileTypes: true })
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "ok", data: [] }
        console.warn(`[octeam] readTeamsFrom: unreadable teams directory: ${err instanceof Error ? err.message : String(err)}`)
        return { status: "error", error: "teams unavailable" }
    }
    const out: TeamSummary[] = []
    let hadError = false
    for (const e of entries) {
        if (!e.isDirectory()) continue
        try {
            const dir = teamDir(storageRoot, e.name, leadSessionId)
            // Refuse to read state/config/mailbox through a symlinked
            // team directory. A member with FS write access could symlink the
            // team dir to /etc or an arbitrary large file, causing the TUI to
            // read or OOM on attacker-controlled content.
            await assertNoSymlinkTraversal(storageRoot, dir)
            // Validate the descendant files (state.json, config.json,
            // mailbox) are not symlinks. assertNoSymlinkTraversal above
            // only checks the team DIRECTORY, not its contents. A symlinked
            // state.json could read arbitrary content; /dev/zero could OOM.
            const stateP = statePath(dir)
            // Use fd-based safeReadFile to narrow the TOCTOU window and cap
            // state.json at 1 MiB.
            const stateRaw = await safeReadFile(dir, stateP, { maxBytes: 1_048_576 })
            if (stateRaw === undefined) continue
            const state = JSON.parse(stateRaw)
            if (!isValidTeamState(state, dir)) {
                hadError = true
                continue
            }
            // Also read config.json for member roles (role lives in MemberSpec, not MemberState).
            const roleMap: Record<string, string> = {}
            try {
                const configP = configPath(dir)
                // Use fd-based safeReadFile for config.json too.
                const configRaw = await safeReadFile(dir, configP, { maxBytes: 1_048_576 })
                if (configRaw === undefined) throw new Error("config absent")
                const config = JSON.parse(configRaw)
                for (const m of (config.members ?? [])) {
                    roleMap[m.name] = m.role
                }
            } catch (err) {
                if (!isEnoent(err)) {
                    console.warn(`[octeam] teams: failed to read config for ${e.name}`, err)
                }
            }
            out.push({
                name: state.teamName ?? e.name,
                status: state.status ?? "unknown",
                activated: state.activatedAt !== undefined,
                members: await Promise.all((state.members ?? []).map(async (m) => {
                    const mailbox = await countMailbox(dir, m.name)
                    return {
                        name: typeof m.name === "string" ? m.name : "?",
                        role: typeof roleMap[m.name] === "string" ? roleMap[m.name] : undefined,
                        status: typeof m.status === "string" ? m.status : "unknown",
                        agent: typeof m.agent === "string" ? m.agent : undefined,
                        // Validate model as a string because disk tampering can
                        // supply another type while sidebar.tsx calls split().
                        model: typeof m.model === "string" ? m.model : undefined,
                        sessionId: typeof m.sessionId === "string" ? m.sessionId : undefined,
                        worktreePath: typeof m.worktreePath === "string" ? m.worktreePath : undefined,
                        mailbox,
                        turnCount: typeof m.turnCount === "number" ? m.turnCount : undefined,
                        // Validate tokensByMember entries as numbers because
                        // other types would break sidebar arithmetic or display.
                        tokens: typeof (state.activeTask?.tokensByMember?.[m.name] ?? state.lastMode?.tokensByMember?.[m.name]) === "number"
                            ? (state.activeTask?.tokensByMember?.[m.name] ?? state.lastMode?.tokensByMember?.[m.name])
                            : undefined,
                    }
                })),
                active: state.activeTask && typeof state.activeTask === "object"
                    ? {
                          // Validate activeTask fields before rendering because
                          // other value types can break the sidebar.
                          type: typeof state.activeTask.type === "string" ? state.activeTask.type : "unknown",
                          mode: typeof state.activeTask.mode === "string" ? state.activeTask.mode : undefined,
                          round: typeof state.activeTask.currentRound === "number" ? state.activeTask.currentRound : undefined,
                          maxRounds: typeof state.activeTask.maxRounds === "number" ? state.activeTask.maxRounds : undefined,
                      }
                    : state.lastMode && typeof state.lastMode === "object"
                      ? {
                            type: typeof state.lastMode.type === "string" ? state.lastMode.type : "unknown",
                            mode: typeof state.lastMode.mode === "string" ? state.lastMode.mode : undefined,
                        }
                      : undefined,
                // Validate tokensUsed as a number.
                tokensUsed: typeof (state.activeTask?.tokensUsed ?? state.lastMode?.tokensUsed) === "number"
                    ? (state.activeTask?.tokensUsed ?? state.lastMode?.tokensUsed)
                    : undefined,
            })
        } catch (err: unknown) {
            // ENOENT means the team directory was removed between listing and
            // reading, so skip it. Log other errors for operators.
            const code = (err as NodeJS.ErrnoException).code
            if (code !== "ENOENT") {
                hadError = true
                console.warn(`[octeam] readTeamsFrom: unreadable state for "${e.name}": ${err instanceof Error ? err.message : String(err)}`)
            }
        }
    }
    return hadError
        ? { status: "error", error: "one or more teams are unavailable", data: out }
        : { status: "ok", data: out }
}

/**
 * Load teams visible to the given session. Session-scoping: only project-scope
 * teams owned by this session (under <cwd>/.octeam/<sessionId>/teams/) show.
 * User-scope (~/.octeam) teams are global and intentionally excluded from the
 * per-session sidebar view.
 */
export async function loadTeams(directory: string, sessionId: string): Promise<LoadState<TeamSummary[]>> {
    // <workspace>/.octeam mirrors context.ts's project-scope storageRoot; teamsDir()
    // then appends the session segment + "teams".
    const storageRoot = path.join(directory, ".octeam")
    return readTeamsFrom(storageRoot, sessionId)
}

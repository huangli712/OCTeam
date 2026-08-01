/**
 * Phase 2.9: file-based team loader for the sidebar. Team/member/task state is
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

export type LoadState<T> =
    | { status: "unknown" }
    | { status: "ok"; data: T }
    | { status: "error"; error: string; data?: T }

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
            await assertNoSymlinkTraversal(teamDirectory, file)
            // HIGH-G: cap the file size before reading so a maliciously
            // placed large file (or /dev/zero via symlink) cannot OOM the
            // sidebar process. 1 MiB is far above any legitimate processed.jsonl
            // (the retention cap is 1000 lines, ~100 KB typical).
            // H27/R1: use lstat (no follow) to detect symlinks AND check size.
            // lstat on a symlink returns the symlink's own small size, NOT the
            // H13: also reject non-regular files (FIFO, device) which would
            // hang readFile or produce infinite output. Pre-fix code only
            // rejected symlinks (R1).
            const lstat = await fs.lstat(file)
            if (lstat.isSymbolicLink() || !lstat.isFile()) {
                throw new Error("refusing non-regular mailbox file")
            }
            if (lstat.size > 1_048_576) {
                throw new Error("mailbox file exceeds 1 MiB cap")
            }
            const raw = await fs.readFile(file, "utf8")
            return raw.split("\n").filter(l => l.length > 0).length
        } catch (err: unknown) {
            // M-22: ENOENT (no inbox yet) is expected — return 0. Other errors
            // (EACCES, EIO, corruption) are real problems and must remain
            // distinguishable from an empty mailbox.
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
            // HIGH-G: refuse to read state/config/mailbox through a symlinked
            // team directory. A member with FS write access could symlink the
            // team dir to /etc or an arbitrary large file, causing the TUI to
            // read or OOM on attacker-controlled content.
            await assertNoSymlinkTraversal(storageRoot, dir)
            // H27: validate the descendant files (state.json, config.json,
            // mailbox) are not symlinks. assertNoSymlinkTraversal above
            // only checks the team DIRECTORY, not its contents. A symlinked
            // state.json could read arbitrary content; /dev/zero could OOM.
            const stateP = statePath(dir)
            // C1: use fd-based safeReadFile to shrink TOCTOU window and cap
            // size at 1 MiB. Pre-fix code did lstat+size-check+readFile in
            // three separate steps with races between each.
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
                // C1: use fd-based safeReadFile for config.json too.
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
                        // M-5: validate model is a string — disk tampering can
                        // set it to a number/object, and sidebar.tsx calls
                        // member.model.split() which would throw on non-strings.
                        model: typeof m.model === "string" ? m.model : undefined,
                        sessionId: typeof m.sessionId === "string" ? m.sessionId : undefined,
                        worktreePath: typeof m.worktreePath === "string" ? m.worktreePath : undefined,
                        mailbox,
                        turnCount: typeof m.turnCount === "number" ? m.turnCount : undefined,
                        // M-12: validate tokensByMember entries are numbers — a
                        // tampered state.json can set them to objects/strings,
                        // and the sidebar would crash on arithmetic or display.
                        tokens: typeof (state.activeTask?.tokensByMember?.[m.name] ?? state.lastMode?.tokensByMember?.[m.name]) === "number"
                            ? (state.activeTask?.tokensByMember?.[m.name] ?? state.lastMode?.tokensByMember?.[m.name])
                            : undefined,
                    }
                })),
                active: state.activeTask && typeof state.activeTask === "object"
                    ? {
                          // M-12: validate activeTask fields before passing to the
                          // sidebar — a tampered state.json can set type/mode to
                          // objects or numbers, crashing the sidebar renderer.
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
                // M-12: validate tokensUsed is a number.
                tokensUsed: typeof (state.activeTask?.tokensUsed ?? state.lastMode?.tokensUsed) === "number"
                    ? (state.activeTask?.tokensUsed ?? state.lastMode?.tokensUsed)
                    : undefined,
            })
        } catch (err: unknown) {
            // M-22: ENOENT means the team dir was removed between readdir and
            // readFile — skip silently. Other errors (EACCES, EIO, corrupt JSON)
            // are real problems; log so operators notice.
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

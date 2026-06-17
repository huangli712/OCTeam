import path from "node:path"

import type { StorageScope } from "../types.js"

const TEAM_NAME_PATTERN = /^[a-z0-9-]+$/

/** Validate a team name matches the allowed pattern /^[a-z0-9-]+$/. */
export function isValidTeamName(name: string): boolean {
    return TEAM_NAME_PATTERN.test(name)
}

/**
 * Resolve the .octeam storage root for a given scope.
 * - project: <projectDir>/.octeam  (teams bound to the project working dir)
 * - user:    <homeDir>/.octeam     (teams shared across the user's projects)
 */
export function resolveStorageRoot(
    scope: StorageScope,
    projectDir: string,
    homeDir: string,
): string {
    return scope === "project"
        ? path.join(projectDir, ".octeam")
        : path.join(homeDir, ".octeam")
}

// --- Scope-level paths ---

/** <storageRoot>/teams */
export function teamsDir(storageRoot: string): string {
    return path.join(storageRoot, "teams")
}

/** <storageRoot>/teams/{teamName} */
export function teamDir(storageRoot: string, teamName: string): string {
    return path.join(teamsDir(storageRoot), teamName)
}

// --- Per-team file paths (take the resolved team directory) ---

/** config.json — TeamSpec (immutable, written at team_create) */
export function configPath(teamDirectory: string): string {
    return path.join(teamDirectory, "config.json")
}

/** state.json — RuntimeState (mutable, lock-protected) */
export function statePath(teamDirectory: string): string {
    return path.join(teamDirectory, "state.json")
}

/** state.json.lock — cross-process file lock guarding state.json writes */
export function stateLockPath(teamDirectory: string): string {
    return path.join(teamDirectory, "state.json.lock")
}

// --- mailbox/ ---

export function mailboxDir(teamDirectory: string): string {
    return path.join(teamDirectory, "mailbox")
}

/** mailbox/{recipient}.jsonl — pending inbox (append-only) */
export function inboxPath(teamDirectory: string, recipient: string): string {
    return path.join(mailboxDir(teamDirectory), `${recipient}.jsonl`)
}

/** mailbox/{recipient}.processed.jsonl — delivered messages (audit) */
export function processedPath(teamDirectory: string, recipient: string): string {
    return path.join(mailboxDir(teamDirectory), `${recipient}.processed.jsonl`)
}

/** mailbox/{recipient}.reserved/ — in-flight reservation dir (atomic) */
export function reservedDir(teamDirectory: string, recipient: string): string {
    return path.join(mailboxDir(teamDirectory), `${recipient}.reserved`)
}

/** mailbox/{recipient}.reserved/{messageId} — a single reserved message */
export function reservedPath(
    teamDirectory: string,
    recipient: string,
    messageId: string,
): string {
    return path.join(reservedDir(teamDirectory, recipient), messageId)
}

/** mailbox/{recipient}.lock — file lock for atomic read-and-reserve */
export function mailboxLockPath(teamDirectory: string, recipient: string): string {
    return path.join(mailboxDir(teamDirectory), `${recipient}.lock`)
}

// --- tasks/ ---

export function tasksDir(teamDirectory: string): string {
    return path.join(teamDirectory, "tasks")
}

export function taskPath(teamDirectory: string, taskId: string): string {
    return path.join(tasksDir(teamDirectory), `${taskId}.json`)
}

export function claimsDir(teamDirectory: string): string {
    return path.join(tasksDir(teamDirectory), "claims")
}

/** tasks/claims/{taskId}.lock — per-task claim lock */
export function claimLockPath(teamDirectory: string, taskId: string): string {
    return path.join(claimsDir(teamDirectory), `${taskId}.lock`)
}

// --- worktrees/ (only when member worktree: true) ---

export function worktreesDir(teamDirectory: string): string {
    return path.join(teamDirectory, "worktrees")
}

export function worktreePath(teamDirectory: string, memberName: string): string {
    return path.join(worktreesDir(teamDirectory), memberName)
}

// --- runs/ (per-run artifacts: logs, outputs) ---

export function runsDir(teamDirectory: string): string {
    return path.join(teamDirectory, "runs")
}

export function runDir(teamDirectory: string, teamRunId: string): string {
    return path.join(runsDir(teamDirectory), teamRunId)
}

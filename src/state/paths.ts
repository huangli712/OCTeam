import path from "node:path"

// --- Scope-level paths ---

/**
 * Teams root for a scope.
 *
 * - leadSessionId present → <storageRoot>/<leadSessionId>/teams
 *   (project scope: teams are segmented under their lead session).
 * - leadSessionId absent  → <storageRoot>/teams
 *   (user scope: flat/global, shared across sessions).
 */
export function teamsDir(storageRoot: string, leadSessionId?: string): string {
    return leadSessionId
        ? path.join(storageRoot, leadSessionId, "teams")
        : path.join(storageRoot, "teams")
}

/** <storageRoot>[/<leadSessionId>]/teams/{teamName} */
export function teamDir(storageRoot: string, teamName: string, leadSessionId?: string): string {
    return path.join(teamsDir(storageRoot, leadSessionId), teamName)
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

/** tasks/claims/{taskId}.update.lock — short-lived lock serializing updateTask read-modify-write */
export function taskUpdateLockPath(teamDirectory: string, taskId: string): string {
    return path.join(claimsDir(teamDirectory), `${taskId}.update.lock`)
}

// --- worktrees/ (only when member worktree: true) ---

export function worktreesDir(teamDirectory: string): string {
    return path.join(teamDirectory, "worktrees")
}

export function worktreePath(teamDirectory: string, memberName: string): string {
    return path.join(worktreesDir(teamDirectory), memberName)
}



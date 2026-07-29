/**
 * Team directory layout and path construction. All on-disk paths for team state,
 * mailbox, tasks, worktrees, and run records are derived from these functions.
 */

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
    // leadSessionId is host-assigned (context.sessionID), not a tool argument,
    // but validate it as defense-in-depth so a malformed value can never escape
    // the storage root via path traversal.
    if (leadSessionId !== undefined && !isSafePathSegment(leadSessionId)) {
        throw new Error(`teamsDir: unsafe leadSessionId segment: ${JSON.stringify(leadSessionId)}`)
    }
    return leadSessionId
        ? path.join(storageRoot, leadSessionId, "teams")
        : path.join(storageRoot, "teams")
}

/** <storageRoot>[/<leadSessionId>]/teams/{teamName} */
export function teamDir(storageRoot: string, teamName: string, leadSessionId?: string): string {
    assertSafeSegment(teamName, "teamDir", "teamName")
    return path.join(teamsDir(storageRoot, leadSessionId), teamName)
}

// --- Per-team file paths (take the resolved team directory) ---

/** config.json — TeamSpec (immutable, written at team_create) */
export function configPath(teamDirectory: string): string {
    return path.join(teamDirectory, "config.json")
}

/** state.json — TeamState (mutable, lock-protected) */
export function statePath(teamDirectory: string): string {
    return path.join(teamDirectory, "state.json")
}

/** state.json.lock — cross-process file lock guarding state.json writes */
export function stateLockPath(teamDirectory: string): string {
    return path.join(teamDirectory, "state.json.lock")
}

/** team.lifecycle.lock — cross-process lock guarding team lifecycle operations
 *  (startup spawning, rename, fixmember, delete). Prevents cross-process races
 *  where sibling OpenCode instances concurrently modify the same team. */
export function teamLifecycleLockPath(teamDirectory: string): string {
    return path.join(teamDirectory, "team.lifecycle.lock")
}

// --- mailbox/ ---

/** Mailbox directory path for a team: `<teamDirectory>/mailbox`. */
export function mailboxDir(teamDirectory: string): string {
    return path.join(teamDirectory, "mailbox")
}

/** mailbox/{recipient}.jsonl — pending inbox (append-only) */
export function inboxPath(teamDirectory: string, recipient: string): string {
    assertSafeSegment(recipient, "inboxPath", "recipient")
    return path.join(mailboxDir(teamDirectory), `${recipient}.jsonl`)
}

/** mailbox/{recipient}.processed.jsonl — delivered messages (audit) */
export function processedPath(teamDirectory: string, recipient: string): string {
    assertSafeSegment(recipient, "processedPath", "recipient")
    return path.join(mailboxDir(teamDirectory), `${recipient}.processed.jsonl`)
}

/** mailbox/{recipient}.reserved/ — in-flight reservation dir (atomic) */
export function reservedDir(teamDirectory: string, recipient: string): string {
    assertSafeSegment(recipient, "reservedDir", "recipient")
    return path.join(mailboxDir(teamDirectory), `${recipient}.reserved`)
}

/** mailbox/{recipient}.reserved/{messageId} — a single reserved message */
export function reservedPath(
    teamDirectory: string,
    recipient: string,
    messageId: string,
): string {
    assertSafeSegment(messageId, "reservedPath", "messageId")
    return path.join(reservedDir(teamDirectory, recipient), messageId)
}

/** mailbox/{recipient}.lock — file lock for atomic read-and-reserve */
export function mailboxLockPath(teamDirectory: string, recipient: string): string {
    assertSafeSegment(recipient, "mailboxLockPath", "recipient")
    return path.join(mailboxDir(teamDirectory), `${recipient}.lock`)
}

// --- tasks/ ---

/** Tasks directory path for a team: `<teamDirectory>/tasks`. */
export function tasksDir(teamDirectory: string): string {
    return path.join(teamDirectory, "tasks")
}

/** Path to a single task file: `<teamDirectory>/tasks/<taskId>.json`. */
export function taskPath(teamDirectory: string, taskId: string): string {
    assertSafeSegment(taskId, "taskPath", "taskId")
    return path.join(tasksDir(teamDirectory), `${taskId}.json`)
}

/** Claims directory path: `<teamDirectory>/tasks/claims`. */
export function claimsDir(teamDirectory: string): string {
    return path.join(tasksDir(teamDirectory), "claims")
}

/** tasks/claims/{taskId}.lock — per-task claim lock */
export function claimLockPath(teamDirectory: string, taskId: string): string {
    assertSafeSegment(taskId, "claimLockPath", "taskId")
    return path.join(claimsDir(teamDirectory), `${taskId}.lock`)
}

/** tasks/claims/{taskId}.update.lock — short-lived lock serializing updateTask read-modify-write */
export function taskUpdateLockPath(teamDirectory: string, taskId: string): string {
    assertSafeSegment(taskId, "taskUpdateLockPath", "taskId")
    return path.join(claimsDir(teamDirectory), `${taskId}.update.lock`)
}

/** tasks/claims/claim-mutex.lock — team-level mutex serializing the
 * ownership-check + claim critical section so two concurrent claims by the
 * same member cannot both pass the "no active task" check (TOCTOU). */
export function claimMutexPath(teamDirectory: string): string {
    return path.join(claimsDir(teamDirectory), "claim-mutex.lock")
}

// --- worktrees/ (only when member worktree: true) ---

/** Worktrees directory path for a team: `<teamDirectory>/worktrees`. */
export function worktreesDir(teamDirectory: string): string {
    return path.join(teamDirectory, "worktrees")
}

/** Path to a member's worktree directory: `<teamDirectory>/worktrees/<memberName>`. */
export function worktreePath(teamDirectory: string, memberName: string): string {
    assertSafeSegment(memberName, "worktreePath", "memberName")
    return path.join(worktreesDir(teamDirectory), memberName)
}

// --- runs/ (per-orchestration result records + full member outputs) ---

/**
 * True if `s` is a single safe path segment: non-empty, no path separators,
 * no `..`/`.` traversal, no NUL. Used to validate caller-supplied run_id /
 * member values before they are interpolated into runs/<...> paths, so a value
 * like "../../otherteam/runs/x" cannot escape the team's runs/ directory.
 */
export function isSafePathSegment(s: string): boolean {
    return s.length > 0
        && !s.includes("/")
        && !s.includes("\\")
        && !s.includes("\0")
        && s !== "."
        && s !== ".."
}

/**
 * Assert a string is a single safe path segment. Centralizes traversal
 * validation at the path-construction chokepoint so BOTH live tool arguments
 * AND values re-loaded from disk (state.json/config.json — parsed without
 * schema re-validation) are guarded uniformly. Throws on an unsafe segment
 * rather than silently producing an escaped path.
 */
export function assertSafeSegment(s: string, fn: string, label: string): void {
    if (!isSafePathSegment(s)) {
        throw new Error(`${fn}: unsafe ${label} segment: ${JSON.stringify(s)}`)
    }
}

/** Runs directory path for a team: `<teamDirectory>/runs`. */
export function runsDir(teamDirectory: string): string {
    return path.join(teamDirectory, "runs")
}

/** runs/{runId} — one directory per orchestration run */
export function runDir(teamDirectory: string, runId: string): string {
    assertSafeSegment(runId, "runDir", "runId")
    return path.join(runsDir(teamDirectory), runId)
}

/** runs/{runId}/record.json — RunRecord (metadata + output file references) */
export function runRecordPath(teamDirectory: string, runId: string): string {
    return path.join(runDir(teamDirectory, runId), "record.json")
}

/**
 * runs/{runId}/{member}.md — a single member's ACCUMULATED output across all
 * its turns in this run (appended per idle; NOT just the last turn). Excludes
 * reduce-stage output, which goes to runReduceOutputPath.
 */
export function runMemberOutputPath(teamDirectory: string, runId: string, memberName: string): string {
    assertSafeSegment(memberName, "runMemberOutputPath", "memberName")
    return path.join(runDir(teamDirectory, runId), `${memberName}.md`)
}

/**
 * runs/{runId}/reduce.md — the run-level reduced artifact produced by the
 * reducer member during the reduce stage. Kept separate from the reducer's own
 * {member}.md (which holds that member's primary deliverable) so neither
 * overwrites the other. Picked up automatically by persistRun's .md readdir
 * scan, so team_result_get(member="reduce") returns it with no extra plumbing.
 */
export function runReduceOutputPath(teamDirectory: string, runId: string): string {
    return path.join(runDir(teamDirectory, runId), "reduce.md")
}

/**
 * runs/{runId}/signoff.md — the run-level signoff verdict(s) produced by
 * reviewer member(s) during the signoff stage. Kept separate from each
 * reviewer's own {member}.md (which holds that member's primary deliverable)
 * so neither overwrites the other. Picked up automatically by persistRun's
 * .md readdir scan, mirroring runReduceOutputPath.
 */
export function runSignoffOutputPath(teamDirectory: string, runId: string): string {
    return path.join(runDir(teamDirectory, runId), "signoff.md")
}

/** runs/{runId}/events.jsonl — append-only run timeline (one RunEvent per line) */
export function runEventsPath(teamDirectory: string, runId: string): string {
    return path.join(runDir(teamDirectory, runId), "events.jsonl")
}

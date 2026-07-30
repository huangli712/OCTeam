/**
 * Shared task list for cooperative coordination.
 *
 * Tasks are independent JSON files under `tasks/{taskId}.json`. Claiming uses a
 * persistent `tasks/claims/{taskId}.lock` file (fs.open 'wx') plus a
 * Task.status double-check. The reaper reconciles claim-lock TTL with
 * Task.status: a "claimed" task whose lock is stale AND whose claimedAt exceeds
 * CLAIM_TTL is reset to "pending" so another member can claim it.
 *
 * Status lifecycle: pending -> claimed -> in_progress -> completed | deleted.
 * Only "claimed" is reaped (the claim->start window); "in_progress" is active
 * work and left alone.
 */

import fs from "node:fs/promises"
import crypto from "node:crypto"

import { logger } from '../core/log.js';
import { isEnoent } from '../core/utils.js';
import { assertNoSymlinkTraversal, CLAIM_TTL_MS, atomicWrite, lockFresh, withLock } from "./locks.js"
import { claimLockPath, claimMutexPath, claimsDir, taskPath, tasksDir, taskUpdateLockPath } from "./paths.js"
import type { Task, TaskStatus } from "../core/types.js"

/** Error thrown when a task is already claimed or not in claimable state. */
export class TaskAlreadyClaimedError extends Error {
    constructor(taskId: string) {
        super(`Task ${taskId} is already claimed or not claimable`)
        this.name = "TaskAlreadyClaimedError"
    }
}

/**
 * Raised by claimTask when the calling member already holds another task in
 * the "claimed" or "in_progress" window. Enforces the
 * claim → complete → idle → claim-next workflow (one active task per member).
 */
export class MemberHoldsActiveTaskError extends Error {
    constructor(member: string, heldTaskId: string, heldStatus: string) {
        super(
            `Member ${member} already holds task ${heldTaskId} in ${heldStatus} state;`
            + ` complete it before claiming another`,
        )
        this.name = "MemberHoldsActiveTaskError"
    }
}

/**
 * Raised by updateTask when opts.expectedOwner is set and the task's current
 * owner does not match — a TOCTOU-safe ownership check inside the update lock.
 */
export class TaskOwnershipError extends Error {
    constructor(taskId: string, actualOwner: string) {
        super(`Task ${taskId} is owned by @${actualOwner}`)
        this.name = "TaskOwnershipError"
    }
}

/**
 * Raised by updateTask when opts.expectedStatus is set and the task's current
 * status does not match — a TOCTOU-safe status check inside the update lock.
 * Used by claimTask to close the window between its optimistic pending-check
 * (outside taskUpdateLock) and the claimed flip.
 */
export class TaskStatusError extends Error {
    constructor(taskId: string, expected: string, actual: string) {
        super(`Task ${taskId} expected status "${expected}" but is "${actual}"`)
        this.name = "TaskStatusError"
    }
}

/**
 * Raised by claimTask when the target task has unresolved blockedBy
 * dependencies — at least one blocker is not yet "completed". Prevents a
 * member from producing output before prerequisite tasks finish.
 */
export class TaskBlockedByError extends Error {
    constructor(taskId: string, blockerId: string, blockerStatus: string) {
        super(
            `Task ${taskId} is blocked by ${blockerId} (currently "${blockerStatus}");`
            + ` wait for the blocker to complete before claiming`,
        )
        this.name = "TaskBlockedByError"
    }
}

/**
 * Canonical task-id shape. Task IDs are always crypto.randomUUID() (see
 * createTask). Exported so the tool layer (task.ts) validates the same shape at
 * the schema boundary — a single source of truth for both layers.
 */
export const TASK_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Defense-in-depth backstop: reject any taskId that is not a canonical UUID
 * before it is path-joined into taskPath/claimLockPath/taskUpdateLockPath. The
 * tool layer already validates task_id via schema, so this only fires if a
 * future or internal caller passes an unsanitized id — preventing "../" from
 * traversing out of the team's tasks directory.
 */
function assertValidTaskId(taskId: string): void {
    if (!TASK_ID_PATTERN.test(taskId)) {
        throw new Error(`Invalid task id: ${JSON.stringify(taskId)}`)
    }
}

/**
 * Minimal top-level schema check for a persisted Task. The `as Task` cast is
 * compile-time only; a corrupt or hand-edited tasks/{id}.json can deserialize to
 * an arbitrary shape. Validate just the identity fields the task list and
 * orchestration immediately depend on; nested/optional fields are not checked.
 */
function isValidTask(value: unknown): value is Task {
    if (typeof value !== "object" || value === null) return false
    const t = value as Record<string, unknown>
    // M16: normalize missing blockedBy to [] instead of accepting undefined.
    // Pre-fix code accepted undefined, but many code paths (delegate,
    // recurse, task list) unconditionally access .length and .every() —
    // a legacy or corrupted task file without blockedBy would crash.
    if (t.blockedBy === undefined) t.blockedBy = []
    return (
        typeof t.id === "string"
        && typeof t.subject === "string"
        && typeof t.status === "string"
        // M-21: reject out-of-enum task statuses.
        && new Set(["pending", "claimed", "in_progress", "completed", "deleted"]).has(t.status as string)
        && Array.isArray(t.blockedBy)
        && t.blockedBy.every(v => typeof v === "string")
        // M-11: validate claimedAt is a finite number when present. A
        // non-numeric claimedAt makes stale-claim computation produce NaN,
        // stranding the task forever (NaN > TTL is always false).
        && (t.claimedAt === undefined || (typeof t.claimedAt === "number" && Number.isFinite(t.claimedAt)))
        // M-11: validate each blockedBy entry is a valid string.
        && t.blockedBy.every(v => typeof v === "string" && v.length > 0 && v.length <= 128
            && TASK_ID_PATTERN.test(v))
        // M-3: cross-field — claimed/in_progress tasks MUST have an owner.
        // A tampered task with status:"in_progress" and no owner would be
        // invisible to reaper (not claimable) and to deadlock detection.
        && ((t.status !== "claimed" && t.status !== "in_progress") || typeof t.owner === "string")
    )
}

/** Read a task file from disk, validate its schema, return null if not found or corrupt. */
async function readTaskFile(teamDirectory: string, taskId: string): Promise<Task | null> {
    try {
        // H12: cap file size and reject symlinks/non-files before reading,
        // matching H11 in readJsonOrNull. Task files are small JSON blobs;
        // a symlinked or tampered file can be unbounded (/dev/zero, FIFO).
        const filePath = taskPath(teamDirectory, taskId)
        const stat = await fs.lstat(filePath)
        if (stat.isSymbolicLink()) return null
        if (!stat.isFile()) return null
        if (stat.size > 65_536) {
            logger.warn("readTaskFile: task file exceeds 64 KiB cap", { taskId, size: stat.size })
            return null
        }
        const raw = await fs.readFile(filePath, "utf8")
        const parsed: unknown = JSON.parse(raw)
        if (!isValidTask(parsed)) {
            // Corrupt / tampered task file: reject so callers take the not-found
            // path (getTask -> null; listAllTasks skips it) instead of trusting
            // the cast and propagating garbage.
            logger.warn("readTaskFile: schema validation failed", { taskId })
            return null
        }
        // Verify the file's internal id matches the filename. A mismatch means
        // the file was corrupted or swapped: trusting the internal id would
        // let a stale file A (containing id="BBB") cause the reaper to reset
        // task B's claim — cross-task corruption.
        if (parsed.id !== taskId) {
            logger.warn("readTaskFile: task id mismatch between filename and file content", {
                filenameTaskId: taskId, contentTaskId: parsed.id,
            })
            return null
        }
        return parsed
    } catch (err: unknown) {
        if (isEnoent(err)) return null
        throw err
    }
}

/** Create a task with an optional preallocated UUID and write it atomically to disk. */
export async function createTask(
    teamDirectory: string,
    input: { id?: string; subject: string; description: string; blockedBy?: string[]; depth?: number },
): Promise<Task> {
    const now = Date.now()
    const id = input.id ?? crypto.randomUUID()
    assertValidTaskId(id)
    const task: Task = {
        version: 1,
        id,
        subject: input.subject,
        description: input.description,
        status: "pending",
        owner: undefined,
        blockedBy: input.blockedBy ?? [],
        createdAt: now,
        updatedAt: now,
        depth: input.depth ?? 0,
    }
    await atomicWrite(taskPath(teamDirectory, task.id), JSON.stringify(task, null, 2), teamDirectory)
    return task
}

/** Read a single task by id, returning null when not found. */
export async function getTask(teamDirectory: string, taskId: string): Promise<Task | null> {
    assertValidTaskId(taskId)
    return readTaskFile(teamDirectory, taskId)
}

/** List every task under the team's tasks directory, optionally rejecting unreadable files. */
export async function listAllTasks(teamDirectory: string, strict = false): Promise<Task[]> {
    let entries: import("node:fs").Dirent[]
    try {
        entries = await fs.readdir(tasksDir(teamDirectory), { withFileTypes: true })
    } catch (err: unknown) {
        if (isEnoent(err)) return []
        throw err
    }
    const ids: string[] = []
    for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".json")) continue
        const id = e.name.replace(/\.json$/, "")
        // Skip malformed names so a stray/non-UUID file (left by a crash or an
        // external tool) cannot abort the whole listing — assertSafeSegment in
        // taskPath would otherwise throw and break claimTask's "no active task"
        // scan and reapStaleClaims for the entire team.
        if (!TASK_ID_PATTERN.test(id)) continue
        ids.push(id)
    }
    const results = await Promise.all(
        ids.map(async id => {
            try {
                return await readTaskFile(teamDirectory, id)
            } catch (err) {
                if (isEnoent(err)) return null
                if (strict) throw err
                // A single corrupt/unreadable task file must not break the listing.
                logger.warn(
                    "listAllTasks: skipping unreadable task",
                    { taskId: id, error: err instanceof Error ? err.message : String(err) },
                )
                return null
            }
        }),
    )
    // M28 fix: in strict mode, schema-invalid tasks (readTaskFile returned
    // null due to validation failure, NOT ENOENT) must also throw. Pre-fix
    // code treated schema-corrupt files the same as missing files, so
    // claimTask's strict scan silently ignored them, potentially bypassing
    // maxTasks and single-active-task invariants. We can't distinguish
    // "file existed but failed schema" from "file was ENOENT" inside
    // readTaskFile without changing its return type, so check the file's
    // existence when strict and result is null.
    if (strict) {
        for (let i = 0; i < ids.length; i++) {
            if (results[i] === null) {
                try {
                    await fs.access(taskPath(teamDirectory, ids[i]))
                    // File exists but readTaskFile returned null → schema corrupt
                    throw new Error(`listAllTasks(strict): task ${ids[i]} exists but failed schema validation`)
                } catch (accessErr) {
                    if (isEnoent(accessErr)) continue // benign race
                    if (accessErr instanceof Error && accessErr.message.includes("schema validation")) throw accessErr
                    // Other access error — already handled by readTaskFile catch
                }
            }
        }
    }
    return results.filter((t): t is Task => t !== null)
}

/**
 * Update task fields. When the new status transitions out of the claim window
 * (in_progress / completed / deleted / pending), the persistent claim lock is removed —
 * "in_progress" is active work and is not reaped, so the lock is no longer
 * needed. "pending" also clears it, supporting recursive re-claim aggregation.
 */
export async function updateTask(
    teamDirectory: string,
    taskId: string,
    patch: Partial<Pick<Task, "status" | "owner" | "blockedBy" | "claimedAt" | "result">>,
    opts: { expectedOwner?: string; expectedStatus?: TaskStatus; expectedClaimedAt?: number } = {},
): Promise<Task> {
    assertValidTaskId(taskId)
    // Serialize the read-modify-write against concurrent updateTask calls (e.g.
    // a member's team_task_update racing the sweep timer's reapStaleClaims) so a
    // later writer cannot clobber an interleaved update (lost-update race).
    return withLock(taskUpdateLockPath(teamDirectory, taskId), async () => {
        const task = await readTaskFile(teamDirectory, taskId)
        if (!task) throw new Error(`updateTask: task ${taskId} not found`)
        // TOCTOU-safe ownership check: expectedOwner is verified inside the lock
        // so a racing owner change cannot let a non-owner slip through.
        if (opts.expectedOwner !== undefined && task.owner !== opts.expectedOwner) {
            throw new TaskOwnershipError(taskId, task.owner ?? "unassigned")
        }
        // TOCTOU-safe status check: expectedStatus is verified inside the lock
        // so a racing team_task_update (delete/complete) between claimTask's
        // optimistic status check (outside this lock) and here cannot resurrect
        // a terminal task as "claimed".
        if (opts.expectedStatus !== undefined && task.status !== opts.expectedStatus) {
            throw new TaskStatusError(taskId, opts.expectedStatus, task.status)
        }
        // H-21: TOCTOU-safe claimedAt check. The stale-claim reaper reads a
        // task's claimedAt, determines it is stale, then calls updateTask to
        // reset it. Between the read and the write, the original owner may
        // have re-claimed with a NEW claimedAt (the old lock was reaped
        // inline by claimTask, the member re-claimed with a fresh lock).
        // Without this check, the reaper's expectedStatus:"claimed" CAS would
        // match the NEW claim and destroy it. Comparing claimedAt ensures the
        // reaper only resets the EXACT claim it determined was stale.
        if (opts.expectedClaimedAt !== undefined && task.claimedAt !== opts.expectedClaimedAt) {
            throw new TaskStatusError(taskId, "claimed (same claimedAt)", `claimed (different claimedAt: ${task.claimedAt})`)
        }
        // H-18: status transition matrix. Terminal statuses (completed, deleted)
        // cannot be revived to active statuses (pending, claimed, in_progress).
        // Pre-fix code used Object.assign which allowed any transition — a
        // caller could flip a completed task back to in_progress, bypassing
        // the live-task limit and confusing dependents that already saw it as
        // done. The recurse internal path (claimed→pending for re-aggregation)
        // is allowed via the explicit `pending` target.
        if (patch.status !== undefined && patch.status !== task.status) {
            const TERMINAL = new Set<TaskStatus>(["completed", "deleted"])
            const ACTIVE = new Set<TaskStatus>(["pending", "claimed", "in_progress"])
            if (TERMINAL.has(task.status) && ACTIVE.has(patch.status)) {
                throw new Error(
                    `updateTask: cannot revive terminal task ${taskId} from "${task.status}" to "${patch.status}"`,
                )
            }
            if (patch.status === "in_progress" && task.status !== "claimed" && patch.owner === undefined) {
                throw new Error(
                    `updateTask: transition from "${task.status}" to "in_progress" requires an owner`,
                )
            }
        }
        Object.assign(task, patch, { updatedAt: Date.now() })
        await atomicWrite(taskPath(teamDirectory, taskId), JSON.stringify(task, null, 2), teamDirectory)
        // Clean up the persistent claim lock once the task leaves the claim window.
        if (
            patch.status === "in_progress"
            || patch.status === "completed"
            || patch.status === "deleted"
            || patch.status === "pending"
        ) {
            await fs.unlink(claimLockPath(teamDirectory, taskId)).catch((err: unknown) => {
                // M13: ENOENT is benign (no lock to clean). Non-ENOENT errors
                // leave an orphaned claim lock that the stale-claim reaper will
                // eventually clean up, but log so the orphan is observable.
                if (!isEnoent(err)) {
                    logger.warn("updateTask: claim lock unlink failed (orphan; reaper will clean)", {
                        taskId, error: err instanceof Error ? err.message : String(err),
                    })
                }
            })
        }
        return task
    }, teamDirectory)
}

/**
 * Try to create a claim lock file exclusively (O_CREAT|O_EXCL). Returns true on
 * success, false on EEXIST (another process holds the lock). Any other error
 * is thrown. On write failure the lock is rolled back (best-effort unlink).
 */
async function tryCreateClaimLock(lockPath: string, owner: string): Promise<boolean> {
    try {
        const fh = await fs.open(lockPath, "wx")
        try {
            await fh.writeFile(owner)
        } catch (writeErr) {
            // Write failed: close handle, unlink the incomplete lock.
            try { await fh.close() } catch { /* best-effort */ }
            await fs.unlink(lockPath).catch(() => { /* best-effort rollback */ })
            throw writeErr
        }
        // M17: close after successful write. If close fails, the lock
        // file is on disk without a live fd → permanent orphan. Unlink
        // and re-throw. Pre-fix code had close() in finally without error
        // handling, silently leaving the orphan.
        try {
            await fh.close()
        } catch (closeErr) {
            await fs.unlink(lockPath).catch(() => { /* best-effort */ })
            throw closeErr
        }
        return true
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
        return false
    }
}

/**
 * Atomically claim a pending task: acquire the persistent claim lock
 * (fs.open 'wx'), double-check status === "pending", then flip to "claimed".
 * Throws TaskAlreadyClaimedError if another member holds a fresh lock or the
 * task is not pending. Throws MemberHoldsActiveTaskError if `owner` already
 * holds another task in the "claimed" or "in_progress" window — this enforces
 * the claim → complete → idle → claim-next workflow (one active task per
 * member at a time).
 */
export async function claimTask(
    teamDirectory: string,
    taskId: string,
    owner: string,
): Promise<Task> {
    assertValidTaskId(taskId)
    // C-6: claimsDir mkdir happens before withLock; guard its ancestor chain
    // so a symlinked <team>/tasks or <team> cannot redirect the recursive
    // mkdir to an external location. The subsequent withLock(claimMutexPath)
    // re-verifies its own lockPath ancestor chain.
    await assertNoSymlinkTraversal(teamDirectory, claimsDir(teamDirectory))
    await fs.mkdir(claimsDir(teamDirectory), { recursive: true }).catch(() => {
        // may exist
    })

    // Team-level mutex serializes the ownership-check + claim critical section
    // across all callers so two concurrent claims by the same member cannot
    // both pass the "no active task" check (TOCTOU). Claim is not a hot path,
    // so a single team-wide mutex is acceptable.
    return withLock(claimMutexPath(teamDirectory), async () => {
        // 0. Per-member concurrency cap (1): reject if this owner already
        // holds a task in the "claimed" or "in_progress" window.
        const allTasks = await listAllTasks(teamDirectory, true)
        const held = allTasks.find(
            t =>
                t.owner === owner
                && (t.status === "claimed" || t.status === "in_progress"),
        )
        if (held) {
            throw new MemberHoldsActiveTaskError(owner, held.id, held.status)
        }

        const lockPath = claimLockPath(teamDirectory, taskId)

        // 1. Acquire the persistent claim lock (reap stale entries inline).
        if (!await tryCreateClaimLock(lockPath, owner)) {
            if (await lockFresh(lockPath, CLAIM_TTL_MS)) {
                throw new TaskAlreadyClaimedError(taskId)
            }
            // Stale lock — reap and retry once.
            await fs.unlink(lockPath).catch(() => {
                // raced
            })
            if (!await tryCreateClaimLock(lockPath, owner)) {
                throw new TaskAlreadyClaimedError(taskId)
            }
        }

            // 2. Optimistic pending-check under claimMutex (clear error for the
            // common "already claimed / not pending" case + handles !task).
            const task = await readTaskFile(teamDirectory, taskId)
            if (!task || task.status !== "pending") {
                await fs.unlink(lockPath).catch(() => {
                    // release our lock since we are not claiming
                })
                throw new TaskAlreadyClaimedError(taskId)
            }
            // 2b. blockedBy check: a task with unresolved blockers must NOT be
            // claimable. Without this, a member could claim a task whose
            // dependencies are still pending/in_progress, producing output
            // before the prerequisite tasks complete and leaving the
            // dependency chain in an inconsistent state.
            if (task.blockedBy && task.blockedBy.length > 0) {
                const blockers = await Promise.all(
                    task.blockedBy.map(id => readTaskFile(teamDirectory, id)),
                )
                // A blocker that is null (missing/corrupt file) must BLOCK the
                // claim — we cannot verify it completed. A deleted blocker is
                // treated as resolved (no longer relevant).
                const incomplete = blockers.find(b =>
                    b === null || (b !== null && b.status !== "completed" && b.status !== "deleted"),
                )
                // H-20: use `!== undefined` (not truthy) because find() returns
                // `null` when a missing blocker matched — `if (null)` is falsy
                // and would silently skip the guard, letting a member claim a
                // task whose dependency file is missing/corrupt.
                if (incomplete !== undefined) {
                    await fs.unlink(lockPath).catch(() => {
                        // release our lock since we are not claiming
                    })
                    if (incomplete === null) {
                        throw new TaskBlockedByError(taskId, "unknown", "missing")
                    }
                    throw new TaskBlockedByError(taskId, incomplete.id, incomplete.status)
                }
            }
        // 3. Flip to "claimed" under taskUpdateLock with a TOCTOU-safe
        // expectedStatus check. The optimistic check above is NOT under
        // taskUpdateLock; this closes the narrow window where a concurrent
        // team_task_update (delete/complete) flips the status between the check
        // above and this write (resurrecting a terminal task as "claimed").
        try {
            const updated = await updateTask(teamDirectory, taskId, {
                status: "claimed",
                owner,
                claimedAt: Date.now(),
            }, { expectedStatus: "pending" })
            return updated
        } catch (err) {
            // M-CLAIM: release the claim lock on ANY failure, not just
            // TaskStatusError. Pre-fix code only unlinked on
            // TaskStatusError; a non-TaskStatusError (I/O, ENOSPC) would
            // leave an orphaned claim lock blocking future claims until TTL.
            await fs.unlink(lockPath).catch(() => {
                // best-effort: stale-claim reaper will eventually clean
            })
            if (err instanceof TaskStatusError) {
                throw new TaskAlreadyClaimedError(taskId)
            }
            throw err
        }
    }, teamDirectory)
}

/**
 * Pure decision: is a claim stale? A claim is stale iff the lock is NOT fresh
 * AND the claimedAt age strictly exceeds the TTL (age == ttl is NOT stale).
 * All IO (lockFresh, Date.now) is resolved by the caller and passed in.
 */
export function isClaimStale(fresh: boolean, claimedAt: number, now: number, ttl: number): boolean {
    return !fresh && now - claimedAt > ttl
}

/**
 * Reconcile stale claims (run by the sweep timer). For every task in "claimed"
 * status whose claim lock is stale AND whose claimedAt exceeds CLAIM_TTL, reset
 * to "pending" so another member can pick it up. Fixes the limbo where a crash
 * left a stale lock + status="claimed".
 */
export async function reapStaleClaims(teamDirectory: string): Promise<void> {
    const tasks = await listAllTasks(teamDirectory)
    for (const task of tasks) {
        if (task.status !== "claimed") continue
        const fresh = await lockFresh(claimLockPath(teamDirectory, task.id), CLAIM_TTL_MS)
        if (isClaimStale(fresh, task.claimedAt ?? 0, Date.now(), CLAIM_TTL_MS)) {
            try {
                await updateTask(teamDirectory, task.id, {
                    status: "pending",
                    owner: undefined,
                }, { expectedStatus: "claimed", expectedClaimedAt: task.claimedAt })
            } catch (err) {
                // Task transitioned out of "claimed" (e.g. owner moved to "in_progress")
                // between our stale check and the update — do NOT clobber the new status.
                if (err instanceof TaskStatusError) continue
                throw err
            }
        }
    }
}

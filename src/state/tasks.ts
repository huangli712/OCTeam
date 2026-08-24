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

import type {
    Task,
    TaskStatus
} from "../core/types.js"
import { logger } from '../core/log.js';
import { isEnoent } from '../core/utils.js';
//
import {
    assertNoSymlinkTraversal,
    CLAIM_TTL_MS,
    atomicWrite,
    lockFresh,
    withLock
} from "./locks.js"
import {
    claimLockPath,
    claimMutexPath,
    claimsDir,
    taskPath,
    tasksDir,
    taskUpdateLockPath
} from "./paths.js"

/**
 * Canonical task-id shape. Task IDs are crypto.randomUUID() by default; a
 * caller may supply an explicit input.id, which must still match this pattern
 * (see createTask). Exported so the tool layer (task.ts) validates the same
 * shape at the schema boundary — a single source of truth for both layers.
 */
export const TASK_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Raised by claimTask when the calling member already holds another task in
 * the "claimed" or "in_progress" window (one active task per member; member
 * idle status is not part of this check).
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

/** Error thrown when a task is already claimed or not in claimable state. */
export class TaskAlreadyClaimedError extends Error {
    constructor(taskId: string) {
        super(`Task ${taskId} is already claimed or not claimable`)
        this.name = "TaskAlreadyClaimedError"
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
 * dependencies — at least one blocker is neither "completed" nor "deleted".
 * Prevents a member from producing output before prerequisite tasks finish.
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
 * Pure decision: is a claim stale? A claim is stale iff the lock is NOT fresh
 * AND the claimedAt age strictly exceeds the TTL (age == ttl is NOT stale).
 * All IO (lockFresh, Date.now) is resolved by the caller and passed in.
 */
export function isClaimStale(
    fresh: boolean,
    claimedAt: number,
    now: number,
    ttl: number,
): boolean {
    return !fresh && now - claimedAt > ttl
}

/**
 * Minimal top-level schema check for a persisted Task. The `as Task` cast is
 * compile-time only; a corrupt or hand-edited tasks/{id}.json can deserialize to
 * an arbitrary shape. Validates the fields the task list and orchestration
 * immediately depend on (id, subject, status enum, runId, blockedBy entries,
 * claimedAt, and the claimed/in_progress owner cross-rule); deeply nested
 * payloads beyond those are not checked.
 */
function isValidTask(value: unknown): value is Task {
    if (typeof value !== "object" || value === null) return false
    const t = value as Record<string, unknown>
    // Normalize missing blockedBy to [] because delegate, recurse, and task
    // listing unconditionally access .length and .every().
    if (t.blockedBy === undefined) t.blockedBy = []
    return (
        typeof t.id === "string"
        && (t.runId === undefined || (typeof t.runId === "string" && t.runId.length > 0 && t.runId.length <= 128))
        && typeof t.subject === "string"
        && typeof t.status === "string"
        // Reject out-of-enum task statuses.
        && new Set(["pending", "claimed", "in_progress", "completed", "deleted"]).has(t.status as string)
        && Array.isArray(t.blockedBy)
        && t.blockedBy.every(v => typeof v === "string")
        // Validate claimedAt as a finite number when present. A
        // non-numeric claimedAt makes stale-claim computation produce NaN,
        // stranding the task forever (NaN > TTL is always false).
        && (t.claimedAt === undefined || (typeof t.claimedAt === "number" && Number.isFinite(t.claimedAt)))
        // Validate each blockedBy entry as a valid task id.
        && t.blockedBy.every(v => typeof v === "string" && v.length > 0 && v.length <= 128
            && TASK_ID_PATTERN.test(v))
        // Cross-field rule: claimed and in-progress tasks MUST have an owner.
        // A tampered task with status:"in_progress" and no owner would be
        // invisible to reaper (not claimable) and to deadlock detection.
        && ((t.status !== "claimed" && t.status !== "in_progress") || typeof t.owner === "string")
    )
}

/** Read a task file from disk and validate its schema. Returns null when the
 * file is absent, non-regular, over the 64 KiB cap, or schema-invalid;
 * unparsable JSON rejects instead (only ENOENT maps to null in the catch). */
async function readTaskFile(teamDirectory: string, taskId: string): Promise<Task | null> {
    try {
        // Cap file size and reject symlinks/non-files before reading. Task files
        // are small JSON blobs, but a symlinked or tampered file can be unbounded.
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
    input: {
        id?: string
        runId?: string
        subject: string
        description: string
        blockedBy?: string[]
        depth?: number
    },
): Promise<Task> {
    const now = Date.now()
    const id = input.id ?? crypto.randomUUID()
    assertValidTaskId(id)
    const task: Task = {
        version: 1,
        id,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
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

/**
 * Claim a pending task: acquire the persistent claim lock (fs.open 'wx'),
 * double-check status === "pending", then flip to "claimed" (the lock creation
 * and the task-state write are separate steps — a crash between them leaves a
 * pending task plus a claim lock that the stale-lock reaper cleans up).
 * Throws TaskAlreadyClaimedError if another member holds a fresh lock or the
 * task is not pending. Throws MemberHoldsActiveTaskError if `owner` already
 * holds another task in the "claimed" or "in_progress" window (one active
 * task per member at a time; member idle status is not checked here).
 * `claimMutexHeld` is reserved for callers that already hold claimMutexPath
 * across a larger check-and-claim critical section.
 */
export async function claimTask(
    teamDirectory: string,
    taskId: string,
    owner: string,
    options: { readonly claimMutexHeld?: boolean } = {},
): Promise<Task> {
    assertValidTaskId(taskId)
    // claimsDir mkdir happens before withLock. Guard its ancestor chain so a
    // symlinked <team>/tasks or <team> cannot redirect the recursive
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
    const runClaim = async (): Promise<Task> => {
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
                // Use `!== undefined` (not truthy) because find() returns
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
            // Release the claim lock on ANY failure. An I/O or ENOSPC failure
            // would otherwise leave an orphaned lock blocking claims until TTL.
            await fs.unlink(lockPath).catch(() => {
                // best-effort: stale-claim reaper will eventually clean
            })
            if (err instanceof TaskStatusError) {
                throw new TaskAlreadyClaimedError(taskId)
            }
            throw err
        }
    }
    if (options.claimMutexHeld) return runClaim()
    return withLock(claimMutexPath(teamDirectory), runClaim, teamDirectory)
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
        // Use a TOCTOU-safe claimedAt check. The stale-claim reaper reads a
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
        // Enforce the status transition matrix. A `deleted` task admits no status
        // change at all; a `completed` task cannot be revived to an active status
        // (pending, claimed, in_progress) but may still be marked deleted.
        // The recurse internal path from claimed to pending remains available
        // through the explicit `pending` target.
        if (patch.status !== undefined && patch.status !== task.status) {
            const ACTIVE = new Set<TaskStatus>(["pending", "claimed", "in_progress"])
            if (task.status === "deleted" || (task.status === "completed" && ACTIVE.has(patch.status))) {
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
        // Enforce the 60,000-byte result limit to keep the task file under
        // the reader's 64 KiB whole-file cap.
        if (patch.result !== undefined && typeof patch.result === "string"
            && Buffer.byteLength(patch.result, "utf8") > 60_000) {
            // Truncate by UTF-8 bytes, not UTF-16 code units.
            // reader limits the entire JSON file to 65536 bytes, so we need
            // to leave room for JSON overhead + marker.
            const MAX_RESULT_BYTES = 60_000 // leave ~5KiB for JSON + other fields
            if (Buffer.byteLength(patch.result, "utf8") > MAX_RESULT_BYTES) {
                const marker = "\n[...result truncated]"
                // Truncate from the start to fit MAX_RESULT_BYTES - marker.
                let cutLen = MAX_RESULT_BYTES - Buffer.byteLength(marker, "utf8")
                let truncated = ""
                for (let i = 0; i < patch.result.length && cutLen > 0; i++) {
                    const charBytes = Buffer.byteLength(patch.result[i]!, "utf8")
                    if (charBytes > cutLen) break
                    truncated += patch.result[i]
                    cutLen -= charBytes
                }
                patch.result = truncated + marker
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
                // ENOENT is benign (no lock to clean). Non-ENOENT errors
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
    // Use bounded concurrency to prevent unbounded file descriptor / memory
    // consumption when a team has many tasks (up to 10,000).
    const BATCH_SIZE = 50
    const results: (Task | null)[] = []
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE)
        const batchResults = await Promise.all(
            batch.map(async id => {
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
        results.push(...batchResults)
    }
    // In strict mode, schema-invalid tasks (readTaskFile returned null due to
    // validation failure, NOT ENOENT) must also throw. Treating them as missing
    // could bypass maxTasks and single-active-task invariants. We can't distinguish
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
        // Close after a successful write. If close fails, the lock file is on
        // disk without a live fd and becomes a permanent orphan. Unlink and
        // rethrow the error.
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
 * Reconcile stale claims (run by the sweep timer). For every task in "claimed"
 * status whose claim lock is stale AND whose claimedAt exceeds CLAIM_TTL, reset
 * to "pending" so another member can pick it up after a crash leaves a stale
 * lock with status="claimed".
 *
 * opts.protectOwners: claims held by members in this set are NOT reaped. The
 * sweep passes the set of members whose sessions are actively running — a
 * multi-minute aggregation turn legitimately exceeds CLAIM_TTL while its
 * owner is still mid-turn, and reaping it orphans the turn's output (the E4
 * defect: the idle handler then finds no claimed task and the aggregation
 * loops until stall/timeout).
 */
export async function reapStaleClaims(
    teamDirectory: string,
    opts: { protectOwners?: ReadonlySet<string> } = {},
): Promise<void> {
    const tasks = await listAllTasks(teamDirectory)
    for (const task of tasks) {
        if (task.status !== "claimed") continue
        if (opts.protectOwners?.has(task.owner ?? "")) continue
        const fresh = await lockFresh(claimLockPath(teamDirectory, task.id), CLAIM_TTL_MS)
        if (isClaimStale(fresh, task.claimedAt ?? 0, Date.now(), CLAIM_TTL_MS)) {
            try {
                await updateTask(teamDirectory, task.id, {
                    status: "pending",
                    owner: undefined,
                    // Clear claimedAt on reaper reset so stale claim
                    // metadata doesn't persist on a pending task.
                    claimedAt: undefined,
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

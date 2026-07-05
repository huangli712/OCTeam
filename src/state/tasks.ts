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

import { CLAIM_TTL_MS, atomicWrite, lockFresh, withLock } from "./locks.js"
import { claimLockPath, claimMutexPath, claimsDir, taskPath, tasksDir, taskUpdateLockPath } from "./paths.js"
import type { Task, TaskStatus } from "../core/types.js"

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
            `Member ${member} already holds task ${heldTaskId} in ${heldStatus} state; complete it before claiming another`,
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
    return (
        typeof t.id === "string"
        && typeof t.subject === "string"
        && typeof t.status === "string"
        && (t.blockedBy === undefined || (
            Array.isArray(t.blockedBy)
            && t.blockedBy.every(v => typeof v === "string")
        ))
    )
}

async function readTaskFile(teamDirectory: string, taskId: string): Promise<Task | null> {
    try {
        const raw = await fs.readFile(taskPath(teamDirectory, taskId), "utf8")
        const parsed: unknown = JSON.parse(raw)
        if (!isValidTask(parsed)) {
            // Corrupt / tampered task file: reject so callers take the not-found
            // path (getTask -> null; listAllTasks skips it) instead of trusting
            // the cast and propagating garbage.
            console.warn(`[octeam] readTaskFile: schema validation failed for task ${taskId}`)
            return null
        }
        return parsed
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
        throw err
    }
}

export async function createTask(
    teamDirectory: string,
    input: { subject: string; description: string; blockedBy?: string[]; depth?: number },
): Promise<Task> {
    const now = Date.now()
    const task: Task = {
        version: 1,
        id: crypto.randomUUID(),
        subject: input.subject,
        description: input.description,
        status: "pending",
        owner: undefined,
        blockedBy: input.blockedBy ?? [],
        createdAt: now,
        updatedAt: now,
        depth: input.depth ?? 0,
    }
    await atomicWrite(taskPath(teamDirectory, task.id), JSON.stringify(task, null, 2))
    return task
}

export async function getTask(teamDirectory: string, taskId: string): Promise<Task | null> {
    assertValidTaskId(taskId)
    return readTaskFile(teamDirectory, taskId)
}

export async function listAllTasks(teamDirectory: string): Promise<Task[]> {
    let entries: import("node:fs").Dirent[]
    try {
        entries = await fs.readdir(tasksDir(teamDirectory), { withFileTypes: true })
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
        throw err
    }
    const tasks: Task[] = []
    for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".json")) continue
        const id = e.name.replace(/\.json$/, "")
        // Skip malformed names so a stray/non-UUID file (left by a crash or an
        // external tool) cannot abort the whole listing — assertSafeSegment in
        // taskPath would otherwise throw and break claimTask's "no active task"
        // scan and reapStaleClaims for the entire team.
        if (!TASK_ID_PATTERN.test(id)) continue
        try {
            const t = await readTaskFile(teamDirectory, id)
            if (t) tasks.push(t)
        } catch (err) {
            // A single corrupt/unreadable task file must not break the listing.
            console.warn(`[octeam] listAllTasks: skipping unreadable task ${id}:`, err)
        }
    }
    return tasks
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
    opts: { expectedOwner?: string; expectedStatus?: TaskStatus } = {},
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
        Object.assign(task, patch, { updatedAt: Date.now() })
        await atomicWrite(taskPath(teamDirectory, taskId), JSON.stringify(task, null, 2))
        // Clean up the persistent claim lock once the task leaves the claim window.
        if (
            patch.status === "in_progress"
            || patch.status === "completed"
            || patch.status === "deleted"
            || patch.status === "pending"
        ) {
            await fs.unlink(claimLockPath(teamDirectory, taskId)).catch(() => {
                // no lock to clean
            })
        }
        return task
    })
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
        const allTasks = await listAllTasks(teamDirectory)
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
        try {
            const fh = await fs.open(lockPath, "wx")
            try {
                await fh.writeFile(owner)
            } catch (err) {
                await fs.unlink(lockPath).catch(() => { /* best-effort rollback */ })
                throw err
            } finally {
                await fh.close()
            }
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
            if (await lockFresh(lockPath, CLAIM_TTL_MS)) {
                throw new TaskAlreadyClaimedError(taskId)
            }
            // Stale lock — reap and retry once.
            await fs.unlink(lockPath).catch(() => {
                // raced
            })
            try {
                const fh = await fs.open(lockPath, "wx")
                try {
                    await fh.writeFile(owner)
                } catch (err) {
                    await fs.unlink(lockPath).catch(() => { /* best-effort rollback */ })
                    throw err
                } finally {
                    await fh.close()
                }
            } catch (err: unknown) {
                if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
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
            if (err instanceof TaskStatusError) {
                await fs.unlink(lockPath).catch(() => {
                    // release our lock since we are not claiming
                })
                throw new TaskAlreadyClaimedError(taskId)
            }
            throw err
        }
    })
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
            await updateTask(teamDirectory, task.id, {
                status: "pending",
                owner: undefined,
            })
        }
    }
}

export type { TaskStatus }

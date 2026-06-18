/**
 * Shared task list for collaborative coordination (design §4.7, §3).
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
import path from "node:path"
import crypto from "node:crypto"

import { CLAIM_TTL_MS, atomicWrite, lockFresh, withLock } from "./state/locks.js"
import { claimLockPath, claimsDir, taskPath, tasksDir, taskUpdateLockPath } from "./state/paths.js"
import type { Task, TaskStatus } from "./types.js"

export class TaskAlreadyClaimedError extends Error {
    constructor(taskId: string) {
        super(`Task ${taskId} is already claimed or not claimable`)
        this.name = "TaskAlreadyClaimedError"
    }
}

async function readTaskFile(teamDirectory: string, taskId: string): Promise<Task | null> {
    try {
        const raw = await fs.readFile(taskPath(teamDirectory, taskId), "utf8")
        return JSON.parse(raw) as Task
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
        throw err
    }
}

export async function createTask(
    teamDirectory: string,
    input: { subject: string; description: string; blockedBy?: string[] },
): Promise<Task> {
    const now = Date.now()
    const task: Task = {
        version: 1,
        id: crypto.randomUUID(),
        subject: input.subject,
        description: input.description,
        status: "pending",
        owner: undefined,
        blocks: [],
        blockedBy: input.blockedBy ?? [],
        createdAt: now,
        updatedAt: now,
    }
    await atomicWrite(taskPath(teamDirectory, task.id), JSON.stringify(task, null, 2))
    return task
}

export async function getTask(teamDirectory: string, taskId: string): Promise<Task | null> {
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
        const t = await readTaskFile(teamDirectory, e.name.replace(/\.json$/, ""))
        if (t) tasks.push(t)
    }
    return tasks
}

/**
 * Update task fields. When the new status transitions out of the claim window
 * (in_progress / completed / deleted), the persistent claim lock is removed —
 * "in_progress" is active work and is not reaped, so the lock is no longer
 * needed.
 */
export async function updateTask(
    teamDirectory: string,
    taskId: string,
    patch: Partial<Pick<Task, "status" | "owner" | "blockedBy" | "blocks" | "claimedAt">>,
): Promise<Task> {
    // Serialize the read-modify-write against concurrent updateTask calls (e.g.
    // a member's team_task_update racing the sweep timer's reapStaleClaims) so a
    // later writer cannot clobber an interleaved update (lost-update race).
    return withLock(taskUpdateLockPath(teamDirectory, taskId), async () => {
        const task = await readTaskFile(teamDirectory, taskId)
        if (!task) throw new Error(`updateTask: task ${taskId} not found`)
        Object.assign(task, patch, { updatedAt: Date.now() })
        await atomicWrite(taskPath(teamDirectory, taskId), JSON.stringify(task, null, 2))
        // Clean up the persistent claim lock once the task leaves the claim window.
        if (
            patch.status === "in_progress"
            || patch.status === "completed"
            || patch.status === "deleted"
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
 * task is not pending.
 */
export async function claimTask(
    teamDirectory: string,
    taskId: string,
    owner: string,
): Promise<Task> {
    const lockPath = claimLockPath(teamDirectory, taskId)
    await fs.mkdir(claimsDir(teamDirectory), { recursive: true }).catch(() => {
        // may exist
    })

    // 1. Acquire the persistent claim lock (reap stale entries inline).
    try {
        const fh = await fs.open(lockPath, "wx")
        await fh.writeFile(owner)
        await fh.close()
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
            await fh.writeFile(owner)
            await fh.close()
        } catch {
            throw new TaskAlreadyClaimedError(taskId)
        }
    }

    // 2. Double-check status under the lock; flip to "claimed".
    const task = await readTaskFile(teamDirectory, taskId)
    if (!task || task.status !== "pending") {
        await fs.unlink(lockPath).catch(() => {
            // release our lock since we are not claiming
        })
        throw new TaskAlreadyClaimedError(taskId)
    }
    const updated = await updateTask(teamDirectory, taskId, {
        status: "claimed",
        owner,
        claimedAt: Date.now(),
    })
    return updated
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
        const aged = Date.now() - (task.claimedAt ?? 0) > CLAIM_TTL_MS
        if (!fresh && aged) {
            await updateTask(teamDirectory, task.id, {
                status: "pending",
                owner: undefined,
            })
        }
    }
}

export type { TaskStatus }

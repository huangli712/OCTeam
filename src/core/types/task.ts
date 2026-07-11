/**
 * Shared cooperative tasklist item (Task) — used by delegate mode, persisted
 * to tasks/*.json, has blockedBy DAG deps.
 *
 * Layer 0 in the types decomposition — no imports.
 *
 * ActiveTask (the orchestration runtime state machine) and supporting
 * orchestration types live in orchestration.ts.
 */

/** Shared tasklist item status: pending, claimed, in_progress, completed, or deleted. */
export type TaskStatus = "pending" | "claimed" | "in_progress" | "completed" | "deleted"

/** A task in the shared cooperative tasklist with optional blockedBy dependencies. */
export type Task = {
    version: 1
    id: string                         // UUID
    subject: string
    description: string
    status: TaskStatus
    owner?: string                     // member name who claimed
    blockedBy: string[]                // task IDs that must complete first
    createdAt: number
    updatedAt: number
    claimedAt?: number
    depth?: number                     // recursion level (root = 0; child = parent + 1)
    result?: string                    // completed-task output (read by aggregating parents)
}

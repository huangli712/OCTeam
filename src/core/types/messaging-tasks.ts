/**
 * Shared task list item (Task) and file mailbox entry (Message) type definitions.
 *
 * Layer 0 in the types decomposition — no imports from other type files.
 * Both types are JSON-serializable (persisted to disk) and used by the
 * cooperative task list (tasks/*.json) and messaging layer (mailbox/*.jsonl).
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

/** A file mailbox entry — a message, announcement, or directive between members. */
export type Message = {
    version: 1
    id: string                         // UUID
    from: string                       // sender member name, or "orchestrator"
    to: string                         // recipient member name, or "*" for broadcast
    kind: "message" | "announcement" | "directive"
    body: string                       // max 32KB
    summary?: string                   // one-line summary for status display
    timestamp: number
    correlationId?: string             // UUID for request-response pairing
    runId?: string                     // per-orchestration run id for directive messages
    deliveryStatus: "pending" | "delivered" | "processed"
}

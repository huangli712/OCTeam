/**
 * OCTeam data model types (design doc Section 2).
 *
 * All types in this file are JSON-serializable — they are persisted to disk
 * (config.json / state.json / mailbox *.jsonl / tasks/*.json). Runtime-only
 * constructs that carry non-serializable handles (e.g. the Team wrapper with
 * its in-process mutex) live in state/store.ts, NOT here.
 */

// --- TeamSpec (immutable, declarative) — stored as config.json ---

export type TeamSpec = {
    version: 1
    name: string                        // /^[a-z0-9-]+$/, unique within scope
    description?: string
    createdAt: number                   // epoch ms
    members: MemberSpec[]           // 1-8 members
}

export type MemberSpec = {
    name: string                        // unique within team
    role: string                        // role description for system prompt
    model?: string                      // model identifier, e.g. "claude-sonnet"
    agent?: string                      // OpenCode agent type, default "build"
    worktree?: boolean                  // create isolated git worktree, default false
}

// --- TeamState (mutable, persisted) — stored as state.json ---

export type TeamStatus =
    | "live"        // config written, no sessions spawned yet
    | "busy"        // sessions spawned, workflow running
    | "idle"        // sessions spawned, idle (workflow completed)
    | "failed"      // agent error or task incomplete (e.g. loop max rounds w/o done)

export type MemberStatus =
    | "pending"             // session not yet created
    | "running"             // actively processing a prompt
    | "idle"                // finished, awaiting work
    | "errored"             // LLM/tool failure

export type MemberState = {
    name: string
    sessionId?: string                 // set after session.create succeeds
    model?: string
    agent?: string
    status: MemberStatus
    initialized: boolean               // true after role-setup prompt completes (B3)
    worktreePath?: string              // absolute path to git worktree
    turnCount: number                  // incremented per promptAsync dispatch
    lastTurnMarker?: string            // Transform hook injection dedup
    lastNotifiedAt?: number            // delegate: rate-limit re-prompts
    retryingSince?: number             // epoch ms when session entered "retry"
    error?: string                     // if status === "errored"
    isMaster?: boolean                 // ONLY on synthetic master record; never persisted
    declaredDone?: boolean             // require_done_ack: member has called team_done() this run
}

export type TeamState = {
    version: 1
    teamRunId: string                  // UUID, unique per run
    teamName: string
    status: TeamStatus
    leadSessionId: string              // always context.sessionID; leader name is "master"
    members: MemberState[]
    activeTask?: ActiveTask            // only one active orchestration at a time
    lastMode?: LastModeRecord          // most recent orchestration mode (survives activeTask cleanup)
    bounds: Bounds                     // resource limits (Section 8)
    createdAt: number
    startedAt?: number                 // when first task started
    activatedAt?: number               // epoch ms; presence ⇒ "available" team for its
                                       // leadSessionId. INVARIANT: ≤1 team per leadSessionId
                                       // has this set, enforced by team_activate (deactivates
                                       // sibling) + startup reconcile (keeps latest on >1
                                       // violation). Orthogonal to TeamStatus lifecycle.
}

// --- Bounds (resource limits, Section 8) ---

export type Bounds = {
    maxMembers: number                 // default 8, hard cap
    maxParallelMembers: number         // default 4, concurrent spawn limit
    maxMessagesPerRun: number          // default 100, total messages per orchestration
    maxWallClockMinutes: number        // default 30, hard wall-clock limit
    maxMemberTurns: number             // default 50, turns per member per orchestration
    maxTasks: number                   // default 200, max live tasks in the shared tasklist
    messagePayloadMaxBytes: number     // default 32768 (32KB)
    messageUnreadMaxBytes: number      // default 1048576 (1MB), backpressure limit
}

// --- ActiveTask ---

export type OrchestrationType = "parallel" | "pipeline" | "loop" | "delegate" | "consensus"
export type ParallelMode = "isolated" | "collaborative"
export type ReducePolicy = "summarize" | "select" | "merge" | "rubric"
export type SignoffPolicy = "none" | "decider" | "peer-quorum"

export type ActiveTask = {
    type: OrchestrationType
    mode?: ParallelMode                // parallel only
    startedAt: number
    wallClockTimeoutMs: number         // hard timeout, default 300000 (5 min)
    tokenBudget?: number               // optional cost cap
    tokensUsed: number                 // running total = sum of tokensByMember (recomputed)
    tokensByMember: Record<string, number>  // memberName -> sum(input+output+reasoning)
    messagesSent: number               // total team_send_message writes this run (§8.1 maxMessagesPerRun)

    // result collection (serializable — NOT a Map)
    responses: Record<string, string>  // memberName -> last assistant text output

    // parallel mode
    task?: string                      // isolated: uniform task
    tasks?: Record<string, string>     // collaborative: per-member tasks
    topic?: string                     // consensus: debate topic
    maxRounds?: number                 // consensus / loop: round limit
    currentRound?: number

    // reduce policy (parallel isolated/collaborative only)
    reducePolicy?: ReducePolicy
    reduceRubric?: string              // when reducePolicy === "rubric"

    // signoff policy (parallel isolated/collaborative, pipeline, delegate; NOT loop)
    signoffPolicy?: SignoffPolicy
    signoffDecider?: string              // member name (decider mode)
    signoffQuorum?: number               // 0-1, default 0.5 (peer-quorum mode, Phase D)
    signoffApprovals?: Record<string, boolean>  // collected approvals
    signoffStage?: boolean               // true when in signoff phase

    // delegate mode: uses shared tasklist (team_task_*), no extra fields

    // pipeline / loop: ordered stages
    stages: Stage[]
    currentStageIndex: number

    // loop-specific
    deciderMember?: string             // member name of decider (NOT "master")
    decisionHistory: DecisionRecord[]  // structured decisions per round
    decisionParseFailures: number      // consecutive <decision> parse failures; abort at 3

    // consensus-specific (type === "consensus")
    consensusReached?: boolean         // set when all members emit agreed consensus

    // require_done_ack (parallel isolated/collaborative only): when true, the
    // barrier waits for every participant's `declaredDone === true` instead of
    // `status === "idle"`. Members must call team_done() to ack — premature
    // idle is recovered by an automatic re-prompt (processIdle Step 6).
    requireDoneAck?: boolean
}

// --- LastModeRecord (persists after activeTask cleanup, for sidebar display) ---

export type LastModeRecord = {
    type: OrchestrationType
    mode?: ParallelMode                // parallel only
    finishedAt: number                 // epoch ms when activeTask was cleared
}

export type Stage = {
    member: string                     // member name (validated unique within stages)
    task: string                       // task description
    action?: "modify" | "read_only"    // loop mode only
    completed: boolean
}

export type DecisionRecord = {
    round: number
    decision: "continue" | "done"
    rationale: string
    nextActions: string[]              // concrete directives for next round
    timestamp: number
}

// --- Message (file mailbox entry) ---

export type Message = {
    version: 1
    id: string                         // UUID
    from: string                       // sender member name, or "orchestrator"
    to: string                         // recipient member name, or "*" for broadcast
    kind: "message" | "announcement"
    body: string                       // max 32KB
    summary?: string                   // one-line summary for status display
    timestamp: number
    correlationId?: string             // UUID for request-response pairing
    deliveryStatus: "pending" | "delivered" | "processed"
}

// --- Task (shared task list, for collaborative modes) ---

export type TaskStatus = "pending" | "claimed" | "in_progress" | "completed" | "deleted"

export type Task = {
    version: 1
    id: string                         // UUID
    subject: string
    description: string
    status: TaskStatus
    owner?: string                     // member name who claimed
    blocks: string[]                   // task IDs this blocks
    blockedBy: string[]                // task IDs that must complete first
    createdAt: number
    updatedAt: number
    claimedAt?: number
}

// --- Storage scope (user-scope ~/.octeam vs project-scope <dir>/.octeam) ---

export type StorageScope = "user" | "project"

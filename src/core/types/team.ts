/**
 * Team state and configuration type definitions.
 *
 * Layer 2 in the types decomposition — imports ActiveTask, OrchestrationType,
 * and ParallelMode from orchestration.ts (layer 1).
 */

import type { ActiveTask, OrchestrationType, ParallelMode } from "./orchestration.js"

// ---------------------------------------------------------------------------
// Shared supporting types
// ---------------------------------------------------------------------------

/** Resource limits enforced across an orchestration run. */
export type Bounds = {
    maxMembers: number                 // default 8; effective per-team member cap (enforced in add_member)
    maxParallelMembers: number         // default 4, concurrent spawn limit
    maxMessagesPerRun: number          // default 100, total messages per orchestration
    maxWallClockMinutes: number        // default 30, hard wall-clock limit
    maxMemberTurns: number             // default 50, turns per member per orchestration
    maxTasks: number                   // default 200, max live tasks in the shared tasklist
    messagePayloadMaxBytes: number     // default 32768 (32KB)
    messageUnreadMaxBytes: number      // default 1048576 (1MB), backpressure limit
}

/** Persisted record of the most recent orchestration mode, for sidebar display. */
export type LastModeRecord = {
    type: OrchestrationType
    mode?: ParallelMode                // parallel only
    finishedAt: number                 // epoch ms when activeTask was cleared
}

// ---------------------------------------------------------------------------
// Team types
// ---------------------------------------------------------------------------

/** Immutable team specification stored as config.json. */
export type TeamSpec = {
    readonly version: 1
    readonly name: string              // /^[a-z0-9-]+$/, unique within scope
    readonly description?: string
    readonly createdAt: number         // epoch ms
    readonly members: MemberSpec[]     // 1-8 members (maxMembers default)
}

/** Team lifecycle status: config-only, actively running, idle, or failed. */
export type TeamStatus =
    | "live"                           // config written, no sessions spawned yet
    | "busy"                           // sessions spawned, workflow running
    | "idle"                           // sessions spawned, idle (workflow completed)
    | "failed"                         // agent error or task incomplete (e.g. loop max rounds w/o done)

/**
 * Mutable team runtime state persisted as state.json.
 *
 * Depends on ActiveTask from orchestration.ts (an import cycle would form if
 * orchestration.ts imported from this file). Instead, orchestration.ts is layered
 * BELOW this file, and this file imports the ActiveTask union from it.
 */
export type TeamState = {
    version: 1
    teamRunId: string                  // UUID, unique per run
    teamName: string
    status: TeamStatus
    leadSessionId: string              // always context.sessionID; leader name is "master"
    members: MemberState[]
    activeTask?: ActiveTask            // only one active orchestration at a time
    lastInterruptedTask?: ActiveTask   // task to resume on reconnect (survives activeTask cleanup)
    lastMode?: LastModeRecord          // most recent orchestration mode (survives activeTask cleanup)
    bounds: Bounds                     // resource limits
    createdAt: number
    startedAt?: number                 // when first task started
    activatedAt?: number               // epoch ms; presence ⇒ "available" team for its
                                       // leadSessionId. INVARIANT: ≤1 team per leadSessionId
                                       // has this set. Enforced by team_activate (refuses if a
                                       // sibling is already active — auto-switching is disabled;
                                       // caller must team_deactivate first) + startup reconcile
                                       // (clears ALL activatedAt on plugin restart so nothing
                                       // auto-activates after a reload). Orthogonal to TeamStatus.
}

// ---------------------------------------------------------------------------
// Member types
// ---------------------------------------------------------------------------

/** A single member's declarative configuration within a team. */
export type MemberSpec = {
    name: string                       // unique within team, e.g. "alice" (auto-picked from a name pool if omitted at creation)
    role: string                       // role label, e.g. "coder", "verifier"
    prompt: string                     // system prompt content (the member's instructions)
    model?: string                     // model identifier, e.g. "claude-sonnet"
    agent?: string                     // OpenCode agent type, default "build"
    worktree?: boolean                 // create isolated git worktree, default false
}

/** Per-member session status: not yet created, running, idle, or errored. */
export type MemberStatus =
    | "pending"                        // session not yet created
    | "running"                        // actively processing a prompt
    | "idle"                           // finished, awaiting work
    | "errored"                        // LLM/tool failure

/** Runtime state for a single team member, persisted in state.json. */
export type MemberState = {
    name: string
    sessionId?: string                 // set after session.create succeeds
    model?: string
    agent?: string
    status: MemberStatus
    initialized: boolean               // true after role-setup prompt completes
    worktreePath?: string              // absolute path to git worktree
    turnCount: number                  // incremented per promptAsync dispatch
    lastTurnMarkers?: string           // Transform hook injection dedup
    lastNotifiedAt?: number            // delegate: rate-limit re-prompts
    retryingSince?: number             // epoch ms when session entered "retry"
    error?: string                     // if status === "errored"
    isMaster?: boolean                 // runtime-only: true on the synthetic master record
                                       // (built by masterPseudoMember / syntheticMaster).
                                       // Never stored in team.members and never written to
                                       // state.json; lives on MemberState so the synthetic
                                       // master can flow through MemberState-typed code paths.
    declaredDone?: boolean             // require_done_ack: member has called team_done() this run
    retryCount?: number                // OCTeam-level grace-extension windows consumed this run (reset to 0 at task commit)
    prompt?: string                    // member's standing instruction (copied from MemberSpec.prompt at
                                       // spawn). Delivered as <task-instruction> on the member's FIRST
                                       // real task dispatch (NOT during role-setup, which is identity-only).
    promptDelivered?: boolean          // true after prompt has been prepended to a dispatch once
    lastCapturedMsgCount?: number      // capture dedup: messages.length at the last successful
                                       // captureMemberOutput for this member. A re-entry whose message
                                       // history hasn't grown (stale idle, delegate completion sweep)
                                       // yields no new turn and is skipped, making capture effectively
                                       // idempotent across calls with unchanged history.
}

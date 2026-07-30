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
    maxMembers: number                 // default 12; effective per-team member cap (enforced in add_member)
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
    // Token snapshot of the completed run. Populated by clearActiveTask so that
    // sidebar/progress can still display per-member tokens after activeTask is
    // cleared (otherwise the data only lives in runs/<id>/record.json).
    tokensUsed?: number                       // total tokens across the completed run
    tokensByMember?: Record<string, number>   // memberName -> sum(input+output+reasoning)
    runId?: string                            // points to runs/<id>/record.json for drill-down
}

// ---------------------------------------------------------------------------
// Team types
// ---------------------------------------------------------------------------

/** Declarative team specification stored as config.json. */
export type TeamSpec = {
    readonly version: 1
    readonly name: string              // /^[a-z0-9-]+$/, unique within scope
    readonly description?: string
    readonly createdAt: number         // epoch ms
    readonly members: MemberSpec[]     // 1-12 members (maxMembers default)
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
    teamRunId: string                  // UUID, unique per team
    teamName: string
    status: TeamStatus
    // leadSessionId is a directory locator used to construct the team path
    // (project scope: <root>/<leadSessionId>/teams/<teamName>). It is NOT an
    // authorization credential — authorization is derived from the session
    // index rebuilt from disk structure at startup (resolve.ts). A tampered
    // state.json changing leadSessionId cannot grant master privileges because
    // resolveCallerInTeam uses the index entry's leadSessionId, not the disk
    // value, for authorization decisions.
    leadSessionId: string              // always context.sessionID; leader name is "master"
    members: MemberState[]
    activeTask?: ActiveTask            // only one active orchestration at a time
    lastInterruptedTask?: ActiveTask   // task to resume on reconnect (survives activeTask cleanup)
    lastMode?: LastModeRecord          // most recent orchestration mode (survives activeTask cleanup)
    bounds: Bounds                     // resource limits
    createdAt: number
    startedAt?: number                 // when first task started
    runnerPid?: number                  // H38: PID of the OpenCode process running the
                                        // active orchestration. Set at startup, cleared
                                        // by finishRun. Reconciler checks process liveness
                                        // via this PID to distinguish crashed from live
                                        // sibling processes.
    activatedAt?: number               // epoch ms; presence ⇒ "available" team for its
                                       // leadSessionId. INVARIANT: ≤1 team per leadSessionId
                                       // has this set. Enforced by team_activate (refuses if a
                                       // sibling is already active — auto-switching is disabled;
                                       // caller must team_deactivate first) + startup reconcile
                                       // (clears ALL activatedAt on plugin restart so nothing
                                       // auto-activates after a reload). Orthogonal to TeamStatus.
    spawning?: boolean                 // #12: persisted cross-process spawn guard. Set true in
                                       // Phase 1 of startOrchestration, cleared in Phase 3
                                       // (success) or finally (failure). A second process that
                                       // passes Steps 1-3 sees spawning=true and bails, preventing
                                       // duplicate session/worktree creation.
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
    agent?: string                     // OpenCode agent type; resolved via safeMemberAgent() at dispatch (falls back to oct-oracle for non-oct-* values)
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
    lastNotifiedAt?: number            // delegate: rate-limit re-prompts
    retryingSince?: number             // epoch ms when session entered "retry"
    error?: string                     // if status === "errored"
    isMaster?: boolean                 // RUNTIME-ONLY: true on the synthetic master record
                                       // (built by masterPseudoMember / syntheticMaster).
                                       // NEVER persisted to state.json. isValidTeamState
                                       // rejects ANY truthy value (not just boolean true)
                                       // to defeat tampered state.json privilege escalation.
    declaredDone?: boolean             // require_done_ack: member has called team_done() this run
    retryCount?: number                // OCTeam-level grace-extension windows consumed this run (reset to 0 at task commit)
    prompt?: string                    // member's standing instruction (copied from MemberSpec.prompt at
                                       // spawn). Delivered as <member-instruction> on the member's FIRST
                                       // real task dispatch (NOT during role-setup, which is identity-only).
    promptDelivered?: boolean          // true after prompt has been prepended to a dispatch once
    lastCapturedMsgCount?: number      // capture dedup: messages.length at the last successful
                                       // captureMemberOutput for this member. A re-entry whose message
                                       // history hasn't grown (stale idle, delegate completion sweep)
                                       // yields no new turn and is skipped, making capture effectively
                                       // idempotent across calls with unchanged history.
}

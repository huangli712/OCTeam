/**
 * OCTeam data model types (see docs/ARCHITECTURE.md).
 *
 * All types in this file are JSON-serializable — they are persisted to disk
 * (config.json / state.json / mailbox *.jsonl / tasks/*.json). Runtime-only
 * constructs that carry non-serializable handles (e.g. the Team wrapper with
 * its in-process mutex) live in state/store.ts, NOT here.
 */

// --- TeamSpec (immutable, declarative) — stored as config.json ---

export type TeamSpec = {
    readonly version: 1
    readonly name: string              // /^[a-z0-9-]+$/, unique within scope
    readonly description?: string
    readonly createdAt: number         // epoch ms
    readonly members: MemberSpec[]     // 1-8 members (maxMembers default)
}

export type MemberSpec = {
    name: string                       // unique within team, e.g. "alice" (auto-picked from a name pool if omitted at creation)
    role: string                       // role label, e.g. "coder", "verifier"
    prompt: string                     // system prompt content (the member's instructions)
    model?: string                     // model identifier, e.g. "claude-sonnet"
    agent?: string                     // OpenCode agent type, default "build"
    worktree?: boolean                 // create isolated git worktree, default false
}

// --- TeamState (mutable, persisted) — stored as state.json ---

export type TeamStatus =
    | "live"                           // config written, no sessions spawned yet
    | "busy"                           // sessions spawned, workflow running
    | "idle"                           // sessions spawned, idle (workflow completed)
    | "failed"                         // agent error or task incomplete (e.g. loop max rounds w/o done)

export type MemberStatus =
    | "pending"                        // session not yet created
    | "running"                        // actively processing a prompt
    | "idle"                           // finished, awaiting work
    | "errored"                        // LLM/tool failure

export type MemberState = {
    name: string
    sessionId?: string                 // set after session.create succeeds
    model?: string
    agent?: string
    status: MemberStatus
    initialized: boolean               // true after role-setup prompt completes
    worktreePath?: string              // absolute path to git worktree
    turnCount: number                  // incremented per promptAsync dispatch
    lastTurnMarker?: string            // Transform hook injection dedup
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
                                       // spawn). Delivered as <standing-instruction> on the member's FIRST
                                       // real task dispatch (NOT during role-setup, which is identity-only).
    promptDelivered?: boolean          // true after prompt has been prepended to a dispatch once
}

export type TeamState = {
    version: 1
    teamRunId: string                  // UUID, unique per run
    teamName: string
    status: TeamStatus
    leadSessionId: string              // always context.sessionID; leader name is "master"
    members: MemberState[]
    activeTask?: ActiveTask            // only one active orchestration at a time
    lastInterruptedTask?: ActiveTask       // task to resume on reconnect (survives activeTask cleanup)
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

// --- Bounds (resource limits) ---

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

// --- ActiveTask ---

export type OrchestrationType = "parallel" | "pipeline" | "loop" | "delegate" | "consensus" | "route" | "arbitrate" | "recurse" | "tollgate" | "workflow"
export type ParallelMode = "isolated" | "cooperative"
export type ReducePolicy = "summarize" | "select" | "merge" | "rubric"
export type SignoffPolicy = "none" | "decider" | "peer-quorum"
export type ApprovalKind = "pipeline_stage" | "tollgate_gate" | "loop_done" | "route_decision" | "recurse_decompose" | "arbitrate_ruling" | "consensus_deadlock" | "workflow_step"
export type ApprovalTimeoutAction = "fail" | "approve" | "reject"

// tollgate: three-valued verification verdict emitted by a gate's verifier.
export type Verdict = "PASS" | "FAIL" | "INVALID"

export type WorkflowIssueSeverity = "low" | "medium" | "high" | "critical"

export type WorkflowIssue = {
    severity: WorkflowIssueSeverity
    message?: string
}

export type WorkflowCondition =
    | { kind: "score_gte"; value: number }
    | { kind: "score_lt"; value: number }
    | { kind: "confidence_gte"; value: number }
    | { kind: "has_issue_severity"; value: WorkflowIssueSeverity }

/**
 * ActiveTask is a discriminated union: a shared ActiveTaskBase plus one
 * variant per OrchestrationType. TS narrows to the variant inside `switch`
 * / `if` on the `type` discriminant, so type-specific fields (deciderMember,
 * routerMember, gatedStages, ...) are only reachable after narrowing.
 *
 * Field placement rules:
 *   - used by 2+ types, OR accessed on an un-narrowed ActiveTask somewhere
 *     in the codebase -> ActiveTaskBase (conservative; keeps call sites
 *     compiling without per-site narrowing).
 *   - used by exactly 1 type AND only ever read inside a narrowed context
 *     -> the variant.
 *
 * No field was removed relative to the prior single-record shape; fields were
 * only reorganized between Base and variants.
 */
export interface ActiveTaskBase {
    type: OrchestrationType                  // discriminant (narrowed to a literal per variant)
    startedAt: number
    wallClockTimeoutMs: number               // hard timeout in ms; set by the tool layer to
                                       // DEFAULT_TIMEOUT_MS (600_000 / 10 min) or
                                       // DEFAULT_LOOP_TIMEOUT_MS (900_000 / 15 min for loop)
    tokenBudget?: number                     // optional cost cap
    tokensUsed: number                       // running total = sum of tokensByMember (recomputed)
    tokensByMember: Record<string, number>   // memberName -> sum(input+output+reasoning)
    messagesSent: number                     // total team_send_message writes this run (maxMessagesPerRun)

    // result collection (serializable — NOT a Map)
    responses: Record<string, string>        // memberName -> last assistant text output

    // cross-type string payload. `task` is the uniform input for parallel
    // isolated, the routing input for route, the dispute subject for
    // arbitrate, and the root goal for recurse. `mode` is parallel-only but
    // is read un-narrowed by store/tui/messaging, so it stays in Base.
    task?: string                            // parallel isolated / route input / arbitrate subject / recurse root
    mode?: ParallelMode                      // parallel only

    // round-bearing types (loop / arbitrate / consensus)
    maxRounds?: number                       // round limit
    currentRound?: number

    // ordered stages (parallel holds []; pipeline / loop / tollgate use it).
    // Constructed by every variant, so it lives in Base.
    stages: Stage[]
    currentStageIndex: number

    // loop decision log. Constructed by ALL variants (kept in Base to avoid
    // excess-property churn across the 9 construction literals), but only
    // loop reads it at runtime.
    decisionHistory: DecisionRecord[]        // structured decisions per round (loop)
    decisionParseFailures: number            // consecutive <decision> parse failures; abort at 3 (loop)

    // reduce policy (parallel isolated/cooperative only; read un-narrowed)
    reducePolicy?: ReducePolicy
    reduceRubric?: string                    // when reducePolicy === "rubric"
    reduceSelect?: string                   // when reducePolicy === "select": what "best" means (method-neutral)
    // #4 real map-reduce: when reducePolicy != summarize AND reducerMember names
    // a live member AND there are >1 candidates, a dedicated reducer member is
    // dispatched post-barrier to combine outputs into one. Otherwise (undefined
    // reducerMember) the reduce guidance is delivered to master (legacy behavior).
    reducerMember?: string
    reduceStage?: boolean                    // true while the reducer stage is in flight
    reducedResult?: string                   // reducer's combined output; delivered verbatim once set

    // signoff policy (parallel isolated/cooperative, pipeline, delegate; NOT loop).
    // Read un-narrowed by maybeTriggerSignoff/handleSignoffIdle, so Base.
    signoffPolicy?: SignoffPolicy
    signoffDecider?: string                  // member name (decider mode)
    signoffQuorum?: number                   // 0-1, default 0.5 (peer-quorum mode, Phase D)
    signoffApprovals?: Record<string, boolean>  // collected approvals
    signoffStage?: boolean                   // true when in signoff phase

    // human approval policy (mid-run HITL pause; distinct from post-completion signoff)
    humanApproval?: boolean                  // true when configured for modes that support HITL
    approvalStage?: boolean                  // true while paused for team_approve/team_reject
    approvalRequest?: ApprovalRequest        // current pending human approval request
    approvalTimeoutMs?: number               // optional bound on the human approval pause
    onApprovalTimeout?: ApprovalTimeoutAction // default fail when approvalTimeoutMs elapses
    approvalHistory?: ApprovalDecisionRecord[] // resolved approval decisions for audit/history

    // delegate mode: uses shared tasklist (team_task_*), no extra fields

    requireDoneAck?: boolean                 // parallel: all-acked barrier (read un-narrowed in waitForBarrier)
    maxErroredMembers?: number               // parallel/delegate: failure isolation (read un-narrowed)
    maxRetries?: number                      // all modes: bounded retry (read un-narrowed)

    // per-orchestration run id (lazily generated at first output capture). Used to
    // key runs/<runId>/ for persistent result records. NOT teamRunId (which is
    // team-constant); each orchestration gets a fresh runId.
    runId?: string
}

// parallel: fan-out then converge. `tasks` is cooperative per-member work.
export interface ParallelTask extends ActiveTaskBase {
    type: "parallel"
    tasks?: Record<string, string>           // cooperative: { memberName: task }
}

// pipeline: ordered stages, output prefixed forward.
export interface PipelineTask extends ActiveTaskBase {
    type: "pipeline"
}

// loop: corrective code -> review -> decide cycle.
export interface LoopTask extends ActiveTaskBase {
    type: "loop"
    deciderMember?: string                   // member name of decider (NOT "master")
}

// delegate: shared tasklist, members self-claim.
export interface DelegateTask extends ActiveTaskBase {
    type: "delegate"
}

// consensus: multi-round debate to agreement.
export interface ConsensusTask extends ActiveTaskBase {
    type: "consensus"
    topic?: string                           // the debate topic
    consensusReached?: boolean               // set when all members emit agreed consensus
}

// route: content-based routing to selected branches.
export interface RouteTask extends ActiveTaskBase {
    type: "route"
    routerMember?: string                    // the router member name (NOT master, NOT a branch member)
    routeBranches?: RouteBranch[]            // caller-declared branches the router selects from
    routeTargets?: string[]                  // resolved target member names after the router's decision
    routeStage?: boolean                     // false/undefined = router phase; true = target fan-out phase
    routeDecisionRationale?: string          // router's stated rationale (observability)
}

// arbitrate: debate then authoritative ruling.
export interface ArbitrateTask extends ActiveTaskBase {
    type: "arbitrate"
    arbiterMember?: string                   // the arbiter member name (NOT master, NOT a debater)
    disputants?: string[]                    // debater member names (Phase A barrier participants)
    arbitrationStage?: boolean               // false/undefined = debate phase; true = ruling phase
    arbitrationRuling?: string               // arbiter's binding ruling (set at ruling)
    arbitrationRationale?: string            // arbiter's stated rationale for the ruling
}

// recurse: hierarchical recursive decomposition.
export interface RecurseTask extends ActiveTaskBase {
    type: "recurse"
    decomposerMember?: string                // the member first dispatched with the root task (NOT master)
    maxDepth?: number                        // recursion depth upper bound (default 3)
    maxSubtasks?: number                     // per-decomposition subtask upper bound (default 5)
    rootTaskId?: string                      // the root task id; its result is the final deliverable
    aggregationDispatchCount?: number        // decomposer dispatches that failed to produce a root claim (stall detection; recurse mode)
}

// tollgate: verdict-gated pipeline (produce -> verify -> escalate). A gated
// pipeline where advancing depends on a verifier's verdict, not just completion.
export interface TollgateTask extends ActiveTaskBase {
    type: "tollgate"
    gatedStages?: GatedStage[]               // linear stages, each with its own verification gate
    tollgatePhase?: "produce" | "verify" | "escalate"  // explicit three-phase state (avoids a two-value gate-stage deadlock)
    escalateTo?: string                      // INVALID escalation target member (optional; when unset, INVALID is escalated to the leader)
    maxGateRetries?: number                  // gate FAIL retry cap, DISTINCT from provider-retry maxRetries (default 0: first FAIL fails)
    maxInvalidCycles?: number                // cap on INVALID/escalate ping-pong per gate (default 3); beyond it the run fails with tollgate_invalid:exhausted instead of looping to wall-clock
}

// workflow: deterministic, declaratively-composed step engine. Linear workflows
// remain the degenerate case; fanout/join marker steps allow a persisted active
// frontier without introducing a separate orchestration primitive.
export type WorkflowStepKind = "task" | "gate" | "fanout" | "join"

export type WorkflowOnInvalid = "fail" | "retry_verifier" | "escalate"

export type WorkflowBranchRange = {
    readonly startIndex: number
    readonly endIndex: number
}

export type WorkflowJoinPolicy = "tolerance" | "all" | "quorum" | "any_success" | "required_branches" | "reduce"

export type WorkflowFanoutMetadata = {
    readonly branchIds: readonly string[]
    readonly branchRanges: readonly WorkflowBranchRange[]
    readonly joinIndex: number
    readonly maxErrored: number
    readonly joinPolicy?: WorkflowJoinPolicy
    readonly quorum?: number                  // fraction of branches that must succeed (join_policy='quorum'), 0 < quorum <= 1
    readonly requiredBranchIds?: readonly string[]  // branch ids that must succeed (join_policy='required_branches')
    readonly reducerMember?: string           // member who aggregates branch outputs at join (join_policy='reduce')
}

export type WorkflowBranchMetadata = {
    readonly fanoutIndex: number
    readonly branchId: string
    readonly branchIndex: number
    readonly joinIndex: number
}

export type WorkflowJoinMetadata = {
    readonly fanoutIndex: number
    readonly branchTailIndices: readonly number[]
    readonly maxErrored: number
    readonly joinPolicy?: WorkflowJoinPolicy
    readonly quorum?: number
    readonly requiredBranchIds?: readonly string[]
    readonly reducerMember?: string
    readonly survivorBranchIds?: readonly string[]
    readonly erroredBranchIds?: readonly string[]
    readonly joinedOutput?: string
}

export type WorkflowStep = {
    kind: WorkflowStepKind
    id?: string                          // stable step identifier (optional); when set, gates may reference it via targetStepId
    // task step
    member?: string                     // the actor member name (task steps)
    task?: string                       // the task text (task steps)
    // gate step
    verifier?: string                   // the verifier member name (gate steps; NOT the preceding task's member)
    criteria?: string                   // verification criteria (gate steps)
    targetStepIndex?: number            // gate steps: zero-based primary task step being verified; omitted means nearest preceding task
    targetStepIndices?: number[]        // gate steps: zero-based multi-target task steps; targetStepIndex remains the primary/legacy target
    onFail?: "retry" | "fail"           // FAIL control: retry the preceding task, or fail the run (gate steps; default "fail")
    maxRetries?: number                 // FAIL retry cap, distinct from provider-retry maxRetries (gate steps; default 0)
    attempts?: number                   // FAIL retry count so far (gate steps)
    onInvalid?: WorkflowOnInvalid       // INVALID control: fail the run, re-dispatch the verifier, or escalate to the leader (gate steps; default "fail")
    maxInvalidRetries?: number          // retry_verifier cap for INVALID verdicts (gate steps; default 0)
    invalidAttempts?: number            // retry_verifier attempt count so far (gate steps)
    verdict?: Verdict                   // last verdict rendered (gate steps)
    score?: number                      // optional structured score from the last verdict (gate steps)
    confidence?: number                 // optional structured confidence from the last verdict (gate steps)
    issues?: WorkflowIssue[]            // optional structured issues from the last verdict (gate steps)
    inputs?: number[]
    exposeOutput?: boolean
    // conditional jumps: verdict-gated goto targets (0-based internal index,
    // resolved at build time from a 1-based number or step id). Omitted = the
    // verdict's default behavior (PASS: advance; FAIL/INVALID: terminate).
    onPassGoto?: number                 // after PASS: jump here instead of advancing linearly
    onFailGoto?: number                 // at a FAIL terminal point (on_fail=fail, or retry exhausted): jump instead of failing
    onInvalidGoto?: number             // at an INVALID terminal point (on_invalid=fail, or retry_verifier exhausted): jump instead of terminating. NOT applied to escalate.
    where?: WorkflowCondition           // optional threshold condition gating on_pass_goto/on_fail_goto
    maxJumps?: number                   // per-gate cap on verdict-driven jumps; default 3, max 10
    jumpCount?: number                  // verdict-driven jumps taken so far at this gate
    output?: string                     // task steps: captured output snapshot at completion time (per-step, NOT overwritten by later steps the same member runs)
    // step-level controls (workflow P1+): per-step HITL pauses and output cap,
    // overriding/complementing the task-global humanApproval flag.
    approvalBefore?: boolean            // pause for team_approve before dispatching this step
    approvalAfter?: boolean             // pause for team_approve after this step completes, before advancing
    approvalBeforeGranted?: boolean     // transient: approval_before was requested for the current step instance; consumed on dispatch, reset on re-entry (retry/goto-back)
    maxOutputBytes?: number             // task steps: cap the captured output snapshot to N UTF-8 bytes (head+tail preserved)
    timeoutMs?: number                  // task/gate steps: wall-clock deadline from dispatch time
    onTimeout?: "fail" | "retry" | "skip" // timeout control; default fail
    maxTimeoutRetries?: number          // timeout retry cap when onTimeout=retry
          timeoutAttempts?: number            // timeout retry attempts so far
          startedAt?: number
          completedAt?: number
          durationMs?: number
          dispatchedAt?: number               // epoch ms when this step was last dispatched
          correlationId?: string              // links this step's dispatch/capture/verdict events in events.jsonl
    // fanout/join DAG metadata (workflow P2). Runtime dispatch wiring lands in a
    // later task; T1 only persists and reads the flat DAG shape.
    fanout?: WorkflowFanoutMetadata     // fanout marker steps
    branch?: WorkflowBranchMetadata     // task/gate steps inside a fanout branch
    join?: WorkflowJoinMetadata         // join marker steps
    // shared
    completed: boolean                  // true when the step is done (task produced; gate PASS; or skipped by a forward jump)
    skipped?: boolean                   // true when a forward jump marked this step as skipped (not run)
}

export interface WorkflowTask extends ActiveTaskBase {
    type: "workflow"
    steps?: WorkflowStep[]              // declarative step list; currentStageIndex is the cursor. Optional to match the codebase convention (all variant-specific fields are optional, like gatedStages?); handlers guard with `task.steps ?? []`.
    activeStepIndices?: number[]        // persisted active frontier for fanout/join; legacy readers fall back to [currentStageIndex]
}

export type ActiveTask =
    | ParallelTask
    | PipelineTask
    | LoopTask
    | DelegateTask
    | ConsensusTask
    | RouteTask
    | ArbitrateTask
    | RecurseTask
    | TollgateTask
    | WorkflowTask

// --- LastModeRecord (persists after activeTask cleanup, for sidebar display) ---

export type LastModeRecord = {
    type: OrchestrationType
    mode?: ParallelMode                // parallel only
    finishedAt: number                 // epoch ms when activeTask was cleared
}

// --- RunRecord (persistent per-orchestration result, stored as runs/<runId>/record.json) ---

export type RunStatus = "completed" | "failed"
export type WorkflowBranchStatus = "pending" | "completed" | "skipped" | "errored"

export type WorkflowRunStep = {
    index: number                       // zero-based internal workflow step index
    step: number                        // one-based display step number
    kind: WorkflowStepKind
    id?: string                          // stable step identifier when declared
    member?: string
    verifier?: string
    targetStep?: number                 // one-based display primary target task step for gate steps
    targetSteps?: number[]              // one-based display multi-target task steps for gate steps
    verdict?: Verdict
    score?: number
    confidence?: number
    issues?: WorkflowIssue[]
    attempts?: number
    onInvalid?: WorkflowOnInvalid
    invalidAttempts?: number
    jumpCount?: number
    skipped?: boolean
    completed: boolean
    output?: string                     // bounded task-step snapshot captured at completion
    outputBytes?: number
    joinedOutputBytes?: number
    startedAt?: number
    completedAt?: number
    durationMs?: number
    inputs?: number[]
    exposeOutput?: boolean
    fanout?: WorkflowFanoutMetadata
    branch?: WorkflowBranchMetadata
    join?: WorkflowJoinMetadata
    branchStatuses?: Record<string, WorkflowBranchStatus>
    // Static step-level control config (post-run audit mirror of the runtime
    // declared controls). approvalBeforeGranted is transient and not persisted.
    approvalBefore?: boolean
    approvalAfter?: boolean
    maxOutputBytes?: number
}

export type RunRecord = {
    version: 1
    runId: string                      // per-orchestration UUID
    teamRunId: string                  // team-constant id; correlates a team's runs
    teamName: string
    type: OrchestrationType
    mode?: ParallelMode
    reason: string                     // verbatim reason passed to deliverSummaryToLeader
    status: RunStatus                  // derived via runStatusFromReason
    startedAt: number                  // task.startedAt
    finishedAt: number                 // epoch ms at persist
    tokensUsed: number
    tokensByMember: Record<string, number>
    messagesSent: number
    currentRound?: number              // consensus / loop
    decisionHistory?: DecisionRecord[] // loop
    approvalHistory?: ApprovalDecisionRecord[] // HITL approval audit trail
    consensusReached?: boolean         // consensus
    signoffPolicy?: SignoffPolicy
    signoffApprovals?: Record<string, boolean>
    // per-member full outputs, path-referenced (NOT inlined). file is relative to
    // runs/<runId>/ (e.g. "alice.md").
    memberOutputs: Record<string, { bytes: number; file: string }>
    // delegate snapshot of the shared task list at completion
    tasks?: Array<{ id: string; subject: string; status: string; owner?: string }>
    // workflow snapshot of the step ledger at completion/failure
    workflow?: { steps: WorkflowRunStep[] }
}

// --- RunEvent (append-only run timeline, stored as runs/<runId>/events.jsonl) ---

export type RunEventKind =
    | "dispatched"      // a member was prompted with a task
    | "captured"        // a member's output was captured
    | "retry"           // a sustained-retry grace window was consumed
    | "errored"         // a member was marked terminally errored
    | "stage_advanced"  // pipeline/loop moved to a new stage
    | "round"           // consensus/loop incremented the round
    | "signoff"         // a signoff review stage was triggered
    | "approval_requested" // a human approval pause was requested
    | "approval_resolved"  // a human approval request was approved/rejected
    | "terminated"      // the orchestration ended (any reason)
    | "routed"          // router selected target branch(es) (route mode)
    | "arbitrated"      // arbiter issued a binding ruling (arbitrate mode)
    | "decomposed"      // a task was split into subtasks (recurse mode)
    | "aggregated"      // the root task was finalized after all subtasks completed (recurse mode)
    | "aggregation_stalled"  // decomposer failed to claim+aggregate root after dispatch cap (recurse mode)
    | "verdict"         // a gate produced a PASS/FAIL/INVALID verdict (tollgate mode)
    | "repaired"        // team_fix_workflow performed a surgical repair op

export type RunEvent = {
    timestamp: number                  // epoch ms (readers sort by this, not file order)
    kind: RunEventKind
    member?: string
    stage?: number                     // currentStageIndex (pipeline/loop)
    round?: number                     // currentRound (consensus/loop)
    stepIndex?: number                 // workflow step index (workflow mode)
    correlationId?: string             // links related events (e.g. a step dispatch and its capture/verdict)
    reason?: string                    // terminated / errored reason
    bytes?: number                     // captured output size
    detail?: string                    // free-form (signoff policy, "grace n/max", …)
}

export type Stage = {
    member: string                     // member name (validated unique within stages)
    task: string                       // task description
    action?: "modify" | "read_only"    // loop mode only
    completed: boolean
}

export type ApprovalRequest = {
    id: string                          // UUID used by team_approve/team_reject
    kind: ApprovalKind                  // mode-specific pause point
    requestedAt: number                 // epoch ms, used to suspend wall-clock timing
    summary: string                     // text presented to the leader for approval
    stage?: number                      // currentStageIndex for stage/gate approvals
    round?: number                      // currentRound for loop done approval
    taskId?: string                     // recurse approval: task being decomposed
    member?: string                     // recurse approval: member that requested decomposition
    subtasks?: ApprovalSubtask[]        // recurse approval: proposed child tasks
}

export type ApprovalSubtask = {
    subject: string
    description: string
}

export type ApprovalDecisionRecord = {
    id: string
    kind: ApprovalKind
    approved: boolean
    requestedAt: number
    resolvedAt: number
    feedback?: string
}

// tollgate: a Stage with an associated verification gate. The gate's verifier
// (distinct from the producer) emits a <verdict> (or <判定>) block; downstream
// starts only on PASS. FAIL returns the producer with a diff; INVALID isolates
// the stage and escalates the verifier side (not the producer). Structurally
// satisfies Stage so it can be fed to buildUpstreamContext.
export type GatedStage = {
    member: string                     // the producer member name
    task: string                       // the producer's task
    completed: boolean                 // set true only on PASS
    verifier: string                   // the verifier member name (NOT the producer)
    criteria: string                   // verification criteria (tolerance / conservation law / reference description)
    reference?: string                 // golden reference location (Compare-style numerical verdict)
    verdict?: Verdict                  // last verdict rendered by this gate
    attempts: number                   // FAIL retry count against maxGateRetries
    invalidAttempts: number            // INVALID/escalate cycle count against maxInvalidCycles
}

export type DecisionRecord = {
    round: number
    decision: "continue" | "done"
    rationale: string
    nextActions: string[]              // concrete directives for next round
    timestamp: number
}

export type RouteBranch = {
    name: string                       // branch label the router selects by (unique)
    member: string                     // target member to dispatch to (unique across branches)
    task?: string                      // per-branch task; if omitted, target receives the routing `task`
    description?: string               // optional hint shown to the router
}

// --- Message (file mailbox entry) ---

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
    runId?: string                      // per-orchestration run id for directive messages
    deliveryStatus: "pending" | "delivered" | "processed"
}

// --- Task (shared task list, for cooperative modes) ---

export type TaskStatus = "pending" | "claimed" | "in_progress" | "completed" | "deleted"

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

// --- Storage scope (user-scope ~/.octeam vs project-scope <dir>/.octeam) ---

export type StorageScope = "user" | "project"

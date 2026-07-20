/**
 * ActiveTask discriminated union and supporting orchestration types — the
 * active orchestration's runtime state machine.
 *
 * Layer 1 in the types decomposition — imports workflow step types
 * (Verdict, WorkflowStep) from workflow.ts. Consumed by team.ts
 * (TeamState.activeTask field), runs.ts (RunRecord.type), and all
 * orchestration handlers.
 *
 * Each variant carries only its type-specific fields; shared bookkeeping
 * (tokens, responses, stages, decision history, signoff, HITL approvals, ...)
 * lives in ActiveTaskBase so it is accessible without narrowing.
 */

import type {
    Verdict,
    WorkflowStep,
} from "./workflow.js"

// ============================================================================
// Type aliases
// ============================================================================

// --- Orchestration mode enums ---

/** Discriminated orchestration mode — one of twelve workflow primitives. */
export type OrchestrationType =
    | "parallel"
    | "pipeline"
    | "loop"
    | "delegate"
    | "consensus"
    | "route"
    | "arbitrate"
    | "recurse"
    | "tollgate"
    | "workflow"
    | "arena"
    | "quorum"

/** Parallel execution mode: isolated (same task) or cooperative (per-member). */
export type ParallelMode = "isolated" | "cooperative"

/** Result reduction policy for parallel member outputs. */
export type ReducePolicy = "summarize" | "select" | "merge" | "rubric"

/** Post-completion review gate policy. */
export type SignoffPolicy = "none" | "decider" | "peer-quorum"

/** Mid-run human approval pause point kind. */
export type ApprovalKind =
    | "pipeline_stage"
    | "tollgate_gate"
    | "loop_done"
    | "route_decision"
    | "recurse_decompose"
    | "arbitrate_ruling"
    | "consensus_deadlock"
    | "workflow_step"

/** Action taken when an approval pause times out. */
export type ApprovalTimeoutAction = "fail" | "approve" | "reject"

// --- Stage types ---

/** A pipeline or loop stage — member, task, action, and completion flag. */
export type Stage = {
    member: string                     // member name (validated unique within stages)
    task: string                       // task description
    action?: "modify" | "read_only"    // loop mode only
    completed: boolean
}

// --- Arena types ---

/** Evaluator-attested score for a single arena candidate. */
export type ArenaCandidateScore = {
    member: string
    score?: number
    metrics?: Record<string, number>
    passed?: boolean
    rationale?: string
}

/** Complete arena scoreboard — per-candidate scores and evaluator rationale. */
export type ArenaScoreboard = {
    scores: ArenaCandidateScore[]
    rationale?: string
}

// --- Supporting types referenced by ActiveTaskBase and variants ---

/** A route branch — label, target member, and optional per-branch task. */
export type RouteBranch = {
    name: string                       // branch label the router selects by (unique)
    member: string                     // target member to dispatch to (unique across branches)
    task?: string                      // per-branch task; if omitted, target receives the routing `task`
    description?: string               // optional hint shown to the router
}

/** A single round decision in a corrective loop: continue or done. */
export type DecisionRecord = {
    round: number
    decision: "continue" | "done"
    rationale: string
    nextActions: string[]              // concrete directives for next round
    timestamp: number
}

/**
 * A tollgate stage with an associated verification gate and verdict state.
 *
 * The gate's verifier (distinct from the producer) emits a <verdict> (or
 * <判定>) block; downstream starts only on PASS. FAIL returns the producer
 * with a diff; INVALID isolates the stage and escalates the verifier side
 * (not the producer). Structurally satisfies Stage so it can be fed to
 * buildUpstreamContext.
 */
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

/** Pending human-in-the-loop approval request. */
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

/** A proposed child task in a recurse decomposition approval request. */
export type ApprovalSubtask = {
    subject: string
    description: string
}

/** Resolved approval decision for audit and history. */
export type ApprovalDecisionRecord = {
    id: string
    kind: ApprovalKind
    approved: boolean
    requestedAt: number
    resolvedAt: number
    feedback?: string
}

// --- ActiveTask discriminated union (references interfaces below) ---

/** Discriminated union of all orchestration task variants. */
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
    | ArenaTask
    | QuorumTask

// ============================================================================
// Interfaces
// ============================================================================

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
    // excess-property churn across the 11 construction literals), but only
    // loop reads it at runtime.
    decisionHistory: DecisionRecord[]        // structured decisions per round (loop)
    decisionParseFailures: number            // consecutive <decision> parse failures; abort at 3 (loop)

    // reduce policy (parallel isolated/cooperative only; read un-narrowed)
    reducePolicy?: ReducePolicy
    reduceRubric?: string                    // when reducePolicy === "rubric"
    reduceSelect?: string                    // when reducePolicy === "select": what "best" means (method-neutral)
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
    requireDoneAck?: boolean                 // parallel: all-acked barrier (read un-narrowed in maybeAdvanceBarrier)
    maxErroredMembers?: number               // parallel/delegate: failure isolation (read un-narrowed)
    maxRetries?: number                      // all modes: bounded retry (read un-narrowed)

    // per-orchestration run id (lazily generated at first output capture). Used to
    // key runs/<runId>/ for persistent result records. NOT teamRunId (which is
    // team-constant); each orchestration gets a fresh runId.
    runId?: string
}

// parallel: fan-out then converge. `tasks` is cooperative per-member work.
/** Fan-out parallel orchestration — all members work in parallel then converge. */
export interface ParallelTask extends ActiveTaskBase {
    type: "parallel"
    tasks?: Record<string, string>           // cooperative: { memberName: task }
}

// pipeline: ordered stages, output prefixed forward.
/** Linear pipeline — each stage's output feeds the next stage's input. */
export interface PipelineTask extends ActiveTaskBase {
    type: "pipeline"
}

// loop: corrective code -> review -> decide cycle.
/** Corrective loop — code, review, decide, repeat until done. */
export interface LoopTask extends ActiveTaskBase {
    type: "loop"
    deciderMember?: string                   // member name of decider (NOT "master")
}

// delegate: shared tasklist, members self-claim.
/** Delegate mode — publish tasks to a shared tasklist, members self-claim. */
export interface DelegateTask extends ActiveTaskBase {
    type: "delegate"
}

// consensus: multi-round debate to agreement.
/** Multi-round structured debate until all members reach consensus. */
export interface ConsensusTask extends ActiveTaskBase {
    type: "consensus"
    topic?: string                           // the debate topic
    consensusReached?: boolean               // set when all members emit agreed consensus
}

// route: content-based routing to selected branches.
/** Content-based routing — a router inspects input and selects branch(es). */
export interface RouteTask extends ActiveTaskBase {
    type: "route"
    routerMember?: string                    // the router member name (NOT master, NOT a branch member)
    routeBranches?: RouteBranch[]            // caller-declared branches the router selects from
    routeTargets?: string[]                  // resolved target member names after the router's decision
    routeStage?: boolean                     // false/undefined = router phase; true = target fan-out phase
    routeDecisionRationale?: string          // router's stated rationale (observability)
}

// arbitrate: debate then authoritative ruling.
/** Binding arbitration — debaters argue, an arbiter issues a ruling. */
export interface ArbitrateTask extends ActiveTaskBase {
    type: "arbitrate"
    arbiterMember?: string                   // the arbiter member name (NOT master, NOT a debater)
    disputants?: string[]                    // debater member names (Phase A barrier participants)
    arbitrationStage?: boolean               // false/undefined = debate phase; true = ruling phase
    arbitrationRuling?: string               // arbiter's binding ruling (set at ruling)
    arbitrationRationale?: string            // arbiter's stated rationale for the ruling
    hitlPhase?: "pre" | "post" | "both"      // HITL pause point(s); default "pre" when humanApproval is true
}

// recurse: hierarchical recursive decomposition.
/** Hierarchical recursive decomposition with a blockedBy DAG. */
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
/** Verdict-gated pipeline — advancing depends on a verifier's verdict, not just completion. */
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
/** Declarative workflow orchestration — a task/gate/fanout/join step engine. */
export interface WorkflowTask extends ActiveTaskBase {
    type: "workflow"
    steps?: WorkflowStep[]                   // declarative step list; currentStageIndex is the cursor. Optional to match the codebase convention (all variant-specific fields are optional, like gatedStages?); handlers guard with `task.steps ?? []`.
    activeStepIndices?: number[]             // persisted active frontier for fanout/join; legacy readers fall back to [currentStageIndex]
}

// arena: N candidates implement competing solutions in isolated worktrees
// (implement phase), then a dedicated evaluator scores every candidate and a
// deterministic winner is selected over the evaluator-attested scoreboard
// (evaluate phase). ArenaCandidateScore / ArenaScoreboard are the evaluator's
// structured report shape.
/** Competitive arena — N candidates implement competing solutions, one winner selected. */
export interface ArenaTask extends ActiveTaskBase {
    type: "arena"
    task: string                             // required: shared implement task (narrows the optional Base field)
    candidates: string[]                     // ORIGINAL full candidate set (kept for audit)
    survivingCandidates?: string[]           // eligible-to-win subset (candidates that did NOT error), set at implement->evaluate
    evaluatorMember: string                  // the evaluator member name (scores all candidates)
    arenaPhase?: "implement" | "evaluate"    // two-phase state machine
    evalCommand?: string                     // objective command the evaluator runs against each candidate
    evalCriteria?: string                    // scoring criteria for the evaluator
    scoreDirection: "max" | "min"            // winner is the max or min of the winner metric
    winnerMetric: string                     // metric name selected on (e.g. "score")
    maxEvalRetries: number                   // evaluator re-dispatch cap on parse/selection failure
    evalAttempts?: number                    // evaluator attempts consumed so far
    scoreboard?: ArenaScoreboard             // evaluator-attested per-candidate scores
    winner?: string                          // deterministically selected winner name
}

// quorum: N members independently vote on a fixed-schema question; the option
// with strict majority (k > valid_ballots/2) wins. Invalid ballots AND runtime
// errors both abstain (excluded from the denominator, not counted as no-votes).
/** Replicated voting — k-of-n majority ballot on a fixed-schema question. */
export interface QuorumTask extends ActiveTaskBase {
    type: "quorum"
    task: string                             // required: the voting question (narrows the optional Base field)
    voteKey: string                          // the ballot field name members must emit (e.g. "decision")
    voteOptions?: string[]                   // optional whitelist; null/undefined = any non-empty string
    participants: string[]                   // resolved member names who ballot (threaded from `members` arg)
    ballots?: Record<string, QuorumBallot>   // memberName -> parsed ballot; populated at TALLY
    erroredCount?: number                    // invalid-ballot + runtime-error count (for k recalculation)
    nEff?: number                            // effective valid-ballot count (participants - errored); persisted
    threshold?: number                       // k = floor(nEff/2)+1; persisted
    winningOption?: string                   // set at TALLY when an option reaches k
    // NOTE: maxErroredMembers comes from ActiveTaskBase — used by checkTermination
    //       to decide fail-fast vs tolerate-and-let-barrier-handle.
}

/** A single member's parsed ballot in a quorum vote. */
export interface QuorumBallot {
    vote: string                             // the chosen option value (validated against voteOptions if provided)
    rationale?: string                       // optional member rationale
    status: "valid" | "invalid" | "errored"  // invalid = malformed/missing/non-whitelist; errored = runtime error
}

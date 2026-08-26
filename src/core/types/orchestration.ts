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

/** Action taken when an approval pause times out; automatic approve/reject is not implemented. */
type ApprovalTimeoutAction = "fail"

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
    member: string                     // candidate member name
    score?: number                     // default "score" metric (finite)
    metrics?: Record<string, number>   // named metrics (winner_metric targets one)
    passed?: boolean                   // eligibility flag; defaults false when absent
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
 * The gate's verifier (distinct from the producer) emits a <verdict> block or
 * its supported Chinese-language alias. Downstream starts only on PASS. FAIL
 * returns the producer
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
    producerEmptyAttempts?: number     // empty producer output count (distinct from FAIL retries)
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
    requestedAt: number               // epoch ms
    resolvedAt: number                // epoch ms
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
 */
export interface ActiveTaskBase {
    type: OrchestrationType                  // discriminant (narrowed to a literal per variant)
    startedAt: number                        // epoch ms
    wallClockTimeoutMs: number               // hard timeout in ms; set by the tool layer to
                                             // DEFAULT_TIMEOUT_MS (600_000 / 10 min) or
                                             // DEFAULT_LOOP_TIMEOUT_MS (900_000 / 15 min for loop)
    tokenBudget?: number                     // optional cost cap
    tokensUsed: number                       // running total = sum of tokensByMember (recomputed)
    tokensByMember: Record<string, number>   // memberName -> sum(input+output+reasoning)
    tokenBaselineByMember?: Record<string, number> // per-run baseline; session tokens at run start (excludes prior runs)
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
    // Immutable round prompt snapshot so late or retry dispatches use the
    // same text as the initial dispatch, not mutable task.responses.
    roundPrompt?: string
    // Track which participants were successfully dispatched this round.
    // Barrier checks this to avoid treating a failed-dispatch member as
    // "already responded" — the member is idle but never received the prompt.
    dispatchedParticipants?: string[]

    // ordered stages (parallel holds []; pipeline / loop / tollgate use it).
    // Constructed by every variant, so it lives in Base.
    stages: Stage[]
    currentStageIndex: number

    // loop decision log. Constructed by ALL variants (kept in Base to avoid
    // excess-property churn across the 12 construction literals), but only
    // loop reads it at runtime.
    decisionHistory: DecisionRecord[]        // structured decisions per round (loop)
    decisionParseFailures: number            // consecutive <decision> parse failures; abort at 3 (loop)

    // reduce policy (parallel isolated/cooperative only; read un-narrowed)
    reducePolicy?: ReducePolicy
    reduceRubric?: string                    // when reducePolicy === "rubric"
    reduceSelect?: string                    // when reducePolicy === "select": what "best" means (method-neutral)
    // When reducePolicy != summarize, reducerMember names a live member, and
    // there are >1 candidates, dispatch that member after the barrier to combine
    // outputs. Without reducerMember, deliver the reduce guidance to master.
    reducerMember?: string
    reduceStage?: boolean                    // true while the reducer stage is in flight
    reducedResult?: string                   // reducer's combined output; delivered verbatim once set
    // Snapshot of the reducer's mapper-stage response before response cleanup
    // so empty-output retries can
    // rebuild the same input set as the first attempt.
    _reducerMapperSnapshot?: string

    // signoff policy (all orchestration modes except consensus, quorum, and arena).
    // Read un-narrowed by maybeTriggerSignoff/handleSignoffIdle, so Base.
    signoffPolicy?: SignoffPolicy
    signoffDecider?: string                  // member name (decider mode)
    signoffQuorum?: number                   // 0-1, default 0.5 (peer-quorum mode)
    signoffApprovals?: Record<string, boolean>  // collected approvals
    signoffReviewers?: string[]              // reviewers that successfully received the signoff prompt
    signoffParseFailures?: Record<string, number> // consecutive malformed responses by reviewer
    signoffStage?: boolean                   // true when in signoff phase
    signoffRawOutputs?: Record<string, string>  // per-reviewer signoff turn output (side-channel so task.responses preserves work output)

    // human approval policy (mid-run HITL pause; distinct from post-completion signoff)
    humanApproval?: boolean                  // true when configured for modes that support HITL
    approvalStage?: boolean                  // true while paused for team_approve/team_reject
    approvalRequest?: ApprovalRequest        // current pending human approval request
    approvalTimeoutMs?: number               // optional bound on the human approval pause
    onApprovalTimeout?: ApprovalTimeoutAction // default fail when approvalTimeoutMs elapses
    approvalHistory?: ApprovalDecisionRecord[] // resolved approval decisions for audit/history

    // delegate mode: uses shared tasklist (team_task_*), no extra fields
    requireDoneAck?: boolean                 // parallel: all-acked barrier (read un-narrowed in maybeAdvanceBarrier)
    maxErroredMembers?: number               // concurrent/phase-scoped modes (parallel, delegate, recurse, quorum, arena implement): failure isolation (read un-narrowed)
    maxRetries?: number                      // all modes: bounded retry (read un-narrowed)

    // per-orchestration run id (lazily generated at first output capture). Used to
    // key runs/<runId>/ for persistent result records. NOT teamRunId (which is
    // team-constant); each orchestration gets a fresh runId.
    runId?: string
}

/** Fan-out parallel orchestration — all members work in parallel then
 * converge. `tasks` is cooperative per-member work. */
export interface ParallelTask extends ActiveTaskBase {
    type: "parallel"
    tasks?: Record<string, string>           // cooperative: { memberName: task }
    reduceRetries?: number                   // consecutive empty-output reducer re-dispatches
}

/** Linear pipeline — ordered stages; each stage's output is prefixed onto
 * the next stage's input. */
export interface PipelineTask extends ActiveTaskBase {
    type: "pipeline"
}

/** Corrective loop — code, review, decide, repeat until done. */
export interface LoopTask extends ActiveTaskBase {
    type: "loop"
    deciderMember?: string                   // member name of decider (NOT "master")
    maxDecisionParseFailures?: number       // override default parse-failure threshold (default 3)
}

/** Delegate mode — publish tasks to a shared tasklist, members self-claim. */
export interface DelegateTask extends ActiveTaskBase {
    type: "delegate"
}

/** Multi-round structured debate until all members reach consensus. */
export interface ConsensusTask extends ActiveTaskBase {
    type: "consensus"
    topic?: string                           // the debate topic
    consensusReached?: boolean               // set when all members emit agreed consensus
}

/** Content-based routing — a router inspects input and selects branch(es). */
export interface RouteTask extends ActiveTaskBase {
    type: "route"
    routerMember: string                     // the router member name (NOT master, NOT a branch member)
    routeBranches: RouteBranch[]              // caller-declared branches the router selects from
    routeTargets?: string[]                  // resolved target member names after the router's decision
    routeStage: boolean                      // false = router phase; true = target fan-out phase
    routeDecisionRationale?: string          // router's stated rationale (observability)
    maxRouteParseFailures?: number           // override default parse-failure threshold (default 2)
}

/** Binding arbitration — debaters argue, an arbiter issues a ruling. */
export interface ArbitrateTask extends ActiveTaskBase {
    type: "arbitrate"
    arbiterMember?: string                   // the arbiter member name (NOT master, NOT a debater)
    disputants?: string[]                    // debater member names (Phase A barrier participants)
    arbitrationStage?: boolean               // false/undefined = debate phase; true = ruling phase
    arbitrationRuling?: string               // arbiter's binding ruling (set at ruling)
    arbitrationRationale?: string            // arbiter's stated rationale for the ruling
    hitlPhase?: "pre" | "post" | "both"      // HITL pause point(s); default "pre" when humanApproval is true
    maxRulingParseFailures?: number          // override default ruling parse-failure threshold (default 2)
}

/** Hierarchical recursive decomposition with a blockedBy DAG. */
export interface RecurseTask extends ActiveTaskBase {
    type: "recurse"
    decomposerMember?: string                // the member first dispatched with the root task (NOT master)
    maxDepth?: number                        // recursion depth upper bound (default 3)
    maxSubtasks?: number                     // per-decomposition subtask upper bound (default 5)
    rootTaskId?: string                      // the root task id; its result is the final deliverable
    aggregationDispatchCount?: number        // decomposer dispatches that failed to produce a root claim (stall detection; recurse mode)
    maxAggregationDispatches?: number        // override default aggregation stall threshold (default 3)
    // Dedicated counter for malformed <decompose> parse failures so
    // continuous format errors don't burn unlimited tokens.
    decomposeParseFailures?: number
    maxDecomposeParseFailures?: number       // override default (3)
    forcedDirectTaskIds?: string[]
    forcedDirectDecomposeAttempts?: Record<string, number>
    // Times the decomposer tried to direct-solve the root with no
    // sub-tree. Beyond the cap the root is forced-direct (bounded fallback).
    rootDecomposeRefusals?: number
    // Per-task counter for width-cap decomposition retries
    // (guide a narrower split instead of permanently banning decompose).
    narrowDecomposeAttempts?: Record<string, number>
}

/** Verdict-gated pipeline (produce -> verify -> escalate) — advancing
 * depends on a verifier's verdict, not just completion. */
export interface TollgateTask extends ActiveTaskBase {
    type: "tollgate"
    gatedStages: GatedStage[]                 // linear stages, each with its own verification gate
    tollgatePhase: "produce" | "verify" | "escalate"  // explicit three-phase state (avoids a two-value gate-stage deadlock)
    escalateTo?: string                      // INVALID escalation target member (optional; when unset, INVALID is escalated to the leader)
    maxGateRetries?: number                  // gate FAIL retry cap, DISTINCT from provider-retry maxRetries (default 0: first FAIL fails)
    maxInvalidCycles?: number                // cap on INVALID/escalate ping-pong per gate (default 3); beyond it the run fails with tollgate_invalid:exhausted instead of looping to wall-clock
}

/**
 * Declarative workflow orchestration — a task/gate/fanout/join step engine.
 * Linear workflows remain the degenerate case; fanout/join marker steps
 * allow a persisted active frontier without a separate orchestration
 * primitive.
 */
export interface WorkflowTask extends ActiveTaskBase {
    type: "workflow"
    steps: WorkflowStep[]                    // declarative step list; currentStageIndex is the cursor
    activeStepIndices?: number[]             // persisted active frontier for fanout/join; legacy readers fall back to [currentStageIndex]
}

/**
 * Competitive arena — N candidates implement competing solutions in
 * isolated worktrees (implement phase), then a dedicated evaluator scores
 * every surviving candidate (errored candidates stay in `candidates` for
 * audit only) and a deterministic winner is selected over the
 * evaluator-attested scoreboard (evaluate phase). ArenaCandidateScore /
 * ArenaScoreboard are the evaluator's structured report shape.
 */
export interface ArenaTask extends ActiveTaskBase {
    type: "arena"
    task: string                             // required: shared implement task (narrows the optional Base field)
    candidates: string[]                     // ORIGINAL full candidate set (kept for audit)
    survivingCandidates?: string[]           // eligible-to-win subset (candidates that did NOT error), set at implement->evaluate
    evaluatorMember: string                  // the evaluator member name (scores the surviving candidates)
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

/**
 * Replicated voting — N members independently ballot on a fixed-schema
 * question; the option with strict majority (k > valid_ballots/2) wins.
 * Invalid ballots and runtime errors both abstain (excluded from the
 * denominator, not counted as no-votes).
 */
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

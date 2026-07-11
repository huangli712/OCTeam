/**
 * Workflow type definitions — both internal runtime AND external tool API.
 *
 * This file co-locates two related families of workflow types so developers
 * working on workflow features find everything in one place:
 *
 *   1. INTERNAL RUNTIME types (WorkflowStep, Verdict, WorkflowIssue, fanout/
 *      join metadata, ...) — consumed by the orchestration engine
 *      (workflow.ts, workflow-handler.ts, dag.ts, gate.ts, fanout.ts, etc.).
 *
 *   2. EXTERNAL TOOL API types (WorkflowToolStep, WorkflowToolArgs, ...) —
 *      the format the LLM passes via team_workflow tool args and what a
 *      workflow_file JSON contains. lower.ts converts these into the internal
 *      WorkflowStep.
 *
 * Layer 0 in the types decomposition — no imports from other type files.
 */

/** Three-valued verification verdict: PASS, FAIL, or INVALID. */
export type Verdict = "PASS" | "FAIL" | "INVALID"

/** Severity label for a workflow gate issue. */
export type WorkflowIssueSeverity = "low" | "medium" | "high" | "critical"

/** A single issue surfaced by a workflow gate verdict. */
export type WorkflowIssue = {
    severity: WorkflowIssueSeverity
    message?: string
}

/** Threshold condition gating a workflow gate's conditional jump. */
export type WorkflowCondition =
    | { kind: "score_gte"; value: number }
    | { kind: "score_lt"; value: number }
    | { kind: "confidence_gte"; value: number }
    | { kind: "has_issue_severity"; value: WorkflowIssueSeverity }

/** Workflow step kind: task, gate, fanout, or join. */
export type WorkflowStepKind = "task" | "gate" | "fanout" | "join"

/** Workflow gate INVALID verdict control: fail, retry the verifier, or escalate. */
export type WorkflowOnInvalid = "fail" | "retry_verifier" | "escalate"

/** Workflow gate malformed-verdict control: fail, retry, skip, or escalate. */
export type WorkflowOnMalformed = "fail" | "retry_verifier" | "skip" | "escalate"

/** Auto-retry trigger for a workflow task step. */
export type WorkflowRetryCondition =
    | { kind: "empty" }
    | { kind: "output_contains"; pattern: string }
    | { kind: "output_not_contains"; pattern: string }
    | { kind: "regex"; pattern: string }

/** Loop configuration for a gate's on_fail_goto backward iteration. */
export type WorkflowLoopConfig = {
    readonly maxIterations: number
    readonly onExhaust: "fail" | "continue"
}

/** Ensemble verdict aggregation policy: majority, quorum, or unanimous. */
export type WorkflowEnsemblePolicy = "majority" | "quorum" | "unanimous"

/** Structured result from a single verifier in an ensemble gate. */
export type WorkflowEnsembleResult = {
    verdict: Verdict
    score?: number
    confidence?: number
    issues?: WorkflowIssue[]
    rationale?: string
    diff?: string
    parseFailed?: boolean
}

/** Start and end index range for a fanout branch within the step list. */
export type WorkflowBranchRange = {
    readonly startIndex: number
    readonly endIndex: number
}

/** Fanout join semantics: tolerance, all, quorum, any_success, required_branches, reduce, or select. */
export type WorkflowJoinPolicy = "tolerance" | "all" | "quorum" | "any_success" | "required_branches" | "reduce" | "select"

/** Fanout marker metadata — branch ids, ranges, join index, and join policy. */
export type WorkflowFanoutMetadata = {
    readonly branchIds: readonly string[]
    readonly branchRanges: readonly WorkflowBranchRange[]
    readonly joinIndex: number
    readonly maxErrored: number
    readonly joinPolicy?: WorkflowJoinPolicy
    readonly quorum?: number                  // fraction of branches that must succeed (join_policy='quorum'), 0 < quorum <= 1
    readonly requiredBranchIds?: readonly string[]  // branch ids that must succeed (join_policy='required_branches')
    readonly reducerMember?: string           // member who aggregates branch outputs at join (join_policy='reduce' or 'select')
    readonly useSurvivors?: boolean           // when true, strict join policies continue with surviving branches instead of failing on branch errors
}

/** Per-branch metadata for a task/gate step inside a fanout. */
export type WorkflowBranchMetadata = {
    readonly fanoutIndex: number
    readonly branchId: string
    readonly branchIndex: number
    readonly joinIndex: number
}

/** Join marker metadata — collected branch results and survivor/error tracking. */
export type WorkflowJoinMetadata = {
    readonly fanoutIndex: number
    readonly branchTailIndices: readonly number[]
    readonly maxErrored: number
    readonly joinPolicy?: WorkflowJoinPolicy
    readonly quorum?: number
    readonly requiredBranchIds?: readonly string[]
    readonly reducerMember?: string
    readonly useSurvivors?: boolean
    readonly survivorBranchIds?: readonly string[]
    readonly erroredBranchIds?: readonly string[]
    readonly selectedBranchId?: string
    readonly selectionRationale?: string
    readonly joinedOutput?: string
}

/** A single workflow step — task, gate, fanout marker, or join marker. */
export type WorkflowStep = {
    kind: WorkflowStepKind
    id?: string                         // stable step identifier (optional); when set, gates may reference it via targetStepId
    // task step
    member?: string                     // the actor member name (task steps)
    fallbackMember?: string
    task?: string                       // the task text (task steps)
    // gate step
    verifier?: string                   // the verifier member name (gate steps; NOT the preceding task's member)
    fallbackVerifier?: string
    verifiers?: readonly string[]            // gate steps: multiple verifiers for ensemble verdict (mutually exclusive with verifier)
    ensemblePolicy?: WorkflowEnsemblePolicy  // gate steps: aggregation policy for ensemble verdict
    ensembleQuorum?: number                  // gate steps: quorum fraction (0 < quorum <= 1) for ensemble_policy='quorum'
    ensembleResults?: Record<string, WorkflowEnsembleResult>  // gate steps: per-verifier results (runtime)
    criteria?: string                   // verification criteria (gate steps)
    targetStepIndex?: number            // gate steps: zero-based primary task step being verified; omitted means nearest preceding task
    targetStepIndices?: number[]        // gate steps: zero-based multi-target task steps; targetStepIndex remains the primary/legacy target
    onFail?: "retry" | "fail" | "skip"  // FAIL control: retry the preceding task, fail the run, or skip this gate (gate steps; default "fail")
    maxRetries?: number                 // FAIL retry cap, distinct from provider-retry maxRetries (gate steps; default 0)
    attempts?: number                   // FAIL retry count so far (gate steps)
    onInvalid?: WorkflowOnInvalid       // INVALID control: fail the run, re-dispatch the verifier, or escalate to the leader (gate steps; default "fail")
    maxInvalidRetries?: number          // retry_verifier cap for INVALID verdicts (gate steps; default 0)
    invalidAttempts?: number            // retry_verifier attempt count so far (gate steps)
    onMalformed?: WorkflowOnMalformed   // parse_failure control: fail, retry_verifier, skip, or escalate. Falls back to onInvalid when unset (gate steps)
    maxMalformedRetries?: number        // retry_verifier cap for malformed verdicts (gate steps; default 0)
    malformedAttempts?: number          // retry_verifier attempt count for malformed verdicts (gate steps)
    verdict?: Verdict                   // last verdict rendered (gate steps)
    score?: number                      // optional structured score from the last verdict (gate steps)
    confidence?: number                 // optional structured confidence from the last verdict (gate steps)
    issues?: WorkflowIssue[]            // optional structured issues from the last verdict (gate steps)
    inputs?: number[]
    exposeOutput?: boolean
    retryOn?: WorkflowRetryCondition    // task steps: auto-retry condition (empty output, output contains/missing pattern, regex match)
    maxTaskRetries?: number             // task steps: max auto-retry attempts (default 0)
    taskAttempts?: number               // task steps: auto-retry attempt count so far
    // conditional jumps: verdict-gated goto targets (0-based internal index,
    // resolved at build time from a 1-based number or step id). Omitted = the
    // verdict's default behavior (PASS: advance; FAIL/INVALID: terminate).
    onPassGoto?: number                 // after PASS: jump here instead of advancing linearly
    onFailGoto?: number                 // at a FAIL terminal point (on_fail=fail, or retry exhausted): jump instead of failing
    onInvalidGoto?: number              // at an INVALID terminal point (on_invalid=fail, or retry_verifier exhausted): jump instead of terminating. NOT applied to escalate.
    where?: WorkflowCondition           // optional threshold condition gating on_pass_goto/on_fail_goto
    maxJumps?: number                   // per-gate cap on verdict-driven jumps; default 3, max 10
    jumpCount?: number                  // verdict-driven jumps taken so far at this gate
    loop?: WorkflowLoopConfig           // gate steps: loop control for on_fail_goto (bounds iterations + exhaust behavior)
    loopIterations?: number             // gate steps: loop iteration count so far (runtime)
    output?: string                     // task steps: captured output snapshot at completion time (per-step, NOT overwritten by later steps the same member runs)
    // step-level controls: per-step HITL pauses and output cap,
    // overriding/complementing the task-global humanApproval flag.
    approvalBefore?: boolean            // pause for team_approve before dispatching this step
    approvalAfter?: boolean             // pause for team_approve after this step completes, before advancing
    approvalBeforeGranted?: boolean     // transient: approval_before was requested for the current step instance; consumed on dispatch, reset on re-entry (retry/goto-back)
    maxOutputBytes?: number             // task steps: cap the captured output snapshot to N UTF-8 bytes (head+tail preserved)
    timeoutMs?: number                  // task/gate steps: wall-clock deadline from dispatch time
    onTimeout?: "fail" | "retry" | "skip" // timeout control; default fail
    maxTimeoutRetries?: number          // timeout retry cap when onTimeout=retry
          timeoutAttempts?: number      // timeout retry attempts so far
          startedAt?: number
          completedAt?: number
          durationMs?: number
          dispatchedAt?: number         // epoch ms when this step was last dispatched
          dispatchedActor?: string
          correlationId?: string        // links this step's dispatch/capture/verdict events in events.jsonl
    // fanout/join DAG metadata. Runtime dispatch wiring lands in a
    // later task.
    fanout?: WorkflowFanoutMetadata     // fanout marker steps
    branch?: WorkflowBranchMetadata     // task/gate steps inside a fanout branch
    join?: WorkflowJoinMetadata         // join marker steps
    // shared
    completed: boolean                  // true when the step is done (task produced; gate PASS; or skipped by a forward jump)
    skipped?: boolean                   // true when a forward jump marked this step as skipped (not run)
}

// ============================================================================
// EXTERNAL TOOL API TYPES
//
// The format the LLM passes via team_workflow tool args and what a
// workflow_file JSON contains. lower.ts (tools/lower.ts) converts these into
// the internal WorkflowStep defined above. Consumed by tools/workflow.ts
// (tool definition + schema), tools/validate.ts (cross-field validation),
// and orchestration/file.ts (workflow_file JSON loader).
// ============================================================================

/** Conditional threshold for gate-step branching (goto control). */
export type WorkflowWhere = {
    readonly score_gte?: number
    readonly score_lt?: number
    readonly confidence_gte?: number
    readonly has_issue_severity?: "low" | "medium" | "high" | "critical"
}

/** A step reference: 1-based index or stable step id. */
export type WorkflowStepRef = number | string

/** A branch inside a fanout step with its own sub-steps. */
export type WorkflowFanoutBranch = {
    readonly id: string
    readonly steps: readonly WorkflowToolStep[]
}

/** A single workflow step (task, gate, fanout, or join marker). */
export type WorkflowToolStep = {
    readonly kind: "task" | "gate" | "fanout" | "join"
    readonly id?: string
    readonly member?: string
    readonly fallback_member?: string
    readonly task?: string
    readonly verifier?: string
    readonly fallback_verifier?: string
    readonly verifiers?: readonly string[]
    readonly ensemble_policy?: "majority" | "quorum" | "unanimous"
    readonly ensemble_quorum?: number
    readonly criteria?: string
    readonly target_step?: WorkflowStepRef
    readonly targets?: readonly WorkflowStepRef[]
    readonly inputs?: readonly WorkflowStepRef[]
    readonly expose_output?: boolean
    readonly retry_on?: { readonly empty?: boolean; readonly output_contains?: string; readonly output_not_contains?: string; readonly regex?: string }
    readonly max_task_retries?: number
    readonly on_fail?: "retry" | "fail" | "skip"
    readonly max_retries?: number
    readonly on_invalid?: "fail" | "retry_verifier" | "escalate"
    readonly on_malformed?: "fail" | "retry_verifier" | "skip" | "escalate"
    readonly max_malformed_retries?: number
    readonly max_invalid_retries?: number
    readonly on_pass_goto?: WorkflowStepRef
    readonly on_fail_goto?: WorkflowStepRef
    readonly on_invalid_goto?: WorkflowStepRef
    readonly where?: WorkflowWhere
    readonly approval_before?: boolean
    readonly approval_after?: boolean
    readonly max_output_bytes?: number
    readonly timeout_ms?: number
    readonly on_timeout?: "fail" | "retry" | "skip"
    readonly max_timeout_retries?: number
    readonly max_jumps?: number
    readonly loop?: { readonly max_iterations: number; readonly on_exhaust?: "fail" | "continue" }
    readonly branches?: readonly WorkflowFanoutBranch[]
    readonly max_errored?: number
    readonly join_policy?: "all" | "quorum" | "any_success" | "required_branches" | "reduce" | "select"
    readonly quorum?: number
    readonly required_branches?: readonly string[]
    readonly reducer_member?: string
    readonly use_survivors?: boolean
    readonly matrix?: Readonly<Record<string, readonly string[]>>
    readonly foreach?: readonly string[]
    readonly as?: string
    readonly steps?: readonly WorkflowToolStep[]
}

/** A linear (non-fanout) workflow step narrowed to kind "task" or "gate". */
export type WorkflowLinearToolStep = WorkflowToolStep & { readonly kind: "task" | "gate" }

/** A fanout workflow step narrowed to kind "fanout". */
export type WorkflowFanoutToolStep = WorkflowToolStep & { readonly kind: "fanout" }

/** Public args for the team_workflow tool. */
export type WorkflowToolArgs = {
    team_id: string
    steps?: readonly WorkflowToolStep[]
    workflow_file?: string
    vars?: Record<string, string>
    dry_run?: boolean
    signoff_policy?: "none" | "decider" | "peer-quorum"
    signoff_decider?: string
}

/** Resolved workflow args after loading steps from file and expanding matrix/foreach. */
export type ResolvedWorkflowToolArgs = Omit<WorkflowToolArgs, "steps"> & { steps: readonly WorkflowToolStep[] }

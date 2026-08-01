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

// ============================================================================
// INTERNAL RUNTIME TYPES
//
// Consumed by the orchestration engine (workflow.ts, workflow-handler.ts,
// dag.ts, gate.ts, fanout.ts, etc.).
// ============================================================================

// ---------------------------------------------------------------------------
// Verdict & gate issue primitives
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Step control primitives (kinds, retry, loop, ensemble, verdict policies)
// ---------------------------------------------------------------------------

/** Workflow step kind: task, gate, fanout, or join. */
export type WorkflowStepKind = "task" | "gate" | "fanout" | "join"

/** Workflow gate INVALID verdict control: fail, retry the verifier, or escalate. */
type WorkflowOnInvalid = "fail" | "retry_verifier" | "escalate"

/** Workflow gate malformed-verdict control: fail, retry, skip, or escalate. */
type WorkflowOnMalformed = "fail" | "retry_verifier" | "skip" | "escalate"

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
type WorkflowEnsemblePolicy = "majority" | "quorum" | "unanimous"

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

// ---------------------------------------------------------------------------
// Fanout / join metadata
// ---------------------------------------------------------------------------

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

/** Join marker metadata — collected branch results and survivor/error tracking.
 * Structural fields (fanoutIndex, branchTailIndices, maxErrored, joinPolicy,
 * quorum, requiredBranchIds, reducerMember, useSurvivors) are readonly.
 * Runtime fields (survivorBranchIds, erroredBranchIds, selectedBranchId,
 * selectionRationale, joinedOutput) are mutable so FAIL-retry and backward
 * jumps can reset them. */
export type WorkflowJoinMetadata = {
    readonly fanoutIndex: number
    readonly branchTailIndices: readonly number[]
    readonly maxErrored: number
    readonly joinPolicy?: WorkflowJoinPolicy
    readonly quorum?: number
    readonly requiredBranchIds?: readonly string[]
    readonly reducerMember?: string
    readonly useSurvivors?: boolean
    survivorBranchIds?: readonly string[]
    erroredBranchIds?: readonly string[]
    selectedBranchId?: string
    selectionRationale?: string
    joinedOutput?: string
}

// ---------------------------------------------------------------------------
// WorkflowStep — discriminated union of per-kind runtime step variants
// ---------------------------------------------------------------------------

/**
 * Shared runtime fields common to ALL step kinds. Every variant includes
 * these via intersection. NOTE: WorkflowRunStep (persisted JSON) is defined
 * INDEPENDENTLY in runs.ts and does NOT derive from this type — the union
 * base is intentionally slim (kind-specific fields live on each variant).
 */
export type WorkflowStepRuntime = {
    id?: string
    completed: boolean
    skipped?: boolean
    output?: string
    startedAt?: number
    completedAt?: number
    durationMs?: number
    inputs?: number[]
    exposeOutput?: boolean
    dispatchedAt?: number
    dispatchedActor?: string
    correlationId?: string
    approvalBefore?: boolean
    approvalBeforeGranted?: boolean
    approvalAfter?: boolean
    maxOutputBytes?: number
    timeoutMs?: number
    onTimeout?: "fail" | "retry" | "skip"
    maxTimeoutRetries?: number
    timeoutAttempts?: number
    branch?: WorkflowBranchMetadata
}

/** Runtime task step variant — executed by a member. */
export type WorkflowTaskStep = WorkflowStepRuntime & {
    kind: "task"
    member: string
    task: string
    fallbackMember?: string
    retryOn?: WorkflowRetryCondition
    maxTaskRetries?: number
    taskAttempts?: number
}

/** Runtime gate step variant — executed by a verifier. */
export type WorkflowGateStep = WorkflowStepRuntime & {
    kind: "gate"
    verifier?: string
    verifiers?: readonly string[]
    fallbackVerifier?: string
    ensemblePolicy?: WorkflowEnsemblePolicy
    ensembleQuorum?: number
    ensembleResults?: Record<string, WorkflowEnsembleResult>
    criteria?: string
    targetStepIndex?: number
    targetStepIndices?: number[]
    verdict?: Verdict
    score?: number
    confidence?: number
    issues?: WorkflowIssue[]
    where?: WorkflowCondition
    onFail?: "retry" | "fail" | "skip"
    maxRetries?: number
    onInvalid?: WorkflowOnInvalid
    onMalformed?: WorkflowOnMalformed
    maxInvalidRetries?: number
    maxMalformedRetries?: number
    invalidAttempts?: number
    malformedAttempts?: number
    attempts?: number
    onPassGoto?: number
    onFailGoto?: number
    onInvalidGoto?: number
    maxJumps?: number
    jumpCount?: number
    loop?: WorkflowLoopConfig
    loopIterations?: number
}

/** Runtime fanout marker variant. */
export type WorkflowFanoutStep = WorkflowStepRuntime & {
    kind: "fanout"
    fanout: WorkflowFanoutMetadata
}

/** Runtime join marker variant. */
export type WorkflowJoinStep = WorkflowStepRuntime & {
    kind: "join"
    join: WorkflowJoinMetadata
}

/** A single workflow step — discriminated union on `kind`. */
export type WorkflowStep =
    | WorkflowTaskStep
    | WorkflowGateStep
    | WorkflowFanoutStep
    | WorkflowJoinStep

// ============================================================================
// EXTERNAL TOOL API TYPES
//
// The format the LLM passes via team_workflow tool args and what a
// workflow_file JSON contains. lower.ts (tools/lower.ts) converts these into
// the internal WorkflowStep defined above. Consumed by tools/workflow.ts
// (tool definition + schema), tools/validate.ts (cross-field validation),
// and orchestration/workflow/loader.ts (workflow_file JSON loader).
// ============================================================================

// ---------------------------------------------------------------------------
// Tool API: step-reference & condition helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool API: WorkflowToolStep & narrowed variants
// ---------------------------------------------------------------------------

/** Shared fields across all workflow step kinds (tool API). */
type WorkflowToolStepBase = {
    readonly id?: string
    readonly inputs?: readonly WorkflowStepRef[]
    readonly expose_output?: boolean
    readonly approval_before?: boolean
    readonly approval_after?: boolean
    readonly max_output_bytes?: number
    readonly timeout_ms?: number
    readonly on_timeout?: "fail" | "retry" | "skip"
    readonly max_timeout_retries?: number
}

/** Tool API task step — executed by a member. */
export type WorkflowTaskToolStep = WorkflowToolStepBase & {
    readonly kind: "task"
    readonly member?: string
    readonly fallback_member?: string
    readonly task?: string
    readonly retry_on?: { readonly empty?: boolean; readonly output_contains?: string; readonly output_not_contains?: string; readonly regex?: string }
    readonly max_task_retries?: number
}

/** Tool API gate step — executed by a verifier. */
export type WorkflowGateToolStep = WorkflowToolStepBase & {
    readonly kind: "gate"
    readonly verifier?: string
    readonly fallback_verifier?: string
    readonly verifiers?: readonly string[]
    readonly ensemble_policy?: "majority" | "quorum" | "unanimous"
    readonly ensemble_quorum?: number
    readonly criteria?: string
    readonly target_step?: WorkflowStepRef
    readonly targets?: readonly WorkflowStepRef[]
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
    readonly max_jumps?: number
    readonly loop?: { readonly max_iterations: number; readonly on_exhaust?: "fail" | "continue" }
}

/** Tool API fanout step — spawns parallel branches with join metadata. */
export type WorkflowFanoutToolStep = WorkflowToolStepBase & {
    readonly kind: "fanout"
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

/** Tool API join step — companion marker for the preceding fanout. */
export type WorkflowJoinToolStep = WorkflowToolStepBase & {
    readonly kind: "join"
    readonly join_policy?: "all" | "quorum" | "any_success" | "required_branches" | "reduce" | "select"
    readonly quorum?: number
    readonly required_branches?: readonly string[]
    readonly reducer_member?: string
    readonly use_survivors?: boolean
}

/** Discriminated union of all workflow step kinds (tool API). */
export type WorkflowToolStep =
    | WorkflowTaskToolStep
    | WorkflowGateToolStep
    | WorkflowFanoutToolStep
    | WorkflowJoinToolStep

/** A linear (non-fanout) workflow step narrowed to kind "task" or "gate". */
export type WorkflowLinearToolStep = WorkflowTaskToolStep | WorkflowGateToolStep

// ---------------------------------------------------------------------------
// Tool API: top-level args
// ---------------------------------------------------------------------------

/** Public args for the team_workflow tool. */
export type WorkflowToolArgs = {
    team_id: string
    steps?: readonly WorkflowToolStep[]
    workflow_file?: string
    vars?: Record<string, string>
    dry_run?: boolean
    // L3: include the 5 tool-level fields that the runtime accepts but the
    // type omitted. Without these, direct callers using WorkflowToolArgs get
    // excess-property errors and ResolvedWorkflowToolArgs loses them.
    signoff_policy?: "none" | "decider" | "peer-quorum"
    signoff_decider?: string
    signoff_quorum?: number
    human_approval?: boolean
    timeout_ms?: number
    token_budget?: number
    max_retries?: number
}

/** Resolved workflow args after loading steps from file and expanding matrix/foreach. */
export type ResolvedWorkflowToolArgs = Omit<WorkflowToolArgs, "steps"> & { steps: readonly WorkflowToolStep[] }

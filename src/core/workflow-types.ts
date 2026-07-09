/**
 * Public workflow type definitions shared across the tools and orchestration
 * layers.
 *
 * These types describe the EXTERNAL workflow step format — what the LLM passes
 * via the team_workflow tool args and what a workflow_file JSON contains. They
 * are consumed by:
 *   - tools/workflow.ts (tool definition + schema)
 *   - tools/lower.ts (lowering to the internal WorkflowStep representation)
 *   - tools/validate.ts (cross-field validation)
 *   - orchestration/file.ts (workflow_file JSON loader)
 *
 * Living in core/ (not tools/) avoids an upward dependency from orchestration/
 * to tools/. The internal runtime WorkflowStep type stays in types.ts.
 *
 * All types here are self-contained — no imports from other modules — so they
 * can be moved into a per-domain type file during the types.ts decomposition
 * without creating new coupling.
 */

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

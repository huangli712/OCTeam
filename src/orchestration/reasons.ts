/**
 * Single source of truth for team_workflow run-termination reason strings.
 *
 * Every finishRun reason emitted by the workflow engine is built here so the
 * surface stays consistent and grep-able. `runStatusFromReason` (runs.ts)
 * classifies a run as failed by matching the prefixes in
 * WORKFLOW_FAILED_REASON_PREFIXES, so any new failure reason MUST be added
 * there too — the builders below are the call-site contract, the prefixes are
 * the classifier contract.
 *
 * Backward compatibility: the builders produce the EXACT strings the engine
 * used to inline, so persisted run records and existing tests are unaffected.
 */

/** Reason emitted when every step completes and signoff (if any) passes. */
export function workflowCompleteReason(): string {
    return "workflow_complete"
}

/** Reason emitted when a gate renders a terminal FAIL (onFail='fail', or retries exhausted). */
export function workflowGateFailReason(verifier: string | undefined): string {
    return `workflow_failed:${verifier ?? "unknown"}`
}

/** Reason emitted when a gate's verdict-driven jump cap is exceeded. */
export function workflowJumpLimitReason(verifier: string | undefined): string {
    return `workflow_failed:jump_limit:${verifier ?? "unknown"}`
}

/** Reason emitted when an actor has no live session at dispatch time. */
export function workflowNoSessionReason(actor: string | undefined): string {
    return `workflow_failed:no_session:${actor ?? "unknown"}`
}

/** Reason emitted when a gate verdict cannot be evaluated (INVALID or parse failure). */
export function workflowInvalidReason(reason: "INVALID" | "parse_failure", verifier: string | undefined): string {
    return `workflow_invalid:${reason}:${verifier ?? "unknown"}`
}

/** Reason emitted when an active step exceeds its timeout_ms with on_timeout='fail' (or retry exhaustion). */
export function workflowTimeoutStepReason(displayStep: number): string {
    return `workflow_timeout:step:${displayStep}`
}

/** Reason emitted when a fanout has zero surviving branches. */
export function workflowFanoutAllErroredReason(fanoutDisplayStep: number): string {
    return `workflow_failed:fanout:${fanoutDisplayStep}:all_errored`
}

/** Reason emitted when a fanout's errored branch count exceeds max_errored / join_policy tolerance. */
export function workflowFanoutOverToleranceReason(fanoutDisplayStep: number): string {
    return `workflow_failed:fanout:${fanoutDisplayStep}:over_tolerance`
}

/** Reason emitted by team_fix_workflow op='fail' (operator-supplied, sanitized). */
export function workflowOperatorFailReason(sanitizedReason: string): string {
    return `workflow_failed:${sanitizedReason}`
}

/**
 * Substrings that mark a workflow run as failed. Mirrored into the global
 * FAILED_REASON_MARKERS classifier in runs.ts — keep both in sync when adding
 * a new failure reason.
 */
export const WORKFLOW_FAILED_REASON_PREFIXES = [
    "workflow_failed",
    "workflow_invalid",
    "workflow_timeout",
] as const

/** Stable workflow reason prefixes (success + failure) for tests and UI. */
export const WORKFLOW_REASON_PREFIXES = [
    "workflow_complete",
    ...WORKFLOW_FAILED_REASON_PREFIXES,
] as const

/**
 * Dry-run formatting for lowered workflow steps. Produces the human-readable
 * preview shown by `team_workflow --dry_run` and the "resolved steps" section
 * of error messages.
 *
 * This module owns presentation so the lowering engine stays focused on
 * reference resolution and step flattening.
 */

import type {
    WorkflowStepRef,
    ResolvedWorkflowToolArgs
} from "../../core/types/workflow.js"
import {
    parseWorkflowCondition,
    formatWorkflowCondition
} from "../../orchestration/workflow/gate.js"
//
import type {
    LoweredWorkflowLinearStep,
    LoweredWorkflowStep,
} from "./lower.js"
import {
    lowerWorkflowSteps,
    resolveGateTargetIndices,
    resolveGotoIndex,
    resolveWorkflowInputIndices,
} from "./lower.js"

/** Format the target step label (with optional id) for a gate in dry-run output. */
function stepTargetLabel(steps: readonly LoweredWorkflowStep[], gateIndex: number): string {
    const targetIndices = resolveGateTargetIndices(steps, gateIndex)
    if (targetIndices.length === 0) return "?"
    const labels = targetIndices.map(targetIndex => {
        const targetId = steps[targetIndex]?.id
        return targetId ? `${targetIndex + 1} (${targetId})` : `${targetIndex + 1}`
    })
    const first = labels[0]
    if (first === undefined) return "?"
    return labels.length === 1 ? `step ${first}` : `steps ${labels.join(", ")}`
}

/** Format a step label with optional id for dry-run display. */
function workflowStepLabel(steps: readonly LoweredWorkflowStep[], index: number): string {
    const id = steps[index]?.id
    return id ? `step ${index + 1} (${id})` : `step ${index + 1}`
}

/** Format task input dependencies label, or null if no explicit inputs. */
function taskInputsLabel(steps: readonly LoweredWorkflowStep[], taskIndex: number): string | null {
    const inputIndices = resolveWorkflowInputIndices(steps, taskIndex)
    if (inputIndices === undefined) return null
    return `inputs=${inputIndices.map(index => workflowStepLabel(steps, index)).join(", ")}`
}

/** Format a where clause as a human-readable "when ..." string. */
function whereLabel(where: import("../../core/types/workflow.js").WorkflowWhere | undefined): string {
    if (where === undefined) return ""
    const parsed = parseWorkflowCondition(where)
    return "condition" in parsed ? ` when ${formatWorkflowCondition(parsed.condition)}` : ""
}

/** Format a goto reference as "step N (id)" or "?" if unresolvable. */
function gotoRefLabel(steps: readonly LoweredWorkflowStep[], gateIndex: number, ref: WorkflowStepRef): string {
    const idx = resolveGotoIndex(steps, gateIndex, ref)
    const id = idx >= 0 ? steps[idx]?.id : undefined
    return id ? `step ${idx + 1} (${id})` : idx >= 0 ? `step ${idx + 1}` : "?"
}

/** Return branch header lines for dry-run output, tracking active branch to avoid duplicates. */
function branchDryRunPrefix(
    step: LoweredWorkflowLinearStep,
    activeBranchId: string | undefined,
): { readonly lines: readonly string[]; readonly activeBranchId: string | undefined } {
    const branchId = step.branchContext?.branchId
    if (branchId === undefined) return { lines: [], activeBranchId: undefined }
    if (branchId === activeBranchId) return { lines: [], activeBranchId }
    return { lines: [`  branch ${branchId}:`], activeBranchId: branchId }
}

/** Format a dry-run preview of resolved workflow steps for human review. */
export function formatWorkflowDryRun(args: ResolvedWorkflowToolArgs): string {
    const loweredSteps = lowerWorkflowSteps(args.steps)
    const lines = [`Workflow dry run for "${args.team_id}" (${loweredSteps.length} step(s)):`]
    let activeBranchId: string | undefined
    for (let i = 0; i < loweredSteps.length; i++) {
        const step = loweredSteps[i]
        if (step === undefined) continue
        const idTag = step.id ? ` (${step.id})` : ""
        switch (step.kind) {
            case "task": {
                const branchPrefix = branchDryRunPrefix(step, activeBranchId)
                activeBranchId = branchPrefix.activeBranchId
                lines.push(...branchPrefix.lines)
                const controls: string[] = []
                if (step.approval_before) controls.push("approval_before")
                if (step.approval_after) controls.push("approval_after")
                if (step.fallback_member !== undefined) controls.push(`fallback_member=${step.fallback_member}`)
                if (step.max_output_bytes !== undefined) controls.push(`max_output_bytes=${step.max_output_bytes}`)
                if (step.expose_output === false) controls.push("expose_output=false")
                const inputs = taskInputsLabel(loweredSteps, i)
                if (inputs !== null) controls.push(inputs)
                const ctrlTag = controls.length > 0 ? `  [${controls.join(", ")}]` : ""
                const indent = step.branchContext === undefined ? "" : "  "
                lines.push(`${indent}${i + 1}. [task]${idTag} ${step.member ?? "?"}: ${step.task ?? ""}${ctrlTag}`)
                break
            }
            case "gate": {
                const branchPrefix = branchDryRunPrefix(step, activeBranchId)
                activeBranchId = branchPrefix.activeBranchId
                lines.push(...branchPrefix.lines)
                const controls: string[] = []
                if (step.approval_before) controls.push("approval_before")
                if (step.approval_after) controls.push("approval_after")
                if (step.fallback_verifier !== undefined) controls.push(`fallback_verifier=${step.fallback_verifier}`)
                const ctrlTag = controls.length > 0 ? `  [${controls.join(", ")}]` : ""
                const target = stepTargetLabel(loweredSteps, i)
                const retry = step.on_fail === "retry"
                    ? `; on_fail=retry max_retries=${step.max_retries}`
                    : step.on_fail === "skip" ? "; on_fail=skip" : ""
                const invalid = step.on_invalid && step.on_invalid !== "fail"
                    ? `; on_invalid=${step.on_invalid}`
                        + (step.on_invalid === "retry_verifier"
                            ? ` max_invalid_retries=${step.max_invalid_retries}`
                            : "")
                    : ""
                const jumps: string[] = []
                const where = whereLabel(step.where)
                if (step.on_pass_goto !== undefined) {
                    jumps.push(`on_pass->${gotoRefLabel(loweredSteps, i, step.on_pass_goto)}${where}`)
                }
                if (step.on_fail_goto !== undefined) {
                    jumps.push(`on_fail->${gotoRefLabel(loweredSteps, i, step.on_fail_goto)}${where}`)
                }
                if (step.on_invalid_goto !== undefined) {
                    jumps.push(`on_invalid->${gotoRefLabel(loweredSteps, i, step.on_invalid_goto)}`)
                }
                const jumpTag = jumps.length > 0 ? `; ${jumps.join(" ")} (max_jumps=${step.max_jumps ?? 3})` : ""
                const indent = step.branchContext === undefined ? "" : "  "
                // Include ensemble policy and verifier details so reviewers see
                // the complete gate configuration.
                const verifierLabel = step.verifiers !== undefined && step.verifiers.length > 0
                    ? `${step.verifiers.join("+")} (${step.ensemble_policy ?? "majority"}`
                        + `${step.ensemble_quorum !== undefined ? ` quorum=${step.ensemble_quorum}` : ""})`
                    : step.verifier ?? "?"
                const malformedTag = step.on_malformed && step.on_malformed !== "fail"
                    ? `; on_malformed=${step.on_malformed}`
                        + `${step.max_malformed_retries !== undefined ? ` max_malformed_retries=${step.max_malformed_retries}` : ""}`
                    : ""
                lines.push(
                    `${indent}${i + 1}. [gate]${idTag} ${verifierLabel} verifies ${target}:`
                    + ` ${step.criteria ?? ""}${retry}${invalid}${malformedTag}${jumpTag}${ctrlTag}`,
                )
                break
            }
            case "fanout": {
                activeBranchId = undefined
                const join = loweredSteps[step.fanout.joinIndex]
                const joinIdTag = join?.id ? ` (${join.id})` : ""
                const controls = [`max_errored=${step.fanout.maxErrored}`]
                if (step.fanout.joinPolicy !== undefined) controls.push(`join_policy=${step.fanout.joinPolicy}`)
                if (step.fanout.quorum !== undefined) controls.push(`quorum=${step.fanout.quorum}`)
                if (step.fanout.requiredBranchIds !== undefined) {
                    controls.push(`required_branches=${step.fanout.requiredBranchIds.join(",")}`)
                }
                if (step.fanout.reducerMember !== undefined) {
                    controls.push(`reducer_member=${step.fanout.reducerMember}`)
                }
                if (step.fanout.useSurvivors === true) controls.push("use_survivors=true")
                lines.push(
                    `${i + 1}. [fanout]${idTag} branches: ${step.fanout.branchIds.join(", ")}`
                    + ` -> join step ${step.fanout.joinIndex + 1}${joinIdTag}; ${controls.join("; ")}`,
                )
                break
            }
            case "join": {
                activeBranchId = undefined
                const fanout = loweredSteps[step.join.fanoutIndex]
                const branchIds = fanout?.kind === "fanout" ? fanout.fanout.branchIds : []
                const controls = [`max_errored=${step.join.maxErrored}`]
                if (step.join.joinPolicy !== undefined) controls.push(`join_policy=${step.join.joinPolicy}`)
                if (step.join.reducerMember !== undefined) controls.push(`reducer_member=${step.join.reducerMember}`)
                if (step.join.useSurvivors === true) controls.push("use_survivors=true")
                const joinBehavior = step.join.joinPolicy === "any_success"
                    ? "continues after the first successful branch"
                    : "waits for all branches to reach a terminal state before applying join policy"
                lines.push(
                    `${i + 1}. [join]${idTag} ${joinBehavior}; branches: ${branchIds.join(", ")}; ${controls.join("; ")}`,
                )
                break
            }
            default:
                assertNeverDryRun(step)
        }
    }
    return lines.join("\n")
}

/**
 * Local exhaustiveness guard for dry-run formatting (same pattern as lower.ts
 * but scoped to this module). Throws if a new step kind is added without a
 * corresponding case in formatWorkflowDryRun.
 */
function assertNeverDryRun(value: never): never {
    throw new Error(`Unexpected workflow step kind in dry-run: ${String(value)}`)
}

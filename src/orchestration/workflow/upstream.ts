/**
 * Workflow upstream-context construction: builds the prefix of prior
 * completed TASK-step outputs and completed joins' joinedOutput injected into
 * a task step's dispatch prompt.
 *
 * Gate-step verdicts are skipped because they are control-flow, not work
 * product. Each output block is individually truncated, then budgeted at
 * MAX_UPSTREAM_OUTPUT_BYTES total bytes (soft cap — separators count against
 * the budget; only the truncation marker falls outside).
 */

import type { WorkflowStep } from "../../core/types.js";
import { truncateOutput } from "../protocol/output.js";
import { assertNeverWorkflowStepKind, isSameWorkflowBranch } from "./dag.js";

/** Total byte budget for injected upstream context. */
export const MAX_UPSTREAM_OUTPUT_BYTES = 65_536;

/**
 * Build the upstream-context prefix for a workflow task step: completed
 * prior TASK-step outputs and completed joins' joinedOutput (gate steps are
 * skipped -- their verdicts are control-flow, not work product), each
 * labelled and individually truncated, then capped at
 * MAX_UPSTREAM_OUTPUT_BYTES total bytes. When the step declares explicit
 * `inputs`, only those steps are injected; otherwise every prior completed
 * step visible in this context — steps with expose_output=false and steps
 * on a different branch are excluded.
 * Returns "" when there is no completed upstream output.
 */
export function buildWorkflowUpstream(
    steps: WorkflowStep[],
    uptoIndex: number,
): string {
    const explicitInputs = steps[uptoIndex]?.inputs;
    const inputIndices =
        explicitInputs ??
        Array.from({ length: uptoIndex }, (_, index) => index);
    let used = 0;
    const collected: string[] = []
    for (let idx = inputIndices.length - 1; idx >= 0; idx--) {
        const i = inputIndices[idx]!
        const s = steps[i];
        if (!s?.completed) continue;
        const block = workflowUpstreamBlock(steps, uptoIndex, i, explicitInputs !== undefined);
        if (block === null) continue;
        const sep = collected.length === 0 ? "" : "\n\n";
        const sepBytes = Buffer.byteLength(sep, "utf8");
        const blockBytes = Buffer.byteLength(block, "utf8");
        if (used + sepBytes + blockBytes > MAX_UPSTREAM_OUTPUT_BYTES) {
            collected.unshift(`[...upstream truncated at ${MAX_UPSTREAM_OUTPUT_BYTES} bytes]`);
            break;
        }
        collected.unshift(block);
        used += sepBytes + blockBytes;
    }
    return collected.join("\n\n");
}

/** Build a single upstream-context block for a completed step, or null if it should be skipped. */
function workflowUpstreamBlock(
    steps: WorkflowStep[],
    uptoIndex: number,
    candidateIndex: number,
    explicit: boolean,
): string | null {
    const candidate = steps[candidateIndex];
    if (candidate === undefined || !candidate.completed) return null;

    switch (candidate.kind) {
        case "task": {
            if (!candidate.member || !candidate.output) return null;
            if (
                !shouldIncludeTaskUpstream(
                    steps,
                    uptoIndex,
                    candidateIndex,
                    explicit,
                )
            )
                return null;
            const label = `[Output from ${candidate.member}]\n`;
            return label + truncateOutput(
                candidate.output,
                MAX_UPSTREAM_OUTPUT_BYTES - Buffer.byteLength(label, "utf8"),
            );
        }
        case "join": {
            const joinedOutput = candidate.join?.joinedOutput;
            // An explicit `inputs` reference to a join step is legitimate even
            // from within a branch (the author chose to depend on the join
            // result). Without this, shouldIncludeJoinUpstream would silently
            // drop the dependency.
            if (!joinedOutput || (!explicit && !shouldIncludeJoinUpstream(steps, uptoIndex)))
                return null;
            const label = `[Joined output from workflow step ${candidateIndex + 1}]\n`;
            return label + truncateOutput(
                joinedOutput,
                MAX_UPSTREAM_OUTPUT_BYTES - Buffer.byteLength(label, "utf8"),
            );
        }
        case "gate":
        case "fanout":
            return null;
        default:
            throw assertNeverWorkflowStepKind(candidate);
    }
}

/**
 * Decide whether a completed task-step's output should appear in the upstream
 * context of the current step. Skips when exposeOutput is false (non-explicit
 * context) or when the candidate is on a different branch.
 */
function shouldIncludeTaskUpstream(
    steps: WorkflowStep[],
    uptoIndex: number,
    candidateIndex: number,
    explicit: boolean,
): boolean {
    const current = steps[uptoIndex];
    const candidate = steps[candidateIndex];
    if (current === undefined || candidate === undefined) return false;
    if (!explicit && candidate.exposeOutput === false) return false;

    const currentBranch = current.branch;
    if (currentBranch === undefined) return candidate.branch === undefined;
    return (
        candidateIndex < currentBranch.fanoutIndex ||
        isSameWorkflowBranch(candidate, currentBranch)
    );
}

/** Include a join output only when the current step is outside all branches. */
function shouldIncludeJoinUpstream(
    steps: WorkflowStep[],
    uptoIndex: number,
): boolean {
    return steps[uptoIndex]?.branch === undefined;
}

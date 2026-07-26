/**
 * Workflow upstream-context construction: builds the prefix of prior completed
 * TASK-step outputs injected into a task step's dispatch prompt.
 *
 * Extracted from workflow.ts. Gate-step verdicts are skipped (control-flow, not
 * work product). Each output block is individually truncated, then capped at
 * UPSTREAM_TOTAL_CAP total bytes.
 */

import type { WorkflowStep } from "../../core/types.js";
import { truncateOutput } from "../protocol/output.js";
import { assertNeverWorkflowStepKind, isSameWorkflowBranch } from "./dag.js";

/** Total byte budget for injected upstream context. */
const UPSTREAM_TOTAL_CAP = 65_536;

/**
 * Build the upstream-context prefix for a workflow task step: ALL completed
 * prior TASK-step outputs (gate steps are skipped -- their verdicts are
 * control-flow, not work product), each labelled by member and individually
 * truncated, then capped at UPSTREAM_TOTAL_CAP total bytes. Returns "" when
 * there is no completed task-step upstream.
 */
export function buildWorkflowUpstream(
    steps: WorkflowStep[],
    uptoIndex: number,
): string {
    const blocks: string[] = [];
    let used = 0;
    const explicitInputs = steps[uptoIndex]?.inputs;
    const inputIndices =
        explicitInputs ??
        Array.from({ length: uptoIndex }, (_, index) => index);
    for (const i of inputIndices) {
        const s = steps[i];
        if (!s?.completed) continue;
        const block = workflowUpstreamBlock(
            steps,
            uptoIndex,
            i,
            explicitInputs !== undefined,
        );
        if (block === null) continue;
        const blockSize = Buffer.byteLength(block, "utf8");
        if (used + blockSize > UPSTREAM_TOTAL_CAP) {
            blocks.push(
                `[…upstream context truncated at ${UPSTREAM_TOTAL_CAP} bytes]`,
            );
            break;
        }
        blocks.push(block);
        used += blockSize;
    }
    return blocks.join("\n\n");
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
            return `[Output from ${candidate.member}]\n${truncateOutput(candidate.output)}`;
        }
        case "join": {
            const joinedOutput = candidate.join?.joinedOutput;
            // An explicit `inputs` reference to a join step is legitimate even
            // from within a branch (the author chose to depend on the join
            // result). Without this, shouldIncludeJoinUpstream would silently
            // drop the dependency.
            if (!joinedOutput || (!explicit && !shouldIncludeJoinUpstream(steps, uptoIndex)))
                return null;
            return `[Joined output from workflow step ${candidateIndex + 1}]\n${truncateOutput(joinedOutput)}`;
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

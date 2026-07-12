/**
 * Workflow upstream-context construction: builds the prefix of prior completed
 * TASK-step outputs injected into a task step's dispatch prompt.
 *
 * Extracted from workflow.ts. Gate-step verdicts are skipped (control-flow, not
 * work product). Each output block is individually truncated, then capped at
 * UPSTREAM_TOTAL_CAP total bytes.
 */

import type { WorkflowStep } from "../core/types.js";
import { truncateOutput } from "./output.js";
import { isSameWorkflowBranch } from "./workflow/dag.js";

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
        if (used + block.length > UPSTREAM_TOTAL_CAP) {
            blocks.push(
                `[…upstream context truncated at ${UPSTREAM_TOTAL_CAP} bytes]`,
            );
            break;
        }
        blocks.push(block);
        used += block.length;
    }
    return blocks.join("\n\n");
}

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
            if (!joinedOutput || !shouldIncludeJoinUpstream(steps, uptoIndex))
                return null;
            return `[Joined output from workflow step ${candidateIndex + 1}]\n${truncateOutput(joinedOutput)}`;
        }
        case "gate":
        case "fanout":
            return null;
        default:
            throw new Error(`unhandled workflow step kind: ${String(candidate.kind)}`);
    }
}

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

function shouldIncludeJoinUpstream(
    steps: WorkflowStep[],
    uptoIndex: number,
): boolean {
    return steps[uptoIndex]?.branch === undefined;
}

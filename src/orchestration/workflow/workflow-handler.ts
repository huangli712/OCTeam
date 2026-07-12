/**
 * Workflow idle handler. handleWorkflowIdle captures the idle member's current
 * turn, validates that the member belongs to the active frontier, and advances
 * only that matching step. Gate-verdict routing, INVALID / parse_failure
 * handling, and ensemble aggregation live in workflow-gate.ts.
 */

import type { PluginContext } from "../../core/context.js";
import { type Team, saveTeamState } from "../../state/store.js";
import type { MemberState, WorkflowStep } from "../../core/types.js";
import {
    advanceWorkflowStep,
    describeStep,
    dispatchTaskStep,
    maybePauseAfterWorkflowStep,
} from "./workflow.js";
import { workflowInvalidReason } from "../reasons.js";
import { finishRun } from "../summary.js";
import { recordEvent } from "../events.js";
import { truncateOutput } from "../output.js";
import {
    findActiveWorkflowStepIndexForMember,
    readyWorkflowStepIndices,
} from "./dag.js";
import { parseSelection } from "../decisions.js";
import { maybeRequestApproval } from "../hitl.js";
import {
    branchIdsForJoin,
    buildBranchWorkflowOutput,
    handleWorkflowDispatchUnavailable,
} from "./fanout.js";
import { handleGateVerdict, resetStepAfterCompletion } from "./workflow-gate.js";

/** Check whether a task step's output matches its retry_on condition. */
export function shouldRetryTask(step: WorkflowStep, output: string): boolean {
    if (step.retryOn === undefined) return false;
    switch (step.retryOn.kind) {
        case "empty":
            return output.trim().length === 0;
        case "output_contains":
            return output.includes(step.retryOn.pattern);
        case "output_not_contains":
            return !output.includes(step.retryOn.pattern);
        case "regex":
            try {
                return new RegExp(step.retryOn.pattern).test(output);
            } catch {
                return false;
            }
        default:
            return false;
    }
}

export async function handleWorkflowIdle(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
): Promise<void> {
    const task = team.activeTask;
    if (!task || task.type !== "workflow") return;
    const steps = task.steps ?? [];
    const activeStepIndex = findActiveWorkflowStepIndexForMember(
        task,
        member.name,
    );
    if (activeStepIndex === null) return;
    const step = steps[activeStepIndex];
    if (!step) return;

    if (step.kind === "task") {
        const raw = step.output ?? task.responses[member.name] ?? "";
        // Per-step output cap on the captured snapshot only — the full output
        // is still persisted to runs/<runId>/<member>.md by captureMemberOutput.
        if (step.output === undefined) {
            step.output =
                step.maxOutputBytes !== undefined
                    ? truncateOutput(raw, step.maxOutputBytes)
                    : raw;
        }
        if (shouldRetryTask(step, step.output)) {
            step.taskAttempts = (step.taskAttempts ?? 0) + 1;
            const maxR = step.maxTaskRetries ?? 0;
            if (step.taskAttempts <= maxR) {
                const nudge = `[Auto-retry attempt ${step.taskAttempts}/${maxR}] Previous output triggered retry_on condition. Please try again.`;
                step.output = undefined;
                step.dispatchedAt = undefined;
                step.dispatchedActor = undefined;
                step.correlationId = undefined;
                recordEvent(team, {
                    timestamp: Date.now(),
                    kind: "retry",
                    member: member.name,
                    stage: activeStepIndex,
                    stepIndex: activeStepIndex,
                    detail: `workflow task step ${activeStepIndex + 1} auto-retry ${step.taskAttempts}/${maxR}; retry_on condition matched`,
                });
                if (!(await dispatchTaskStep(ctx, team, task, activeStepIndex, nudge))) {
                    await handleWorkflowDispatchUnavailable(ctx, team, task, step);
                    return;
                }
                await saveTeamState(team);
                return;
            }
            // exhausted: fall through to normal completion
        }
        // Capture correlationId before the reset clears it; the captured event
        // below still needs to reference the original dispatch correlation.
        const capturedCorrelationId = step.correlationId;
        resetStepAfterCompletion(step, { completed: true });
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "captured",
            member: member.name,
            stepIndex: activeStepIndex,
            correlationId: capturedCorrelationId,
            bytes: step.output?.length,
            detail: `workflow step ${activeStepIndex + 1} captured`,
        });
        if (await maybePauseAfterWorkflowStep(ctx, team, activeStepIndex))
            return;
        const nextIndex =
            task.activeStepIndices === undefined
                ? steps.findIndex((s) => !s.completed)
                : (readyWorkflowStepIndices(task)[0] ?? -1);
        if (
            step.branch === undefined &&
            nextIndex !== -1 &&
            (await maybeRequestApproval(ctx, team, {
                kind: "workflow_step",
                stage: activeStepIndex,
                summary: `Completed ${describeStep(step, activeStepIndex)}. Next: ${describeStep(steps[nextIndex], nextIndex)}. Review before continuing.`,
            }))
        ) {
            return;
        }
        await advanceWorkflowStep(ctx, team);
        return;
    }

    if (step.kind === "join") {
        const join = step.join;
        if (join === undefined) return;
        const reducerMember = join.reducerMember;
        const joinPolicy = join.joinPolicy;
        const joinActor = step.dispatchedActor ?? reducerMember;
        if ((joinPolicy !== "reduce" && joinPolicy !== "select") || joinActor !== member.name)
            return;
        const correlationId = step.correlationId;
        const response = task.responses[member.name] ?? "";
        if (joinPolicy === "select") {
            const selection = parseSelection(response);
            const branchIds = branchIdsForJoin(steps, join);
            if (selection.parseFailed || !branchIds.includes(selection.winner)) {
                await finishRun(ctx, team, workflowInvalidReason("parse_failure", member.name), "failed");
                return;
            }
            const joinedOutput = buildBranchWorkflowOutput(steps, activeStepIndex, selection.winner);
            if (joinedOutput === "") {
                await finishRun(ctx, team, workflowInvalidReason("parse_failure", member.name), "failed");
                return;
            }
            step.join = {
                ...join,
                selectedBranchId: selection.winner,
                selectionRationale: selection.rationale,
                joinedOutput,
            };
        } else {
            step.join = {
                ...join,
                joinedOutput: response,
            };
        }
        // join intentionally leaves step.completed false; advanceWorkflowStep
        // finalizes the join state on the next cycle.
        resetStepAfterCompletion(step);
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "captured",
            member: member.name,
            stepIndex: activeStepIndex,
            correlationId,
            bytes: step.join?.joinedOutput?.length,
            detail: `workflow ${joinPolicy} join step ${activeStepIndex + 1} captured`,
        });
        await advanceWorkflowStep(ctx, team);
        return;
    }

    // gate step
    if (step.kind === "gate") {
        await handleGateVerdict(ctx, team, member, step, activeStepIndex);
    }
}

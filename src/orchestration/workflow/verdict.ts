/**
 * Workflow gate-verdict routing and unevaluable-verdict handling.
 * handleGateVerdict routes PASS / FAIL / INVALID /
 * parse_failure verdicts; handleInvalidVerdict implements the on_invalid /
 * on_malformed policies (fail / retry_verifier / skip / escalate). Ensemble
 * gate aggregation lives in collectEnsembleVerdicts. resetStepAfterCompletion
 * is shared with handler.ts for task / join step completion.
 */

import type { PluginContext } from "../../core/context.js";
import type {
    MemberState,
    WorkflowStep,
    WorkflowGateStep,
    WorkflowTask,
} from "../../core/types.js";
import { finishRun } from "../control/completion.js";
import {
    forceApprovalRequest,
    maybeRequestApproval
} from "../control/approval.js";
import { type Team, saveTeamState } from "../../state/store.js";
import { recordEvent } from "../records/events.js";
import { parseVerdict } from "../protocol/decisions.js";
import {
    advanceWorkflowStep,
    describeStep,
    dispatchGateStep,
    dispatchTaskStep,
    gotoWorkflowStep,
    maybePauseAfterWorkflowStep,
    maybePauseBeforeWorkflowStep,
    moveActiveWorkflowStep,
    resetWorkflowStepTiming,
} from "./engine.js";
import {
    aggregateEnsembleVerdict,
    gatedGotoIndex,
    gateTargetIndex,
    gateTargetIndices,
    stepIndicesLabel,
    whereReason,
} from "./gate.js";
import {
    workflowGateFailReason,
    workflowInvalidReason,
} from "./reasons.js";
import {
    handleWorkflowDispatchUnavailable,
    markWorkflowStepCompleted,
} from "./fanout.js";

/** Alias for the return type of parseVerdict (verdict + metadata or parse failure). */
type ParsedVerdict = ReturnType<typeof parseVerdict>;

/** Gate-scoped parameters shared by handleInvalidVerdict and handleGateFail. */
type GateVerdictContext = {
    step: WorkflowGateStep;
    gateIndex: number;
    verifierName: string;
};

/** Verdict payload for an INVALID / parse_failure verdict. */
type InvalidVerdictPayload = GateVerdictContext & {
    reason: "INVALID" | "parse_failure";
    rationale: string;
    diff: string;
};

/** Verdict payload for a FAIL verdict. */
type FailVerdictPayload = GateVerdictContext & {
    v: ParsedVerdict;
};

/**
 * Stamp completion timing on the step via markWorkflowStepCompleted and clear
 * the transient dispatch/correlation bookkeeping that should not survive past
 * a step settling. This keeps the reset sequence consistent across task, join,
 * gate-PASS, loop-exhaust, on_fail=skip, and on_malformed=skip completion paths.
 *
 * opts.completed flips step.completed (join leaves it false because
 * advanceWorkflowStep finalizes join state on the next cycle).
 * opts.skipped additionally marks the step as skipped (on_fail=skip and
 * on_malformed=skip).
 */
export function resetStepAfterCompletion(
    step: WorkflowStep,
    opts: { completed?: boolean; skipped?: boolean } = {},
): void {
    markWorkflowStepCompleted(step);
    if (opts.completed) step.completed = true;
    if (opts.skipped) step.skipped = true;
    step.dispatchedAt = undefined;
    step.dispatchedActor = undefined;
    step.correlationId = undefined;
}

/**
 * For ensemble gates, collect the verifier's result into step.ensembleResults.
 * Returns the aggregated verdict once all verifiers have reported, or null if
 * more verifiers are still pending (caller should return early). For
 * single-verifier gates, records the verdict event and returns v unchanged.
 */
function collectEnsembleVerdicts(
    team: Team,
    task: WorkflowTask,
    step: WorkflowGateStep,
    gateIndex: number,
    verifierName: string,
    v: ParsedVerdict,
): ParsedVerdict | null {
    // Single-verifier gate: record event, return verdict as-is.
    if (step.verifiers === undefined) {
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "verdict",
            member: verifierName,
            stage: gateIndex,
            stepIndex: gateIndex,
            correlationId: step.correlationId,
            detail: v.verdict ?? "parse_fail",
        });
        return v;
    }
    // Ensemble gate: collect per-verifier results before aggregation.
    if (!step.verifiers.includes(verifierName)) return null;
    if (step.ensembleResults === undefined) step.ensembleResults = {};
    step.ensembleResults[verifierName] = {
        verdict: v.verdict ?? "INVALID",
        score: v.score,
        confidence: v.confidence,
        issues: v.issues,
        rationale: v.rationale,
        diff: v.diff,
        parseFailed: v.parseFailed,
    };
    delete task.responses[verifierName];
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "verdict",
        member: verifierName,
        stage: gateIndex,
        stepIndex: gateIndex,
        correlationId: step.correlationId,
        detail: v.verdict ?? "parse_fail",
    });
    // Wait for more verifiers.
    const total = step.verifiers.length;
    const completed = Object.keys(step.ensembleResults).length;
    if (completed < total) return null;
    // All verifiers done: aggregate.
    const aggregated = aggregateEnsembleVerdict(step);
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "verdict",
        member: "ensemble",
        stage: gateIndex,
        stepIndex: gateIndex,
        detail: `${aggregated.verdict} (${aggregated.rationale})`,
    });
    return {
        verdict: aggregated.verdict,
        rationale: aggregated.rationale,
        diff: aggregated.diff,
        parseFailed: aggregated.parseFailed,
        score: aggregated.score,
        confidence: aggregated.confidence,
        issues: aggregated.issues,
    };
}

/**
 * Handle an unevaluable gate verdict (INVALID or parse failure) according to
 * the gate's on_invalid / on_malformed policy. Producer-neutral by default:
 * the policies do not re-dispatch the target task on INVALID or parse_failure
 * (only the verifier may be re-dispatched). Exception: an on_invalid_goto
 * jumps to the referenced step and dispatches it (task or gate, forward or
 * backward, subject to a pre-step approval pause) like any goto.
 *
 *   parse_failure -> routes through on_malformed (with fallback to on_invalid):
 *     fail          -> terminate as workflow_invalid:<reason>:<verifier>, or
 *                      follow on_invalid_goto when configured
 *     retry_verifier-> re-dispatch THIS gate's verifier (bounded by
 *                      max_malformed_retries, default 0 when unset)
 *     skip          -> mark the gate skipped and advance (on_malformed only)
 *     escalate      -> force a human-approval pause
 *   INVALID       -> routes through on_invalid:
 *     fail          -> terminate as workflow_invalid:<reason>:<verifier>, or
 *                      follow on_invalid_goto when configured
 *     retry_verifier-> re-dispatch THIS gate's verifier (bounded by
 *                      max_invalid_retries), then on exhaust terminate or
 *                      follow on_invalid_goto.
 *     escalate      -> force a human-approval pause; approve marks the gate
 *                      complete and advances, reject terminates.
 */
export async function handleInvalidVerdict(
    ctx: PluginContext,
    team: Team,
    gate: InvalidVerdictPayload,
): Promise<void> {
    const task = team.activeTask;
    if (!task || task.type !== "workflow") return;
    const { step, gateIndex, verifierName, reason, rationale, diff } = gate;
    const isMalformed = reason === "parse_failure";
    // When on_malformed is set, parse_failure uses its own policy and counters.
    // When on_malformed is unset, parse_failure falls back to on_invalid (same
    // policy and counters as INVALID).
    const useMalformedPolicy = isMalformed && step.onMalformed !== undefined;
    const policy = isMalformed
        ? (step.onMalformed ?? step.onInvalid ?? "fail")
        : (step.onInvalid ?? "fail");

    // "skip" is only available via on_malformed (not on_invalid).
    if (policy === "skip") {
        delete task.responses[verifierName];
        resetStepAfterCompletion(step, { completed: true, skipped: true });
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "stage_advanced",
            member: verifierName,
            stage: gateIndex,
            stepIndex: gateIndex,
            detail: `workflow gate step ${gateIndex + 1} skipped after`
                + ` malformed verdict from ${verifierName}: ${rationale}`,
        });
        if (await maybePauseAfterWorkflowStep(ctx, team, gateIndex))
            return;
        // Honor task-level human approval before advancing, as in
        // handleGatePass. Without this, a malformed+skip would advance to the
        // next step without the human review pause that human_approval promises.
        const wfSteps = task.steps ?? [];
        const malformedNextIndex = wfSteps.findIndex((s) => !s.completed);
        if (
            step.branch === undefined
            && malformedNextIndex !== -1
            && (await maybeRequestApproval(ctx, team, {
                kind: "workflow_step",
                stage: gateIndex,
                summary: `Gate step ${gateIndex + 1} skipped after malformed verdict`
                    + ` from ${verifierName}. Next: `
                    + `${describeStep(wfSteps[malformedNextIndex], malformedNextIndex)}.`
                    + ` Review before continuing.`,
            }))
        ) {
            return;
        }
        await advanceWorkflowStep(ctx, team);
        return;
    }

    if (policy === "retry_verifier") {
        if (useMalformedPolicy) {
            step.malformedAttempts = (step.malformedAttempts ?? 0) + 1;
        } else {
            step.invalidAttempts = (step.invalidAttempts ?? 0) + 1;
        }
        // For ensemble gates, clear results so all verifiers are re-dispatched
        if (step.verifiers !== undefined) {
            step.ensembleResults = undefined;
        }
        const attempts = useMalformedPolicy
            ? (step.malformedAttempts ?? 0)
            : (step.invalidAttempts ?? 0);
        const maxIR = useMalformedPolicy
            ? (step.maxMalformedRetries ?? 0)
            : (step.maxInvalidRetries ?? 0);
        if (attempts > maxIR) {
            const invGoto = step.onInvalidGoto ?? -1;
            if (invGoto >= 0) {
                await gotoWorkflowStep(ctx, team, gateIndex, invGoto, {
                    reason: isMalformed ? "on_malformed_retry_exhausted" : "on_invalid_retry_exhausted",
                    verdict: reason === "INVALID" ? "INVALID" : undefined,
                    rationale,
                    diff,
                });
                return;
            }
            await finishRun(
                ctx,
                team,
                workflowInvalidReason(reason, verifierName),
                "failed",
            );
            return;
        }
        // Honor gate approval_before on invalid-verifier retry re-dispatch
        // (parity with FAIL retry and the initial advance path). Reset timing first
        // so a pause-then-resume does not preserve the prior attempt's startedAt.
        delete task.responses[verifierName];
        resetWorkflowStepTiming(step);
        if (await maybePauseBeforeWorkflowStep(ctx, team, gateIndex)) return;
        const nudge =
            `[Verification could not be evaluated — `
            + `${isMalformed ? "malformed" : "invalid"} attempt ${attempts}/${maxIR}]\n`
            + `Reason: ${reason}. Rationale: ${rationale}. Diff: ${diff}.\n`
            + `Re-evaluate the target output and emit a fresh verdict.`;
        if (!(await dispatchGateStep(ctx, team, task, gateIndex, nudge))) {
            await handleWorkflowDispatchUnavailable(ctx, team, task, step);
            return;
        }
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "retry",
            member: step.dispatchedActor ?? step.verifier,
            stage: gateIndex,
            stepIndex: gateIndex,
            detail: `workflow step ${gateIndex + 1}`
                + ` ${isMalformed ? "malformed" : "invalid"} retry ${attempts}/${maxIR};`
                + ` verifier ${step.dispatchedActor ?? verifierName}; reason ${reason}: ${rationale}`,
        });
        await saveTeamState(team);
        return;
    }

    if (policy === "escalate") {
        // Mark the gate complete before creating the approval
        // pause so both changes are persisted in a single saveTeamState call.
        resetStepAfterCompletion(step, { completed: true });
        // Compute nextIndex after marking the gate complete so the summary
        // describes the actual next step, not the current gate.
        const nextIndex = (task.steps ?? []).findIndex((s) => !s.completed);
        let escalated: boolean;
        try {
            escalated = await forceApprovalRequest(ctx, team, {
                kind: "workflow_step",
                stage: gateIndex,
                summary: `Step ${gateIndex + 1} (gate) by ${verifierName} could not be evaluated (${reason}).`
                    + ` Rationale: ${rationale}. Approve to override and continue`
                    + `${nextIndex !== -1 ? ` to ${describeStep((task.steps ?? [])[nextIndex], nextIndex)}` : ""};`
                    + ` reject to fail as workflow_invalid.`,
            });
        } catch (error) {
            step.completed = false;
            throw error;
        }
        if (escalated) {
            return;
        }
        // forceApprovalRequest failed to create the pause and already cleared
        // approvalStage. Revert the gate completion since
        // there is no approval to gate it on.
        step.completed = false;
        // No escalation handler available -> fall through to terminal fail.
    }

    // on_invalid_goto (incompatible with escalate per validator) jumps instead
    // of terminating at the INVALID terminal point. Shared by both on_invalid
    // and on_malformed terminal paths.
    if (policy !== "escalate") {
        const invGoto = step.onInvalidGoto ?? -1;
        if (invGoto >= 0) {
            await gotoWorkflowStep(ctx, team, gateIndex, invGoto, {
                reason: isMalformed ? `on_malformed:${reason}` : `on_invalid:${reason}`,
                verdict: reason === "INVALID" ? "INVALID" : undefined,
                rationale,
                diff,
            });
            return;
        }
    }
    await finishRun(
        ctx,
        team,
        workflowInvalidReason(reason, verifierName),
        "failed",
    );
}

/**
 * Handle a PASS verdict: mark complete, honor on_pass_goto or approval_after,
 * then advance (or jump) to the next step.
 */
export async function handleGatePass(
    ctx: PluginContext,
    team: Team,
    step: WorkflowGateStep,
    gateIndex: number,
    steps: WorkflowStep[],
    verifierName: string,
    v: ParsedVerdict,
): Promise<void> {
    // Clear the verifier's response so a backward jump or re-run does not read
    // a stale verdict (parity with FAIL/INVALID paths and ensemble gates).
    const task = team.activeTask;
    if (task) delete task.responses[verifierName];
    // When approval_after is configured, mark the gate completed before
    // pausing. Without this, the pause returns early and the gate remains
    // un-completed; after approval, applyApprovalDecision calls
    // advanceWorkflowStep, which re-processes the still-active gate
    // (re-dispatching the verifier in linear workflows, or waiting forever
    // on stale dispatchedAt in DAG workflows).
    //
    // approval_after is incompatible with on_*_goto, so this cannot bypass a
    // jump. Gates without approvalAfter remain incomplete until after the
    // unevaluable-where check.
    if (step.approvalAfter) {
        resetStepAfterCompletion(step, { completed: true });
    }
    // approval_after on a gate is validator-guaranteed incompatible with
    // on_*_goto, so pausing here cannot be bypassed by a goto jump.
    if (await maybePauseAfterWorkflowStep(ctx, team, gateIndex))
        return;
    const gotoIdx = gatedGotoIndex(steps, gateIndex, step.onPassGoto);
    if (gotoIdx === -2) {
        // The where condition was unevaluable because the verifier omitted a
        // required field. Route to INVALID instead of silently advancing
        // to the default successor — the verifier's contract was violated.
        //
        // The step MUST NOT be marked completed before this check: the
        // retry_verifier branch in handleInvalidVerdict re-dispatches the
        // verifier and waits for a fresh idle response, but a completed gate
        // is skipped by the idle router, so the retry response would never
        // process, deadlocking the run until wall-clock timeout.
        await handleInvalidVerdict(ctx, team, {
            step, gateIndex, verifierName,
            reason: "INVALID",
            rationale: "where condition unevaluable: required score/confidence field missing from verdict",
            diff: "",
        });
        return;
    }
    if (gotoIdx < 0) resetStepAfterCompletion(step, { completed: true });
    const nextIndex =
        gotoIdx >= 0 ? gotoIdx : steps.findIndex((s) => !s.completed);
    // Skip the task-global approval when on_pass_goto is set: the approval
    // resume path calls advanceWorkflowStep, which would ignore the goto.
    // The goto has its own jump-bound safeguard (maxJumps).
    if (
        gotoIdx < 0
        && step.branch === undefined
        && nextIndex !== -1
        && (await maybeRequestApproval(ctx, team, {
            kind: "workflow_step",
            stage: gateIndex,
            summary: `Completed ${describeStep(step, gateIndex)} with PASS`
                + ` from ${verifierName}. Rationale: ${v.rationale}.`
                + ` Next: ${describeStep(steps[nextIndex], nextIndex)}.`
                + ` Review before continuing.`,
        }))
    ) {
        return;
    }
    if (gotoIdx >= 0) {
        await gotoWorkflowStep(ctx, team, gateIndex, gotoIdx, {
            reason: whereReason(step, "on_pass"),
            verdict: "PASS",
            rationale: v.rationale,
            diff: v.diff,
        });
        return;
    }
    await advanceWorkflowStep(ctx, team);
}

/**
 * Handle a FAIL verdict with on_fail=fail (loop-bounded on_fail_goto or
 * terminate) or on_fail=skip (mark skipped and advance). The on_fail=retry
 * path is handled by handleGateRetry.
 */
export async function handleGateFail(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    steps: WorkflowStep[],
    gate: FailVerdictPayload,
): Promise<void> {
    const { step, gateIndex, verifierName, v } = gate;
    const onFail = step.onFail ?? "fail";
    if (onFail === "skip") {
        delete task.responses[verifierName];
        resetStepAfterCompletion(step, { completed: true, skipped: true });
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "stage_advanced",
            member: verifierName,
            stage: gateIndex,
            stepIndex: gateIndex,
            detail: `workflow gate step ${gateIndex + 1} skipped after FAIL from ${verifierName}`,
        });
        // Honor approval_after before advancing (parity with handleGatePass).
        if (await maybePauseAfterWorkflowStep(ctx, team, gateIndex))
            return;
        // Honor task-level human approval before advancing, as in
        // handleGatePass. Without this, a FAIL+skip would advance without
        // the human review pause that human_approval promises.
        const failSkipNextIndex = steps.findIndex((s) => !s.completed);
        if (
            step.branch === undefined
            && failSkipNextIndex !== -1
            && (await maybeRequestApproval(ctx, team, {
                kind: "workflow_step",
                stage: gateIndex,
                summary: `Gate step ${gateIndex + 1} skipped after FAIL verdict`
                    + ` from ${verifierName}. Next: `
                    + `${describeStep(steps[failSkipNextIndex], failSkipNextIndex)}.`
                    + ` Review before continuing.`,
            }))
        ) {
            return;
        }
        await advanceWorkflowStep(ctx, team);
        return;
    }
    // onFail === "fail"
    const failGoto = gatedGotoIndex(
        steps,
        gateIndex,
        step.onFailGoto,
    );
    if (failGoto === -2) {
        // Route an unevaluable where condition to INVALID.
        await handleInvalidVerdict(ctx, team, {
            step, gateIndex, verifierName,
            reason: "INVALID",
            rationale: "where condition unevaluable: required score/confidence field missing from verdict",
            diff: "",
        });
        return;
    }
    if (failGoto >= 0) {
        const loop = step.loop;
        const isBackwardLoop = failGoto < gateIndex && loop !== undefined;
        if (isBackwardLoop) {
            step.loopIterations = (step.loopIterations ?? 0) + 1;
            if (step.loopIterations > loop.maxIterations) {
                if (loop.onExhaust === "continue") {
                    delete task.responses[verifierName];
                    resetStepAfterCompletion(step, { completed: true });
                    recordEvent(team, {
                        timestamp: Date.now(),
                        kind: "stage_advanced",
                        member: verifierName,
                        stage: gateIndex,
                        stepIndex: gateIndex,
                        detail: `workflow loop step ${gateIndex + 1} exhausted`
                            + ` after ${loop.maxIterations} iterations;`
                            + ` on_exhaust=continue`,
                    });
                    // Honor task-level human approval before advancing, as in
                    // the gate PASS and skip paths. Otherwise, on_exhaust=continue would
                    // immediately advance to the next step without the review
                    // pause that human_approval promises.
                    const exhaustNextIndex = steps.findIndex((s) => !s.completed);
                    if (
                        step.branch === undefined
                        && exhaustNextIndex !== -1
                        && (await maybeRequestApproval(ctx, team, {
                            kind: "workflow_step",
                            stage: gateIndex,
                            summary: `Loop gate step ${gateIndex + 1} exhausted after `
                                + `${loop.maxIterations} iterations (on_exhaust=continue). `
                                + `Next: ${describeStep(steps[exhaustNextIndex], exhaustNextIndex)}. `
                                + `Review before continuing.`,
                        }))
                    ) {
                        return;
                    }
                    await advanceWorkflowStep(ctx, team);
                    return;
                }
                await finishRun(
                    ctx,
                    team,
                    workflowGateFailReason(verifierName),
                    "failed",
                );
                return;
            }
        }
        await gotoWorkflowStep(ctx, team, gateIndex, failGoto, {
            reason: whereReason(step, "on_fail"),
            verdict: "FAIL",
            rationale: v.rationale,
            diff: v.diff,
        });
        return;
    }
    await finishRun(
        ctx,
        team,
        workflowGateFailReason(verifierName),
        "failed",
    );
}

/**
 * Handle a FAIL verdict with on_fail=retry: bounded re-dispatch of the
 * gate's target step. Resets steps from the producer to the gate, then
 * re-dispatches the producer with feedback.
 */
export async function handleGateRetry(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    step: WorkflowGateStep,
    gateIndex: number,
    steps: WorkflowStep[],
    verifierName: string,
    v: ParsedVerdict,
): Promise<void> {
    delete task.responses[verifierName];
    step.attempts = (step.attempts ?? 0) + 1;
    const maxR = step.maxRetries ?? 0;
    if (step.attempts > maxR) {
        const failGoto = gatedGotoIndex(
            steps,
            gateIndex,
            step.onFailGoto,
        );
        if (failGoto === -2) {
            // Route an unevaluable where condition to INVALID.
            await handleInvalidVerdict(ctx, team, {
                step, gateIndex, verifierName,
                reason: "INVALID",
                rationale: "where condition unevaluable: required score/confidence field missing from verdict",
                diff: "",
            });
            return;
        }
        if (failGoto >= 0) {
            await gotoWorkflowStep(ctx, team, gateIndex, failGoto, {
                reason: whereReason(step, "on_fail_retry_exhausted"),
                verdict: "FAIL",
                rationale: v.rationale,
                diff: v.diff,
            });
            return;
        }
        await finishRun(
            ctx,
            team,
            workflowGateFailReason(verifierName),
            "failed",
        );
        return;
    }
    const producerIdx = gateTargetIndex(steps, gateIndex);
    if (producerIdx === -1) {
        // No preceding task to retry -> fail (defensive; tool layer rejects gate-first).
        await finishRun(
            ctx,
            team,
            workflowGateFailReason(verifierName),
            "failed",
        );
        return;
    }
    for (let i = producerIdx; i <= gateIndex; i++) {
        const retryStep = steps[i];
        if (!retryStep) continue;
        retryStep.completed = false;
        retryStep.skipped = false;
        retryStep.approvalBeforeGranted = undefined;
        resetWorkflowStepTiming(retryStep);
        if (retryStep.kind === "task") {
            retryStep.output = undefined;
            retryStep.taskAttempts = 0;
            // Reset task timeoutAttempts, as in the gate branch
            // below and the backward-jump reset in engine.ts.
            retryStep.timeoutAttempts = 0;
        }
        if (retryStep.kind === "gate") {
            retryStep.verdict = undefined;
            retryStep.ensembleResults = undefined;
            if (i !== gateIndex) {
                retryStep.attempts = 0;
                retryStep.invalidAttempts = 0;
                retryStep.malformedAttempts = 0;
                retryStep.timeoutAttempts = 0;
            }
        }
        if (retryStep.kind === "join" && retryStep.join !== undefined) {
            // Clear stale join state so re-run does not reuse old join results.
            // Mutable runtime fields only; structural metadata (branchTailIndices,
            // joinPolicy, etc.) is readonly and stays.
            retryStep.join.joinedOutput = undefined;
            retryStep.join.survivorBranchIds = undefined;
            retryStep.join.erroredBranchIds = undefined;
            retryStep.join.selectedBranchId = undefined;
            retryStep.join.selectionRationale = undefined;
        }
    }
    const producerStep = steps[producerIdx];
    if (!producerStep || producerStep.kind !== "task") {
        await finishRun(
            ctx,
            team,
            workflowGateFailReason(verifierName),
            "failed",
        );
        return;
    }
    moveActiveWorkflowStep(task, gateIndex, producerIdx);
    // Honor producer approval_before on retry re-dispatch (parity with goto
    // backward jump and the initial advance path). Without this, a FAIL retry
    // would silently bypass the leader gate that the step declared.
    if (await maybePauseBeforeWorkflowStep(ctx, team, producerIdx)) return;
    const feedback =
        `[Gate FAILED - attempt ${step.attempts}/${maxR}]\n` +
        `Rationale: ${v.rationale}\nDiff: ${v.diff}\nFix and resubmit.`;
    step.dispatchedActor = undefined;
    if (!(await dispatchTaskStep(ctx, team, task, producerIdx, feedback))) {
        const result = await handleWorkflowDispatchUnavailable(ctx, team, task, producerStep);
        // If fanout tolerance degrades the branch, advance so the frontier
        // doesn't stall waiting for an idle that won't come from the
        // errored producer.
        if (result === "degraded") await advanceWorkflowStep(ctx, team);
        return;
    }
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "retry",
        member: producerStep.dispatchedActor ?? producerStep.member,
        stage: gateIndex,
        stepIndex: producerIdx,
        detail: `workflow step ${gateIndex + 1} attempt ${step.attempts}/${maxR};`
            + ` retry target ${stepIndicesLabel(gateTargetIndices(steps, gateIndex))};`
            + ` retry anchor step ${producerIdx + 1}; verifier ${verifierName};`
            + ` diff: ${v.diff}`,
    });
    await saveTeamState(team);
}

/**
 * Route a gate step's verdict. Handles single-verifier and ensemble gates,
 * then dispatches on PASS / FAIL / INVALID / parse_failure:
 *
 *   PASS            -> mark complete; on_pass_goto jump or advance
 *   FAIL on_fail=fail -> on_fail_goto (loop-bounded) or terminate
 *   FAIL on_fail=skip -> mark skipped and advance
 *   FAIL on_fail=retry -> bounded re-dispatch of the gate's target task
 *                      (explicit or nearest preceding; see gateTargetIndex)
 *   INVALID / parse_failure -> delegated to handleInvalidVerdict
 *
 * The gate's activeStepIndex is passed in as gateIndex since FAIL retry
 * re-dispatches the preceding task and needs a stable name for the gate slot.
 */
export async function handleGateVerdict(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
    step: WorkflowGateStep,
    gateIndex: number,
): Promise<void> {
    const task = team.activeTask;
    if (!task || task.type !== "workflow") return;
    const steps = task.steps ?? [];
    if (step.verifier === undefined && step.verifiers === undefined) return;
    const verifierName = member.name;
    let output: string;
    if (step.verifiers !== undefined) {
        const response = task.responses[verifierName];
        if (response === undefined) return;
        output = response;
    } else {
        const response = task.responses[verifierName];
        if (response !== undefined) {
            // Parse the full response before storing a truncated snapshot;
            // truncating first could remove the closing </verdict> tag.
            output = response;
            if (Buffer.byteLength(response, "utf8") > 8192) {
                const responseBuffer = Buffer.from(response, "utf8");
                step.output = responseBuffer
                    .subarray(0, Math.min(responseBuffer.length, 8192))
                    .toString("utf8") + "\n[...truncated]";
            } else {
                step.output = response;
            }
        } else {
            output = step.output ?? "";
        }
    }
    const parsed = parseVerdict(output);

    const collected = collectEnsembleVerdicts(team, task, step, gateIndex, verifierName, parsed);
    if (collected === null) return;
    const v = collected;

    step.verdict = v.verdict;
    step.score = v.score;
    step.confidence = v.confidence;
    step.issues = v.issues;

    if (v.parseFailed || !v.verdict) {
        await handleInvalidVerdict(
            ctx,
            team,
            {
                step,
                gateIndex,
                verifierName,
                reason: "parse_failure",
                rationale: v.rationale,
                diff: v.diff,
            },
        );
        return;
    }

    switch (v.verdict) {
        case "INVALID":
            await handleInvalidVerdict(
                ctx,
                team,
                {
                    step,
                    gateIndex,
                    verifierName,
                    reason: "INVALID",
                    rationale: v.rationale,
                    diff: v.diff,
                },
            );
            return;
        case "PASS":
            await handleGatePass(ctx, team, step, gateIndex, steps, verifierName, v);
            return;
        case "FAIL":
            if ((step.onFail ?? "fail") === "retry") {
                await handleGateRetry(ctx, team, task, step, gateIndex, steps, verifierName, v);
            } else {
                await handleGateFail(ctx, team, task, steps, { step, gateIndex, verifierName, v });
            }
            return;
        default: {
            const exhaustive: never = v.verdict;
            throw new Error(`Unknown workflow verdict: ${String(exhaustive)}`);
        }
    }
}

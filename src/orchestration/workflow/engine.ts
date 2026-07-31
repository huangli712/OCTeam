/**
 * Workflow step engine -- deterministic linear step dispatch, advance, goto,
 * and redispatch primitives. handleWorkflowIdle (handler.ts) drives the
 * top-level idle routing; gate-verdict routing lives in verdict.ts.
 *
 * STATE MACHINE (MVP: linear + gate-driven retry):
 *   steps[i]_dispatch -> steps[i]_idle -> steps[i+1]_dispatch -> ... -> all_complete
 *   - task step: dispatch the actor with upstream (prior completed TASK-step
 *     outputs) prefixed; on its idle, mark completed and advance.
 *   - gate step: dispatch the verifier with the preceding task's output +
 *     criteria; on its idle, parse <verdict>:
 *       PASS   -> mark the gate complete; advance.
 *       FAIL   -> if onFail="retry" and attempts <= maxRetries, reset and
 *                 re-dispatch the preceding task's actor with a diff diagnostic;
 *                 else fail the run (workflow_failed).
 *       INVALID / parse-failure -> fail the run as workflow_invalid. This is
 *                 producer-neutral: the target task is not retried.
 *   - All steps complete -> maybeTriggerSignoff -> deliver (idle: workflow_complete)
 *
 * Reuses dispatchToMember (canonical member dispatch), parseVerdict (tollgate's
 * three-valued verdict parser), maybeTriggerSignoff, and finishRun. Does NOT
 * reuse buildUpstreamContext because gate-step actors differ from task-step
 * actors and gate verdicts are control-flow, not work product; a dedicated
 * buildWorkflowUpstream includes only completed task-step outputs.
 */

import type { PluginContext } from "../../core/context.js";
import { type Team, saveTeamState } from "../../state/store.js";
import type {
    WorkflowGateStep,
    WorkflowStep,
    WorkflowTask,
} from "../../core/types.js";
import {
    buildGateProducerOutput,
    buildGateVerifierPrompt,
    buildJumpContext,
    gateTargetIndices,
    stepIndicesLabel,
    workflowTargetLabel,
    type WorkflowJumpTransition,
} from "./gate.js";
import {
    workflowCompleteReason,
    workflowJumpLimitReason,
} from "./reasons.js";
import { dispatchToMember } from "../control/dispatch.js";
import { finishRun } from "../control/completion.js";
import { recordEvent } from "../records/events.js";
import {
    assertNeverWorkflowStepKind,
    getActiveWorkflowStepIndices,
    readyWorkflowStepIndices,
    recordUnavailableEnsembleVerifier,
    sortedWorkflowIndices,
} from "./dag.js";
import { maybeTriggerSignoff } from "../control/signoff.js";
import { forceApprovalRequest, maybeRequestApproval } from "../control/approval.js";
import {
    completeWorkflowJoinStep,
    dispatchWorkflowJoinReducer,
    handleWorkflowDispatchUnavailable,
    liveWorkflowActor,
    markWorkflowStepCompleted,
    markWorkflowStepDispatched,
} from "./fanout.js";
import { findMember } from "../../tools/support.js";

import { buildWorkflowUpstream } from "./upstream.js";

/** Default per-gate jump cap when max_jumps is not explicitly set. */
const DEFAULT_MAX_JUMPS = 3;

/** Provide a human-readable label for a workflow step, e.g. "step 3 (task) by alice". */
export function describeStep(step: WorkflowStep | undefined, index: number): string {
    if (!step) return `step ${index + 1}`;
    const idTag = step.id ? ` (${step.id})` : "";
    switch (step.kind) {
        case "task":
            return `step ${index + 1}${idTag} (task) by ${step.member ?? "?"}`;
        case "gate": {
            const target =
                step.targetStepIndices !== undefined &&
                step.targetStepIndices.length > 0
                    ? stepIndicesLabel(step.targetStepIndices)
                    : step.targetStepIndex === undefined
                      ? "nearest task"
                      : `step ${step.targetStepIndex + 1}`;
            return `step ${index + 1}${idTag} (gate) by ${step.verifier ?? "?"}, verifying ${target}`;
        }
        case "fanout":
            return `step ${index + 1}${idTag} (fanout)`;
        case "join":
            return `step ${index + 1}${idTag} (join)`;
        default:
            return assertNeverWorkflowStepKind(step);
    }
}

/** Dispatch a task step's actor with upstream context prefixed. */
export async function dispatchTaskStep(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    index: number,
    contextPrefix?: string,
): Promise<boolean> {
    const step = task.steps?.[index];
    if (!step || step.kind !== "task" || !step.member || !step.task)
        return false;
    const member = liveWorkflowActor(team, step.member, step.fallbackMember);
    if (member === undefined) return false;
    // H-2: when the task declares explicit `inputs`, verify every referenced
    // step completed NON-SKIPPED. A forward goto can mark intermediate steps
    // as completed+skipped; without this guard the task would dispatch with
    // an empty upstream (buildWorkflowUpstream silently drops !completed and
    // skipped-only entries) and produce work product missing its declared
    // dependencies. Surface the violation as a deterministic run failure.
    if (step.inputs !== undefined) {
        const missing: string[] = []
        for (const inputIdx of step.inputs) {
            const inputStep = task.steps?.[inputIdx]
            if (!inputStep || !inputStep.completed || inputStep.skipped) {
                missing.push(String(inputIdx + 1))
            }
        }
        if (missing.length > 0) {
            const reason = `workflow_input_skipped: step ${index + 1} declares inputs [${missing.join(", ")}] but at least one was skipped (likely by a forward goto). Refusing to dispatch a task without its declared dependencies.`
            await finishRun(ctx, team, reason, "failed")
            return false
        }
    }
    // Consume the per-step approval_before grant now that dispatch is actually
    // happening (re-entry via retry/goto re-requests approval because the reset
    // loops clear approvalBeforeGranted).
    step.approvalBeforeGranted = undefined;
    step.output = undefined;
    delete task.responses[member.name];
    const upstream = buildWorkflowUpstream(task.steps ?? [], index);
    const text = upstream
        ? `${upstream}\n\n[Your task]\n${step.task}`
        : step.task;
    step.dispatchedActor = member.name;
    step.correlationId = crypto.randomUUID();
    // HIGH #14: mark dispatched BEFORE dispatchToMember so the step state
    // is persisted atomically with the dispatch intent.
    markWorkflowStepDispatched(step);
    await dispatchToMember(
        ctx,
        member,
        contextPrefix ? `${contextPrefix}\n\n${text}` : text,
        member.worktreePath ?? ctx.directory,
        team,
        { stepIndex: index, correlationId: step.correlationId },
    );
    return true;
}

/** Dispatch an ensemble gate's verifiers in parallel. */
export async function dispatchEnsembleGate(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    index: number,
    contextPrefix?: string,
): Promise<boolean> {
    const step = task.steps?.[index];
    if (!step || step.kind !== "gate" || !step.verifiers) return false;
    const targetIndices = gateTargetIndices(task.steps ?? [], index);
    if (targetIndices.length === 0) return false;
    // HIGH-C: refuse to verify a target that is incomplete or skipped. Same
    // contract as the single-verifier path — without this, an ensemble gate
    // reached by a forward goto would receive empty producer output and emit
    // a spurious PASS.
    const skippedTargets: string[] = []
    for (const targetIdx of targetIndices) {
        const target = task.steps?.[targetIdx]
        if (!target || !target.completed || target.skipped === true) {
            skippedTargets.push(String(targetIdx + 1))
        }
    }
    if (skippedTargets.length > 0) {
        await finishRun(
            ctx,
            team,
            `workflow_input_skipped: ensemble gate step ${index + 1} verifies target(s) [${skippedTargets.join(", ")}] but at least one was skipped (likely by a forward goto). Refusing to verify with missing producer output.`,
            "failed",
        )
        return false
    }
    step.approvalBeforeGranted = undefined;
    step.output = undefined;
    const producerOutput = buildGateProducerOutput(task.steps ?? [], targetIndices);
    const prompt = buildGateVerifierPrompt(
        step,
        producerOutput,
        workflowTargetLabel(targetIndices),
        targetIndices.length,
    );
    let dispatchedAny = false;
    const unavailable: string[] = [];
    // HIGH: if ALL verifiers already have results, the ensemble is already
    // complete — return true so the engine doesn't try to re-dispatch or
    // fail the run. This happens when a verifier crashed after all others
    // completed, or on resume after a partial crash.
    const allResolved = step.verifiers.every(v => step.ensembleResults?.[v] !== undefined);
    if (allResolved) {
        // NEW: settle the ensemble verdict immediately.
        await settleEnsembleGate(ctx, team, task, step);
        return true;
    }
    // HIGH: mark dispatched BEFORE the first dispatch so crash between
    // dispatch and mark doesn't leave the step unmarked on disk.
    markWorkflowStepDispatched(step);
    for (const verifierName of step.verifiers) {
        // skip verifiers that already have results (e.g., on partial retry)
        if (step.ensembleResults?.[verifierName] !== undefined) continue;
        const verifier = findMember(team, verifierName);
        if (!(verifier?.sessionId !== undefined && verifier.status !== "errored")) {
            // Verifier is dead/unavailable — track it so we can record a
            // placeholder INVALID result. Without this, collectEnsembleVerdicts
            // would wait forever for a result that can never arrive.
            unavailable.push(verifierName);
            continue;
        }
        delete task.responses[verifier.name];
        step.dispatchedActor = verifier.name;
        if (step.correlationId === undefined) {
            step.correlationId = crypto.randomUUID();
        }
        await dispatchToMember(
            ctx,
            verifier,
            contextPrefix ? `${contextPrefix}\n\n${prompt}` : prompt,
            verifier.worktreePath ?? ctx.directory,
            team,
            { stepIndex: index, correlationId: step.correlationId },
        );
        dispatchedAny = true;
    }
    // When at least one verifier dispatched, populate INVALID for any
    // unavailable verifiers so the ensemble can reach its completion
    // threshold instead of hanging permanently.
    if (dispatchedAny && unavailable.length > 0) {
        for (const name of unavailable) {
            recordUnavailableEnsembleVerifier(step, name);
        }
    }
    return dispatchedAny;
}

/** Dispatch a gate step's verifier with the preceding task's output + criteria. */
export async function dispatchGateStep(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    index: number,
    contextPrefix?: string,
): Promise<boolean> {
    const step = task.steps?.[index];
    if (!step || step.kind !== "gate") return false;
    // ensemble gate: dispatch all verifiers
    if (step.verifiers !== undefined && step.verifiers.length > 0) {
        return await dispatchEnsembleGate(ctx, team, task, index, contextPrefix);
    }
    if (!step.verifier) return false;
    const verifier = liveWorkflowActor(
        team,
        step.verifier,
        step.fallbackVerifier,
    );
    if (verifier === undefined) return false;
    const targetIndices = gateTargetIndices(task.steps ?? [], index);
    if (targetIndices.length === 0) return false;
    // HIGH-C: refuse to verify a target that is incomplete or skipped. A
    // forward goto can jump past a producer task and land on a gate that
    // verifies it; without this guard the verifier is dispatched with an
    // empty producer output (buildGateProducerOutput drops !completed /
    // skipped entries), and may emit a spurious PASS. Mirror the input-guard
    // contract from dispatchTaskStep (H-2): finishRun with
    // workflow_input_skipped so the run fails deterministically rather than
    // passing a gate on missing inputs.
    const skippedTargets: string[] = []
    for (const targetIdx of targetIndices) {
        const target = task.steps?.[targetIdx]
        if (!target || !target.completed || target.skipped === true) {
            skippedTargets.push(String(targetIdx + 1))
        }
    }
    if (skippedTargets.length > 0) {
        await finishRun(
            ctx,
            team,
            `workflow_input_skipped: gate step ${index + 1} verifies target(s) [${skippedTargets.join(", ")}] but at least one was skipped (likely by a forward goto). Refusing to verify with missing producer output.`,
            "failed",
        )
        return false
    }
    step.approvalBeforeGranted = undefined;
    step.output = undefined;
    delete task.responses[verifier.name];
    const producerOutput = buildGateProducerOutput(
        task.steps ?? [],
        targetIndices,
    );
    const prompt = buildGateVerifierPrompt(
        step,
        producerOutput,
        workflowTargetLabel(targetIndices),
        targetIndices.length,
    );
    step.dispatchedActor = verifier.name;
    step.correlationId = crypto.randomUUID();
    // HIGH #18: mark dispatched BEFORE dispatchToMember so the step state
    // is persisted atomically with the dispatch intent.
    markWorkflowStepDispatched(step);
    await dispatchToMember(
        ctx,
        verifier,
        contextPrefix ? `${contextPrefix}\n\n${prompt}` : prompt,
        verifier.worktreePath ?? ctx.directory,
        team,
        { stepIndex: index, correlationId: step.correlationId },
    );
    return true;
}

/** Reset timing metadata on a workflow step so it can be re-dispatched (used by retry/goto). */
export function resetWorkflowStepTiming(step: WorkflowStep): void {
    step.startedAt = undefined;
    step.completedAt = undefined;
    step.durationMs = undefined;
    step.dispatchedAt = undefined;
    step.dispatchedActor = undefined;
}

/** Move the active-step cursor from one index to another (used by jumps and dynamic fanout). */
export function moveActiveWorkflowStep(
    task: WorkflowTask,
    fromIndex: number,
    toIndex: number,
): void {
    if (task.activeStepIndices === undefined) {
        task.currentStageIndex = toIndex;
        return;
    }

    const next: number[] = [];
    let replaced = false;
    for (const index of getActiveWorkflowStepIndices(task)) {
        const candidate = index === fromIndex ? toIndex : index;
        if (index === fromIndex) replaced = true;
        if (!next.includes(candidate)) next.push(candidate);
    }
    if (!replaced && !next.includes(toIndex)) next.push(toIndex);
    task.activeStepIndices = sortedWorkflowIndices(next);
    task.currentStageIndex = task.activeStepIndices[0] ?? toIndex;
}

/** Check if a step's actor has a pending (uncaptured) response in task.responses. */
function stepHasPendingResponse(task: WorkflowTask, step: WorkflowStep): boolean {
    if (step.kind === "task") return step.member !== undefined && task.responses[step.member] !== undefined;
    if (step.kind === "gate") {
        // H-1: for ensemble gates, check ALL verifiers' responses, not just
        // the last dispatched one. Pre-fix code used step.verifier ??
        // step.dispatchedActor which missed ensemble verifiers whose response
        // arrived but was not yet collected.
        if (step.verifiers !== undefined) {
            return step.verifiers.some(v => task.responses[v] !== undefined
                && step.ensembleResults?.[v] === undefined)
        }
        const actor = step.verifier ?? step.dispatchedActor;
        return actor !== undefined && task.responses[actor] !== undefined;
    }
    return false;
}

/** Check whether any previously-active step still has a dispatched but uncompleted actor. */
export function hasWaitingActiveWorkflowActor(
    steps: WorkflowStep[],
    previousActive: ReadonlySet<number>,
    ready: readonly number[],
    responses: Record<string, string>,
): boolean {
    for (const index of ready) {
        const step = steps[index];
        if (step === undefined || !previousActive.has(index)) continue;

        switch (step.kind) {
            case "task":
            case "gate": {
                // H-1: for ensemble gates, check all verifiers for pending
                // responses (not just the last dispatched actor).
                if (step.kind === "gate" && step.verifiers !== undefined) {
                    const hasPending = step.verifiers.some(v =>
                        responses[v] !== undefined && step.ensembleResults?.[v] === undefined)
                    if (!step.completed && (step.dispatchedAt !== undefined || hasPending)) return true;
                    break;
                }
                const actorName = step.kind === "task"
                    ? step.member
                    : step.verifier ?? step.dispatchedActor;
                if (!step.completed && (step.dispatchedAt !== undefined
                    || (actorName !== undefined && responses[actorName] !== undefined))) return true;
                break;
            }
            case "fanout":
            case "join":
                break;
            default:
                return assertNeverWorkflowStepKind(step);
        }
    }

    return false;
}

/** Mark fanout container steps as completed when their expanded branches are ready. */
export function completeExpandedFanoutMarkers(
    steps: WorkflowStep[],
    readyIndices: readonly number[],
): void {
    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        if (step === undefined || step.completed) continue;

        switch (step.kind) {
            case "fanout": {
                const fanout = step.fanout;
                if (
                    fanout !== undefined &&
                    readyIndices.some(
                        (readyIndex) =>
                            readyIndex === fanout.joinIndex ||
                            fanout.branchRanges.some(
                                (range) =>
                                    range.startIndex <= readyIndex &&
                                    readyIndex <= range.endIndex,
                            ),
                    )
                ) {
                    step.completed = true;
                }
                break;
            }
            case "task":
            case "gate":
            case "join":
                break;
            default:
                assertNeverWorkflowStepKind(step);
        }
    }
}

/**
 * Per-step approval_before: if the step declares it and the current instance
 * has not yet been granted, force an HITL pause (bypassing the task-global
 * humanApproval flag). Sets approvalBeforeGranted so the post-approve
 * advanceWorkflowStep dispatches instead of re-pausing. Returns true when the
 * step is paused (caller must NOT dispatch).
 */
export async function maybePauseBeforeWorkflowStep(
    ctx: PluginContext,
    team: Team,
    index: number,
): Promise<boolean> {
    const task = team.activeTask;
    if (!task || task.type !== "workflow") return false;
    const step = task.steps?.[index];
    if (!step || !step.approvalBefore || step.approvalBeforeGranted)
        return false;
    // K-2: set approvalBeforeGranted BEFORE forceApprovalRequest so the
    // grant is persisted atomically with the pause inside forceApprovalRequest's
    // own save. Pre-fix code saved the pause first, then set the grant and
    // saved again — a crash between the two saves left approval pending
    // without the grant, causing a duplicate approval request on resume.
    // If forceApprovalRequest fails to pause (no escalation handler), roll
    // back the grant flag so the caller falls through to dispatch.
    step.approvalBeforeGranted = true;
    const paused = await forceApprovalRequest(ctx, team, {
        kind: "workflow_step",
        stage: index,
        summary: `Before ${describeStep(step, index)}. Approve to dispatch this step;`
            + ` reject to fail the run as workflow_human_rejected.`,
    });
    if (paused) {
        return true;
    }
    // Not paused — roll back the grant flag so dispatch proceeds cleanly.
    // No save needed here: dispatchTaskStep will save after dispatch.
    step.approvalBeforeGranted = undefined;
    return false;
}

/**
 * Per-step approval_after: if the just-completed step declares it, force an
 * HITL pause before the workflow advances. team_approve resumes via
 * advanceWorkflowStep. Returns true when paused (caller must NOT advance).
 */
export async function maybePauseAfterWorkflowStep(
    ctx: PluginContext,
    team: Team,
    index: number,
): Promise<boolean> {
    const task = team.activeTask;
    if (!task || task.type !== "workflow") return false;
    const step = task.steps?.[index];
    if (!step || !step.approvalAfter) return false;
    const paused = await forceApprovalRequest(ctx, team, {
        kind: "workflow_step",
        stage: index,
        summary: `After ${describeStep(step, index)}. Approve to continue;`
            + ` reject to fail the run as workflow_human_rejected.`,
    });
    if (paused) {
        await saveTeamState(team);
        return true;
    }
    return false;
}

function settleForwardGotoGate(task: WorkflowTask, gate: WorkflowGateStep): void {
    markWorkflowStepCompleted(gate);
    gate.completed = true;
    if (gate.verifiers !== undefined) {
        for (const verifierName of gate.verifiers) {
            delete task.responses[verifierName];
        }
    }
    if (gate.verifier !== undefined) delete task.responses[gate.verifier];
    if (gate.dispatchedActor !== undefined) delete task.responses[gate.dispatchedActor];
    gate.dispatchedAt = undefined;
    gate.dispatchedActor = undefined;
    gate.correlationId = undefined;
}

/**
 * Execute a verdict-driven conditional jump to `targetIndex`. Bounds the state
 * machine via the per-gate max_jumps cap (default 3). Forward jumps mark the
 * intermediate steps as skipped (completed + skipped); backward jumps reset
 * steps[targetIndex..gateIndex] (mirroring FAIL-retry semantics) so the path
 * re-runs. Every re-entered gate's retry counters
 * (attempts/invalidAttempts/malformedAttempts/timeoutAttempts) are reset,
 * including the triggering gate; only the jump/loop bounds
 * (jumpCount/loopIterations) are preserved, so retry + jump bounds compose safely.
 *
 * Returns true when the jump dispatched (caller must not also advance), false
 * when the jump cap was exceeded and the run terminated.
 */
export async function gotoWorkflowStep(
    ctx: PluginContext,
    team: Team,
    gateIndex: number,
    targetIndex: number,
    transition: WorkflowJumpTransition,
): Promise<boolean> {
    const task = team.activeTask;
    if (!task || task.type !== "workflow") return false;
    const steps = task.steps ?? [];
    const gate = steps[gateIndex];
    const target = steps[targetIndex];
    if (!gate || gate.kind !== "gate" || !target) return false;

    // Loop-controlled backward FAIL gotos use loopIterations instead of jumpCount.
    const isBackwardLoop = targetIndex < gateIndex && gate.loop !== undefined && transition.verdict === "FAIL";
    const maxJ = gate.maxJumps ?? DEFAULT_MAX_JUMPS;
    if (!isBackwardLoop) {
        gate.jumpCount = (gate.jumpCount ?? 0) + 1;
        if (gate.jumpCount > maxJ) {
            await finishRun(
                ctx,
                team,
                workflowJumpLimitReason(gate.verifier),
                "failed",
            );
            return false;
        }
    }

    if (targetIndex > gateIndex) {
        // Forward jump: mark intermediate steps as skipped.
        for (let i = gateIndex + 1; i < targetIndex; i++) {
            const s = steps[i];
            if (!s) continue;
            if (!s.completed) {
                s.completed = true;
                s.skipped = true;
                markWorkflowStepCompleted(s);
            }
        }
    } else if (targetIndex < gateIndex) {
        // Backward jump: reset steps[target..gate] so the path re-runs.
        for (let i = targetIndex; i <= gateIndex; i++) {
            const s = steps[i];
            if (!s) continue;
            s.completed = false;
            s.skipped = false;
            s.approvalBeforeGranted = undefined;
            resetWorkflowStepTiming(s);
            if (s.kind === "task") {
                s.output = undefined;
                s.taskAttempts = 0;
                // H51: reset task timeoutAttempts too. The base-class field
                // (WorkflowStepRuntime.timeoutAttempts) is shared by task
                // and gate, but only the gate branch reset it. A task with
                // exhausted timeoutAttempts from a previous pass would fail
                // immediately on timeout in the re-run.
                s.timeoutAttempts = 0;
            }
            if (s.kind === "gate") {
                s.verdict = undefined;
                // Clear cached per-verifier results so the ensemble gate
                // re-dispatches every verifier when the body re-runs.
                s.ensembleResults = undefined;
                // H-1: reset retry counters on EVERY re-entered gate, including
                // the triggering gate. The prior `i !== gateIndex` guard left
                // the triggering gate with its exhausted budget, so a gate
                // configured with `on_fail: retry, max_retries: 1` that already
                // used its retry on the previous pass would fail immediately
                // on the re-run — defeating the purpose of the backward jump.
                // The outer loop bound (jumpCount, incremented above) is still
                // respected, so infinite loops are still prevented.
                s.attempts = 0;
                s.invalidAttempts = 0;
                s.malformedAttempts = 0;
                s.timeoutAttempts = 0;
            }
            // Reset join runtime tracking so a re-run fanout/join pair
            // starts with a clean branch state (no stale errored/survivor
            // branch IDs from the prior run through this range).
            if (s.kind === "join" && s.join) {
                s.join = {
                    ...s.join,
                    erroredBranchIds: undefined,
                    survivorBranchIds: undefined,
                    selectedBranchId: undefined,
                    selectionRationale: undefined,
                    joinedOutput: undefined,
                };
            }
        }
    }
    // Forward jumps mark the triggering gate complete so find-next-incomplete
    // does not loop back to it and approval resume advances past it. Backward
    // jumps leave the gate incomplete so it re-verifies the re-run path on the
    // next advance (mirroring FAIL-retry semantics).
    if (targetIndex > gateIndex) {
        settleForwardGotoGate(task, gate);
    }

    recordEvent(team, {
        timestamp: Date.now(),
        kind: "stage_advanced",
        stage: targetIndex,
        detail: `workflow jump: step ${gateIndex + 1} -> step ${targetIndex + 1}`
            + ` (${transition.reason}${transition.verdict ? ` ${transition.verdict}` : ""})`
            + `; jump ${gate.jumpCount}/${maxJ}`,
    });

    moveActiveWorkflowStep(task, gateIndex, targetIndex);
    if (await maybePauseBeforeWorkflowStep(ctx, team, targetIndex)) return true;
    const dispatched =
        target.kind === "task"
            ? await dispatchTaskStep(
                  ctx,
                  team,
                  task,
                  targetIndex,
                  buildJumpContext(transition),
              )
            : await dispatchGateStep(ctx, team, task, targetIndex);
    if (!dispatched) {
        // H-2: dispatchTaskStep / dispatchGateStep may have already finishRun
        // the team (e.g. input-skipped violation in dispatchTaskStep, or any
        // other finishRun-on-false path). Detect that and bail rather than
        // treating it as a tolerance-fanout branch error and continuing to
        // dispatch other branches against the terminated run.
        if (team.activeTask !== task) return false
        const result = await handleWorkflowDispatchUnavailable(ctx, team, task, target);
        if (result === "degraded") await advanceWorkflowStep(ctx, team);
        return false;
    }
    await saveTeamState(team);
    return true;
}

/**
 * Advance the workflow: find the next incomplete step, dispatch it (task or
 * gate), or -- if all steps are complete -- trigger signoff then deliver
 * (workflow_complete). Shared by the task-step completion path and the
 * gate-PASS path, and by resumeWorkflowMode / approval resume.
 */
export async function advanceWorkflowStep(
    ctx: PluginContext,
    team: Team,
): Promise<void> {
    const task = team.activeTask;
    if (!task || task.type !== "workflow") return;
    const steps = task.steps ?? [];

    if (task.activeStepIndices !== undefined) {
        let previousActive = new Set(getActiveWorkflowStepIndices(task));

        for (;;) {
            const ready = sortedWorkflowIndices(readyWorkflowStepIndices(task));
            if (ready.length === 0) {
                if (steps.findIndex((s) => !s.completed) === -1) {
                    if (await maybeTriggerSignoff(ctx, team)) return;
                    await finishRun(
                        ctx,
                        team,
                        workflowCompleteReason(),
                        "idle",
                    );
                    return;
                }
                // Frontier deadlock: steps remain incomplete but NONE are ready.
                // Persisting activeStepIndices=[] would make all future
                // readyWorkflowStepIndices calls return empty, permanently
                // locking the workflow. Fail-fast instead so the run terminates
                // with a diagnosable reason rather than hanging to wall-clock.
                await finishRun(
                    ctx,
                    team,
                    "workflow_frontier_deadlock",
                    "failed",
                );
                return;
            }

            completeExpandedFanoutMarkers(steps, ready);
            task.activeStepIndices = ready;
            task.currentStageIndex = ready[0] ?? task.currentStageIndex;
            let dispatched = false;

            for (const index of ready) {
                const step = steps[index];
                if (step === undefined) continue;

                switch (step.kind) {
                    case "task": {
                        // Skip if previously active AND either dispatched (in-flight)
                        // or has a pending response (will be processed by
                        // handleWorkflowIdle, e.g. during resume).
                        if (previousActive.has(index) && (step.dispatchedAt !== undefined
                            || stepHasPendingResponse(task, step))) break;
                        if (
                            await maybePauseBeforeWorkflowStep(ctx, team, index)
                        )
                            return;
                        if (!(await dispatchTaskStep(ctx, team, task, index))) {
                            // H-2: input-guard finishRun detection. See goto
                            // jump path above for the same guard.
                            if (team.activeTask !== task) return;
                            const result = await handleWorkflowDispatchUnavailable(ctx, team, task, step);
                            if (result === "failed") return;
                            break;
                        }
                        dispatched = true;
                        break;
                    }
                    case "gate": {
                        if (previousActive.has(index) && (step.dispatchedAt !== undefined
                            || stepHasPendingResponse(task, step))) break;
                        if (
                            await maybePauseBeforeWorkflowStep(ctx, team, index)
                        )
                            return;
                        if (!(await dispatchGateStep(ctx, team, task, index))) {
                            // H-2: same finishRun-already-called detection as
                            // the task dispatch path above.
                            if (team.activeTask !== task) return;
                            const result = await handleWorkflowDispatchUnavailable(ctx, team, task, step);
                            if (result === "failed") return;
                            break;
                        }
                        dispatched = true;
                        break;
                    }
                    case "fanout":
                        step.completed = true;
                        break;
                    case "join": {
                        const result = await completeWorkflowJoinStep(
                            ctx,
                            team,
                            task,
                            steps,
                            index,
                        );
                        if (result === "failed") return;
                        if (result === "dispatched" || result === "waiting")
                            dispatched = true;
                        // H-3: when a join completes and the workflow task has
                        // human_approval set, pause for master approval before
                        // the loop dispatches the next ready step. Mirrors the
                        // linear advance path's maybeRequestApproval call
                        // (handler.ts) so fanout→downstream transitions respect
                        // the same boundary as task→task transitions.
                        if (result === "completed" && task.humanApproval === true) {
                            const paused = await maybeRequestApproval(ctx, team, {
                                kind: "workflow_step",
                                stage: index,
                                summary: `Completed ${describeStep(step, index)} (join fired).`
                                    + ` Review before continuing to downstream step.`,
                            })
                            if (paused) return
                        }
                        break;
                    }
                    default:
                        assertNeverWorkflowStepKind(step);
                }
            }

            if (dispatched) {
                await saveTeamState(team);
                return;
            }
            if (hasWaitingActiveWorkflowActor(steps, previousActive, ready, task.responses)) {
                await saveTeamState(team);
                return;
            }
            previousActive = new Set(getActiveWorkflowStepIndices(task));
        }
    }

    const nextIndex = steps.findIndex((s) => !s.completed);
    if (nextIndex === -1) {
        if (await maybeTriggerSignoff(ctx, team)) return;
        await finishRun(ctx, team, workflowCompleteReason(), "idle");
        return;
    }
    task.currentStageIndex = nextIndex;
    const step = steps[nextIndex];
    if (!step) return;
    if (await maybePauseBeforeWorkflowStep(ctx, team, nextIndex)) return;
    const dispatched =
        step.kind === "task"
            ? await dispatchTaskStep(ctx, team, task, nextIndex)
            : await dispatchGateStep(ctx, team, task, nextIndex);
    if (!dispatched) {
        // H-2: detect prior finishRun (e.g. input-guard violation).
        if (team.activeTask !== task) return;
        await handleWorkflowDispatchUnavailable(ctx, team, task, step);
        return;
    }
    await saveTeamState(team);
}

/** NEW: settle an ensemble gate whose verifiers have all responded. */
async function settleEnsembleGate(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    step: WorkflowGateStep,
): Promise<void> {
    // Lazy import to break the engine↔verdict cycle.
    const { handleGateVerdict } = await import("./verdict.js")
    const verifierName = step.verifiers?.[0];
    if (!verifierName) return;
    const member = team.members.find(m => m.name === verifierName);
    if (!member) return;
    const steps = task.steps ?? [];
    const gateIndex = steps.indexOf(step);
    if (gateIndex === -1) return;
    await handleGateVerdict(ctx, team, member, step, gateIndex);
}

/** Re-dispatch a workflow step at the given index (used by crash-resume and timeout-retry paths). */
export async function redispatchWorkflowStep(
    ctx: PluginContext,
    team: Team,
    index: number,
): Promise<boolean> {
    const task = team.activeTask;
    if (!task || task.type !== "workflow") return false;
    const step = task.steps?.[index];
    if (!step || step.completed) return false;

    // Reset stale timing metadata from the prior (crashed/timeout) dispatch
    // so durationMs on completion reflects only the new attempt. All other
    // re-dispatch paths (handleTaskIdle, handleGateRetry, gotoWorkflowStep,
    // handleInvalidVerdict) call this before re-dispatching.
    resetWorkflowStepTiming(step);

    switch (step.kind) {
        case "task":
            return await dispatchTaskStep(ctx, team, task, index);
        case "gate":
            return await dispatchGateStep(ctx, team, task, index);
        case "join":
            return step.join?.joinPolicy === "reduce" || step.join?.joinPolicy === "select"
                ? await dispatchWorkflowJoinReducer(ctx, team, task, index)
                : false;
        case "fanout":
            return false;
        default:
            return assertNeverWorkflowStepKind(step);
    }
}

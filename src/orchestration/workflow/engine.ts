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
    sortedWorkflowIndices,
} from "./dag.js";
import { maybeTriggerSignoff } from "../control/signoff.js";
import { forceApprovalRequest } from "../control/approval.js";
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
            return assertNeverWorkflowStepKind(step.kind);
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
    await dispatchToMember(
        ctx,
        member,
        contextPrefix ? `${contextPrefix}\n\n${text}` : text,
        member.worktreePath ?? ctx.directory,
        team,
        { stepIndex: index, correlationId: step.correlationId },
    );
    markWorkflowStepDispatched(step);
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
        if (step.ensembleResults === undefined) step.ensembleResults = {};
        for (const name of unavailable) {
            step.ensembleResults[name] = {
                verdict: "INVALID",
                score: undefined,
                confidence: undefined,
                issues: undefined,
                rationale: "verifier unavailable",
                diff: undefined,
                parseFailed: true,
            };
        }
    }
    if (dispatchedAny) markWorkflowStepDispatched(step);
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
    await dispatchToMember(
        ctx,
        verifier,
        contextPrefix ? `${contextPrefix}\n\n${prompt}` : prompt,
        verifier.worktreePath ?? ctx.directory,
        team,
        { stepIndex: index, correlationId: step.correlationId },
    );
    markWorkflowStepDispatched(step);
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

/** Check whether any previously-active step still has a dispatched but uncompleted actor. */
export function hasWaitingActiveWorkflowActor(
    steps: WorkflowStep[],
    previousActive: ReadonlySet<number>,
    ready: readonly number[],
): boolean {
    for (const index of ready) {
        const step = steps[index];
        if (step === undefined || !previousActive.has(index)) continue;

        switch (step.kind) {
            case "task":
            case "gate":
                if (!step.completed) return true;
            case "fanout":
            case "join":
                break;
            default:
                return assertNeverWorkflowStepKind(step.kind);
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
                assertNeverWorkflowStepKind(step.kind);
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
    const paused = await forceApprovalRequest(ctx, team, {
        kind: "workflow_step",
        stage: index,
        summary: `Before ${describeStep(step, index)}. Approve to dispatch this step;`
            + ` reject to fail the run as workflow_human_rejected.`,
    });
    if (paused) {
        step.approvalBeforeGranted = true;
        await saveTeamState(team);
        return true;
    }
    // No escalation handler available -> fall through to dispatch.
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

/**
 * Execute a verdict-driven conditional jump to `targetIndex`. Bounds the state
 * machine via the per-gate max_jumps cap (default 3). Forward jumps mark the
 * intermediate steps as skipped (completed + skipped); backward jumps reset
 * steps[targetIndex..gateIndex] (mirroring FAIL-retry semantics) so the path
 * re-runs. The triggering gate's attempts/invalidAttempts/jumpCount are NEVER
 * reset by the range reset, so retry + jump bounds compose safely.
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

    // Loop-controlled backward gotos use loopIterations instead of jumpCount.
    const isLoopGoto = gate.loop !== undefined && targetIndex <= gateIndex && transition.verdict === "FAIL";
    const maxJ = gate.maxJumps ?? DEFAULT_MAX_JUMPS;
    if (!isLoopGoto) {
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
            }
            if (s.kind === "gate") {
                s.verdict = undefined;
                // Clear cached per-verifier results so the ensemble gate
                // re-dispatches every verifier when the body re-runs.
                s.ensembleResults = undefined;
                if (i !== gateIndex) {
                    s.attempts = 0;
                    s.invalidAttempts = 0;
                    s.malformedAttempts = 0;
                    s.timeoutAttempts = 0;
                }
            }
        }
    }
    // Forward jumps mark the triggering gate complete so find-next-incomplete
    // does not loop back to it and approval resume advances past it. Backward
    // jumps leave the gate incomplete so it re-verifies the re-run path on the
    // next advance (mirroring FAIL-retry semantics).
    if (targetIndex > gateIndex) {
        gate.completed = true;
        gate.dispatchedActor = undefined;
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
                task.activeStepIndices = [];
                await saveTeamState(team);
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
                        if (previousActive.has(index)) break;
                        if (
                            await maybePauseBeforeWorkflowStep(ctx, team, index)
                        )
                            return;
                        if (!(await dispatchTaskStep(ctx, team, task, index))) {
                            const result = await handleWorkflowDispatchUnavailable(ctx, team, task, step);
                            if (result === "failed") return;
                            break;
                        }
                        dispatched = true;
                        break;
                    }
                    case "gate": {
                        if (previousActive.has(index)) break;
                        if (
                            await maybePauseBeforeWorkflowStep(ctx, team, index)
                        )
                            return;
                        if (!(await dispatchGateStep(ctx, team, task, index))) {
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
                        break;
                    }
                    default:
                        assertNeverWorkflowStepKind(step.kind);
                }
            }

            if (dispatched) {
                await saveTeamState(team);
                return;
            }
            if (hasWaitingActiveWorkflowActor(steps, previousActive, ready)) {
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
        await handleWorkflowDispatchUnavailable(ctx, team, task, step);
        return;
    }
    await saveTeamState(team);
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
            return assertNeverWorkflowStepKind(step.kind);
    }
}

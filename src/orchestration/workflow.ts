/**
 * Workflow handler -- deterministic linear step engine.
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

import type { PluginContext } from "../core/context.js";
import { type Team, saveTeamState } from "../state/store.js";
import type {
    MemberState,
    WorkflowStep,
    WorkflowTask,
} from "../core/types.js";
import {
    aggregateEnsembleVerdict,
    buildGateProducerOutput,
    buildGateVerifierPrompt,
    buildJumpContext,
    gatedGotoIndex,
    gateTargetIndex,
    gateTargetIndices,
    stepIndicesLabel,
    whereReason,
    workflowTargetLabel,
    type WorkflowJumpTransition,
} from "./gate.js";
import {
    workflowCompleteReason,
    workflowGateFailReason,
    workflowInvalidReason,
    workflowJumpLimitReason,
} from "./reasons.js";
import { dispatchToMember } from "./dispatch.js";
import { finishRun } from "./summary.js";
import { recordEvent } from "./events.js";
import { truncateOutput } from "./output.js";
import {
    findActiveWorkflowStepIndexForMember,
    getActiveWorkflowStepIndices,
    readyWorkflowStepIndices,
    sortedWorkflowIndices,
} from "./dag.js";
import { parseSelection, parseVerdict } from "./decisions.js";
import { maybeTriggerSignoff } from "./signoff.js";
import { forceApprovalRequest, maybeRequestApproval } from "./hitl.js";
import {
    branchIdsForJoin,
    buildBranchWorkflowOutput,
    completeWorkflowJoinStep,
    dispatchWorkflowJoinReducer,
    handleWorkflowDispatchUnavailable,
    liveWorkflowActor,
    markWorkflowStepCompleted,
    markWorkflowStepDispatched,
} from "./fanout.js";

import { buildWorkflowUpstream } from "./upstream.js";

function assertNeverWorkflowStepKind(value: never): never {
    throw new Error(`unhandled workflow step kind: ${String(value)}`);
}

function describeStep(step: WorkflowStep | undefined, index: number): string {
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

/** Check whether a task step's output matches its retry_on condition. */
function shouldRetryTask(step: WorkflowStep, output: string): boolean {
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
async function dispatchEnsembleGate(
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
    for (const verifierName of step.verifiers) {
        // skip verifiers that already have results (e.g., on partial retry)
        if (step.ensembleResults?.[verifierName] !== undefined) continue;
        const verifier = team.members.find(
            (m) => m.name === verifierName && !m.isMaster,
        );
        if (!(verifier?.sessionId !== undefined && verifier.status !== "errored")) continue;
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
    if (dispatchedAny) markWorkflowStepDispatched(step);
    return dispatchedAny;
}

/** Dispatch a gate step's verifier with the preceding task's output + criteria. */
async function dispatchGateStep(
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

function resetWorkflowStepTiming(step: WorkflowStep): void {
    step.startedAt = undefined;
    step.completedAt = undefined;
    step.durationMs = undefined;
    step.dispatchedAt = undefined;
    step.dispatchedActor = undefined;
}

function moveActiveWorkflowStep(
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

function hasWaitingActiveWorkflowActor(
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
                break;
            case "fanout":
            case "join":
                break;
            default:
                return assertNeverWorkflowStepKind(step.kind);
        }
    }

    return false;
}

function completeExpandedFanoutMarkers(
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
    step.approvalBeforeGranted = true;
    const paused = await forceApprovalRequest(ctx, team, {
        kind: "workflow_step",
        stage: index,
        summary: `Before ${describeStep(step, index)}. Approve to dispatch this step; reject to fail the run as workflow_human_rejected.`,
    });
    if (paused) {
        await saveTeamState(team);
        return true;
    }
    // No escalation handler available -> clear the grant and fall through to dispatch.
    step.approvalBeforeGranted = undefined;
    return false;
}

/**
 * Per-step approval_after: if the just-completed step declares it, force an
 * HITL pause before the workflow advances. team_approve resumes via
 * advanceWorkflowStep. Returns true when paused (caller must NOT advance).
 */
async function maybePauseAfterWorkflowStep(
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
        summary: `After ${describeStep(step, index)}. Approve to continue; reject to fail the run as workflow_human_rejected.`,
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
async function gotoWorkflowStep(
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
    const isLoopGoto = gate.loop !== undefined && targetIndex <= gateIndex && transition.reason.startsWith("on_fail");
    const maxJ = gate.maxJumps ?? 3;
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
            if (s.kind === "task") s.output = undefined;
            if (s.kind === "gate") {
                s.verdict = undefined;
                if (i !== gateIndex) {
                    s.attempts = 0;
                    s.invalidAttempts = 0;
                }
            }
        }
    }
    // Mark the triggering gate complete so find-next-incomplete does not loop
    // back to it after a forward jump, and so approval resume advances past it.
    gate.completed = true;
    gate.dispatchedActor = undefined;

    recordEvent(team, {
        timestamp: Date.now(),
        kind: "stage_advanced",
        stage: targetIndex,
        detail: `workflow jump: step ${gateIndex + 1} -> step ${targetIndex + 1} (${transition.reason}${transition.verdict ? ` ${transition.verdict}` : ""}); jump ${gate.jumpCount}/${maxJ}`,
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

/**
 * Workflow core state machine. processIdle captures the idle member's current
 * turn; this function validates that the member belongs to the active frontier
 * and advances only that matching step.
 */
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
        markWorkflowStepCompleted(step);
        step.dispatchedAt = undefined;
        step.dispatchedActor = undefined;
        step.completed = true;
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "captured",
            member: member.name,
            stepIndex: activeStepIndex,
            correlationId: step.correlationId,
            bytes: step.output?.length,
            detail: `workflow step ${activeStepIndex + 1} captured`,
        });
        step.dispatchedActor = undefined;
        step.correlationId = undefined;
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
        markWorkflowStepCompleted(step);
        step.dispatchedAt = undefined;
        step.dispatchedActor = undefined;
        step.correlationId = undefined;
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
    if (step.kind !== "gate") return;
    if (step.verifier === undefined && step.verifiers === undefined) return;
    const verifierName = member.name;
    let v = parseVerdict(step.output ?? task.responses[verifierName] ?? "");
    // ensemble gate: collect per-verifier results before aggregation
    if (step.verifiers !== undefined) {
        if (!step.verifiers.includes(verifierName)) return;
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
            stage: activeStepIndex,
            stepIndex: activeStepIndex,
            correlationId: step.correlationId,
            detail: v.verdict ?? "parse_fail",
        });
        // wait for more verifiers
        const total = step.verifiers.length;
        const completed = Object.keys(step.ensembleResults).length;
        if (completed < total) return;
        // all verifiers done: aggregate
        const aggregated = aggregateEnsembleVerdict(step);
        v = {
            verdict: aggregated.verdict,
            rationale: aggregated.rationale,
            diff: aggregated.diff,
            parseFailed: aggregated.parseFailed,
            score: undefined,
            confidence: undefined,
            issues: undefined,
        };
        // record aggregated verdict
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "verdict",
            member: "ensemble",
            stage: activeStepIndex,
            stepIndex: activeStepIndex,
            detail: `${aggregated.verdict} (${aggregated.rationale})`,
        });
    } else {
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "verdict",
            member: verifierName,
            stage: activeStepIndex,
            stepIndex: activeStepIndex,
            correlationId: step.correlationId,
            detail: v.verdict ?? "parse_fail",
        });
    }

    step.verdict = v.verdict;
    step.score = v.score;
    step.confidence = v.confidence;
    step.issues = v.issues;

    if (v.parseFailed || !v.verdict) {
        await handleInvalidVerdict(
            ctx,
            team,
            step,
            activeStepIndex,
            verifierName,
            "parse_failure",
            v.rationale,
            v.diff,
        );
        return;
    }

    if (v.verdict === "INVALID") {
        await handleInvalidVerdict(
            ctx,
            team,
            step,
            activeStepIndex,
            verifierName,
            "INVALID",
            v.rationale,
            v.diff,
        );
        return;
    }

    if (v.verdict === "PASS") {
        markWorkflowStepCompleted(step);
        step.dispatchedAt = undefined;
        step.dispatchedActor = undefined;
        step.correlationId = undefined;
        step.completed = true;
        // approval_after on a gate is validator-guaranteed incompatible with
        // on_*_goto, so pausing here cannot be bypassed by a goto jump.
        if (await maybePauseAfterWorkflowStep(ctx, team, activeStepIndex))
            return;
        const gotoIdx = gatedGotoIndex(steps, activeStepIndex, step.onPassGoto);
        const nextIndex =
            gotoIdx >= 0 ? gotoIdx : steps.findIndex((s) => !s.completed);
        if (
            step.branch === undefined &&
            nextIndex !== -1 &&
            (await maybeRequestApproval(ctx, team, {
                kind: "workflow_step",
                stage: activeStepIndex,
                summary: `Completed ${describeStep(step, activeStepIndex)} with PASS from ${verifierName}. Rationale: ${v.rationale}. Next: ${describeStep(steps[nextIndex], nextIndex)}. Review before continuing.`,
            }))
        ) {
            return;
        }
        if (gotoIdx >= 0) {
            await gotoWorkflowStep(ctx, team, activeStepIndex, gotoIdx, {
                reason: whereReason(step, "on_pass"),
                verdict: "PASS",
                rationale: v.rationale,
                diff: v.diff,
            });
            return;
        }
        await advanceWorkflowStep(ctx, team);
        return;
    }

    // v.verdict === "FAIL"
    const onFail = step.onFail ?? "fail";
    if (onFail === "fail") {
        const failGoto = gatedGotoIndex(
            steps,
            activeStepIndex,
            step.onFailGoto,
        );
        if (failGoto >= 0) {
            if (step.loop !== undefined) {
                step.loopIterations = (step.loopIterations ?? 0) + 1;
                if (step.loopIterations > step.loop.maxIterations) {
                    if (step.loop.onExhaust === "continue") {
                        delete task.responses[verifierName];
                        markWorkflowStepCompleted(step);
                        step.completed = true;
                        step.dispatchedAt = undefined;
                        step.dispatchedActor = undefined;
                        step.correlationId = undefined;
                        recordEvent(team, {
                            timestamp: Date.now(),
                            kind: "stage_advanced",
                            member: verifierName,
                            stage: activeStepIndex,
                            stepIndex: activeStepIndex,
                            detail: `workflow loop step ${activeStepIndex + 1} exhausted after ${step.loop.maxIterations} iterations; on_exhaust=continue`,
                        });
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
            await gotoWorkflowStep(ctx, team, activeStepIndex, failGoto, {
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
        return;
    }
    if (onFail === "skip") {
        delete task.responses[verifierName];
        markWorkflowStepCompleted(step);
        step.completed = true;
        step.skipped = true;
        step.dispatchedAt = undefined;
        step.dispatchedActor = undefined;
        step.correlationId = undefined;
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "stage_advanced",
            member: verifierName,
            stage: activeStepIndex,
            stepIndex: activeStepIndex,
            detail: `workflow gate step ${activeStepIndex + 1} skipped after FAIL from ${verifierName}`,
        });
        await advanceWorkflowStep(ctx, team);
        return;
    }
    // onFail === "retry": bounded retry of the preceding task.
    delete task.responses[verifierName];
    step.attempts = (step.attempts ?? 0) + 1;
    const maxR = step.maxRetries ?? 0;
    if (step.attempts > maxR) {
        const failGoto = gatedGotoIndex(
            steps,
            activeStepIndex,
            step.onFailGoto,
        );
        if (failGoto >= 0) {
            await gotoWorkflowStep(ctx, team, activeStepIndex, failGoto, {
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
    const gateIndex = activeStepIndex;
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
        retryStep.approvalBeforeGranted = undefined;
        resetWorkflowStepTiming(retryStep);
        if (retryStep.kind === "task") retryStep.output = undefined;
        if (retryStep.kind === "gate") {
            retryStep.verdict = undefined;
            if (i !== gateIndex) retryStep.attempts = 0;
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
    // silently bypassed the leader gate that the step declared.
    if (await maybePauseBeforeWorkflowStep(ctx, team, producerIdx)) return;
    const feedback =
        `[Gate FAILED - attempt ${step.attempts}/${maxR}]\n` +
        `Rationale: ${v.rationale}\nDiff: ${v.diff}\nFix and resubmit.`;
    step.dispatchedActor = undefined;
    if (!(await dispatchTaskStep(ctx, team, task, producerIdx, feedback))) {
        await handleWorkflowDispatchUnavailable(ctx, team, task, producerStep);
        return;
    }
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "retry",
        member: producerStep.dispatchedActor ?? producerStep.member,
        stage: gateIndex,
        stepIndex: producerIdx,
        detail: `workflow step ${gateIndex + 1} attempt ${step.attempts}/${maxR}; retry target ${stepIndicesLabel(gateTargetIndices(steps, gateIndex))}; retry anchor step ${producerIdx + 1}; verifier ${verifierName}; diff: ${v.diff}`,
    });
    await saveTeamState(team);
}

/**
 * Handle an unevaluable gate verdict (INVALID or parse failure) according to
 * the gate's on_invalid / on_malformed policy. Producer-neutral in all cases:
 * the target task is never retried on INVALID or parse_failure (only the
 * verifier may be re-dispatched).
 *
 *   parse_failure -> routes through on_malformed (with fallback to on_invalid):
 *     fail          -> terminate as workflow_invalid:<reason>:<verifier>
 *     retry_verifier-> re-dispatch THIS gate's verifier (bounded by
 *                      max_malformed_retries, falling back to max_invalid_retries)
 *     skip          -> mark the gate skipped and advance (on_malformed only)
 *     escalate      -> force a human-approval pause
 *   INVALID       -> routes through on_invalid:
 *     fail          -> terminate as workflow_invalid:<reason>:<verifier>
 *     retry_verifier-> re-dispatch THIS gate's verifier (bounded by
 *                      max_invalid_retries), then on exhaust terminate.
 *     escalate      -> force a human-approval pause; approve marks the gate
 *                      complete and advances, reject terminates.
 */
async function handleInvalidVerdict(
    ctx: PluginContext,
    team: Team,
    step: WorkflowStep,
    gateIndex: number,
    verifierName: string,
    reason: "INVALID" | "parse_failure",
    rationale: string,
    diff: string,
): Promise<void> {
    const task = team.activeTask;
    if (!task || task.type !== "workflow") return;
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
        markWorkflowStepCompleted(step);
        step.completed = true;
        step.skipped = true;
        step.dispatchedAt = undefined;
        step.dispatchedActor = undefined;
        step.correlationId = undefined;
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "stage_advanced",
            member: verifierName,
            stage: gateIndex,
            stepIndex: gateIndex,
            detail: `workflow gate step ${gateIndex + 1} skipped after malformed verdict from ${verifierName}: ${rationale}`,
        });
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
        resetWorkflowStepTiming(step);
        if (await maybePauseBeforeWorkflowStep(ctx, team, gateIndex)) return;
        const nudge =
            `[Verification could not be evaluated — ${isMalformed ? "malformed" : "invalid"} attempt ${attempts}/${maxIR}]\n` +
            `Reason: ${reason}. Rationale: ${rationale}. Diff: ${diff}.\n` +
            `Re-evaluate the target output and emit a fresh verdict.`;
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
            detail: `workflow step ${gateIndex + 1} ${isMalformed ? "malformed" : "invalid"} retry ${attempts}/${maxIR}; verifier ${step.dispatchedActor ?? verifierName}; reason ${reason}: ${rationale}`,
        });
        await saveTeamState(team);
        return;
    }

    if (policy === "escalate") {
        const nextIndex = (task.steps ?? []).findIndex((s) => !s.completed);
        const escalated = await forceApprovalRequest(ctx, team, {
            kind: "workflow_step",
            stage: gateIndex,
            summary: `Step ${gateIndex + 1} (gate) by ${verifierName} could not be evaluated (${reason}). Rationale: ${rationale}. Approve to override and continue${nextIndex !== -1 ? ` to ${describeStep((task.steps ?? [])[nextIndex], nextIndex)}` : ""}; reject to fail as workflow_invalid.`,
        });
        if (escalated) {
            // Mark the gate complete so that on team_approve (which calls
            // advanceWorkflowStep) the workflow proceeds past this gate.
            step.completed = true;
            step.dispatchedActor = undefined;
            await saveTeamState(team);
            return;
        }
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

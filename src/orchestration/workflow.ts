/**
 * Workflow handler -- deterministic linear step engine (GAP-2).
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
import crypto from "node:crypto";
import { type Team, saveTeamState } from "../state/store.js";
import type {
    MemberState,
    Verdict,
    WorkflowBranchMetadata,
    WorkflowCondition,
    WorkflowStep,
    WorkflowTask,
} from "../core/types.js";
import {
    formatWorkflowCondition,
    matchesWorkflowCondition,
} from "./workflow-conditions.js";
import {
    workflowCompleteReason,
    workflowFanoutAllErroredReason,
    workflowFanoutOverToleranceReason,
    workflowGateFailReason,
    workflowInvalidReason,
    workflowJumpLimitReason,
    workflowNoSessionReason,
} from "./workflow-reasons.js";
import { dispatchToMember } from "./dispatch.js";
import { finishRun } from "./summary.js";
import { recordEvent } from "./events.js";
import { truncateOutput } from "../core/utils.js";
import {
    findActiveWorkflowStepIndexForMember,
    getActiveWorkflowStepIndices,
    readyWorkflowStepIndices,
} from "./workflow-dag.js";
import { parseSelection, parseVerdict } from "./decisions.js";
import { maybeTriggerSignoff } from "./signoff.js";
import { forceApprovalRequest, maybeRequestApproval } from "./hitl.js";

// Total byte budget for injected upstream context (mirrors dispatch.ts). Caps
// prompt growth so a long workflow does not bloat the actor's prompt linearly.
const UPSTREAM_TOTAL_CAP = 65_536;

type WorkflowJumpTransition = {
    reason: string;
    verdict?: Verdict;
    rationale?: string;
    diff?: string;
};

export type WorkflowFanoutErrorResult =
    | { readonly kind: "not_fanout" }
    | { readonly kind: "within_tolerance" }
    | { readonly kind: "failed"; readonly reason: string };

/**
 * Build the upstream-context prefix for a workflow task step: ALL completed
 * prior TASK-step outputs (gate steps are skipped -- their verdicts are
 * control-flow, not work product), each labelled by member and individually
 * truncated, then capped at UPSTREAM_TOTAL_CAP total bytes. Returns "" when
 * there is no completed task-step upstream.
 */
function buildWorkflowUpstream(
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
            return assertNeverWorkflowStepKind(candidate.kind);
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

function isSameWorkflowBranch(
    step: WorkflowStep,
    branch: WorkflowBranchMetadata,
): boolean {
    const stepBranch = step.branch;
    return (
        stepBranch !== undefined &&
        stepBranch.fanoutIndex === branch.fanoutIndex &&
        stepBranch.branchId === branch.branchId
    );
}

function workflowStepActorName(step: WorkflowStep): string | undefined {
    switch (step.kind) {
        case "task":
            return step.dispatchedActor ?? step.member;
        case "gate":
            return step.dispatchedActor ?? step.verifier;
        case "fanout":
        case "join":
            return undefined;
        default:
            return assertNeverWorkflowStepKind(step.kind);
    }
}

/**
 * Build the verifier's dispatch prompt: the preceding task's output, the
 * criteria, and the exact <verdict> block the verifier must emit. PASS = the
 * output meets the criteria, FAIL = it does not (rationale + diff).
 *
 * When the gate carries a `where` threshold condition, the prompt additionally
 * asks the verifier to emit the structured fields that condition evaluates
 * against (score / confidence / issues), so the threshold can actually match
 * in practice.
 */
function buildGateVerifierPrompt(
    step: WorkflowStep,
    producerOutput: string,
    targetLabel: string,
    targetCount: number,
): string {
    const structuredHint = buildStructuredVerdictHint(step.where);
    const aggregationHint = targetCount > 1
        ? `This gate verifies an aggregate of multiple target outputs. Emit one verdict for the complete target set; PASS only when every target satisfies the criteria and the targets are mutually consistent.`
        : "";
    return (
        `[Verification gate] Verify ${targetLabel} output below against the criteria.\n` +
        `Criteria: ${step.criteria ?? ""}\n\n` +
        `Producer output:\n${producerOutput}\n\n` +
        (aggregationHint ? `${aggregationHint}\n\n` : "") +
        (structuredHint ? `${structuredHint}\n\n` : "") +
        `Emit EXACTLY one:\n` +
        `<verdict>${buildVerdictSchemaExample(step.where)}</verdict>\n` +
        `PASS = the output meets the criteria. FAIL = it does not (give rationale + diff). ` +
        `INVALID = you cannot evaluate the output or criteria; this is not a producer failure.`
    );
}

/**
 * Describe the structured fields a `where` condition needs, and emit a matching
 * `<verdict>` JSON example. A gate without `where` requests only the base
 * result/rationale/diff triple, keeping prompts minimal for gates that do not
 * gate on thresholds.
 */
function buildStructuredVerdictHint(
    where: WorkflowCondition | undefined,
): string {
    if (where === undefined) return "";
    const fields: string[] = [];
    switch (where.kind) {
        case "score_gte":
        case "score_lt":
            fields.push("score: a numeric quality score on a 0-10 scale");
            fields.push("confidence: a 0-1 confidence in your verdict");
            break;
        case "confidence_gte":
            fields.push("confidence: a 0-1 confidence in your verdict");
            break;
        case "has_issue_severity":
            fields.push(
                "issues: an array of { severity: low|medium|high|critical, message?: string } for every issue you found, ordered by severity",
            );
            break;
        default:
            return assertNeverWorkflowCondition(where);
    }
    return `This gate gates a downstream step on a threshold condition (${formatWorkflowCondition(where)}). Also emit structured fields so the condition can be evaluated:\n- ${fields.join("\n- ")}`;
}

function buildVerdictSchemaExample(
    where: WorkflowCondition | undefined,
): string {
    const base = `"result":"PASS|FAIL|INVALID","rationale":"...","diff":"..."`;
    if (where === undefined) return `{${base}}`;
    const extras: string[] = [];
    switch (where.kind) {
        case "score_gte":
        case "score_lt":
            extras.push(`"score":8`);
            extras.push(`"confidence":0.9`);
            break;
        case "confidence_gte":
            extras.push(`"confidence":0.9`);
            break;
        case "has_issue_severity":
            extras.push(`"issues":[{"severity":"high","message":"..."}]`);
            break;
        default:
            return assertNeverWorkflowCondition(where);
    }
    return `{${base},${extras.join(",")}}`;
}

/**
 * Find the nearest preceding TASK step index for a gate (for retry and for the
 * gate's producer output). Returns -1 when there is none (a gate-first
 * workflow is rejected at the tool layer; the handler guards defensively).
 */
function precedingTaskIndex(steps: WorkflowStep[], gateIndex: number): number {
    for (let i = gateIndex - 1; i >= 0; i--) {
        if (canGateReferenceTask(steps, gateIndex, i)) return i;
    }
    return -1;
}

function gateTargetIndex(steps: WorkflowStep[], gateIndex: number): number {
    const targets = gateTargetIndices(steps, gateIndex);
    return targets[0] ?? -1;
}

function gateTargetIndices(steps: WorkflowStep[], gateIndex: number): number[] {
    const gate = steps[gateIndex];
    if (gate?.kind !== "gate") return [];
    if (
        gate.targetStepIndices !== undefined &&
        gate.targetStepIndices.length > 0
    ) {
        return gate.targetStepIndices
            .filter((targetIndex) =>
                canGateReferenceTask(steps, gateIndex, targetIndex),
            )
            .sort((a, b) => a - b);
    }
    if (gate.targetStepIndex !== undefined) {
        return canGateReferenceTask(steps, gateIndex, gate.targetStepIndex)
            ? [gate.targetStepIndex]
            : [];
    }
    const nearest = precedingTaskIndex(steps, gateIndex);
    return nearest < 0 ? [] : [nearest];
}

function canGateReferenceTask(
    steps: WorkflowStep[],
    gateIndex: number,
    targetIndex: number,
): boolean {
    const gate = steps[gateIndex];
    const target = steps[targetIndex];
    if (gate?.kind !== "gate" || target?.kind !== "task") return false;

    const gateBranch = gate.branch;
    if (gateBranch === undefined) return target.branch === undefined;
    return isSameWorkflowBranch(target, gateBranch);
}

function stepIndicesLabel(indices: number[]): string {
    if (indices.length === 0) return "nearest task";
    const labels = indices.map((index) => String(index + 1));
    const first = labels[0];
    if (first === undefined) return "nearest task";
    return labels.length === 1 ? `step ${first}` : `steps ${labels.join(", ")}`;
}

function workflowTargetLabel(indices: number[]): string {
    return `workflow ${stepIndicesLabel(indices)}`;
}

function buildGateProducerOutput(
    steps: WorkflowStep[],
    targetIndices: number[],
): string {
    const blocks: string[] = [];
    for (const targetIndex of targetIndices) {
        const producerStep = steps[targetIndex];
        if (!producerStep || producerStep.kind !== "task") continue;
        blocks.push(
            `[Step ${targetIndex + 1} output from ${producerStep.member ?? "?"}]\n${truncateOutput(producerStep.output ?? "")}`,
        );
    }
    return blocks.join("\n\n");
}

function buildJumpContext(transition: WorkflowJumpTransition): string {
    const lines = [`[Workflow jump: ${transition.reason}]`];
    if (transition.verdict !== undefined)
        lines.push(`Verdict: ${transition.verdict}`);
    if (transition.rationale !== undefined)
        lines.push(`Rationale: ${transition.rationale}`);
    if (transition.diff !== undefined) lines.push(`Diff: ${transition.diff}`);
    return lines.join("\n");
}

function gatedGotoIndex(
    steps: WorkflowStep[],
    gateIndex: number,
    gotoIndex: number | undefined,
): number {
    const step = steps[gateIndex];
    if (step?.kind !== "gate") return -1;
    if (gotoIndex === undefined || gotoIndex < 0) return -1;
    if (!canGateGotoStep(steps, gateIndex, gotoIndex)) return -1;
    if (step.where === undefined) return gotoIndex;
    return matchesWorkflowCondition(step.where, {
        score: step.score,
        confidence: step.confidence,
        issues: step.issues,
    })
        ? gotoIndex
        : -1;
}

function canGateGotoStep(
    steps: WorkflowStep[],
    gateIndex: number,
    targetIndex: number,
): boolean {
    const gate = steps[gateIndex];
    const target = steps[targetIndex];
    if (gate?.kind !== "gate" || target === undefined) return false;

    const gateBranch = gate.branch;
    if (gateBranch === undefined) return target.branch === undefined;
    return isSameWorkflowBranch(target, gateBranch);
}

function whereReason(step: WorkflowStep, fallback: string): string {
    return step.where === undefined ? fallback : `when:${step.where.kind}`;
}

/** Local exhaustive guard for WorkflowCondition, mirroring workflow-conditions.ts. */
function assertNeverWorkflowCondition(value: never): never {
    throw new Error(`unhandled workflow condition: ${String(value)}`);
}

function assertNeverWorkflowStepKind(value: never): never {
    throw new Error(`unhandled workflow step kind: ${String(value)}`);
}

function hasLiveSession(
    member: MemberState | undefined,
): member is MemberState & { sessionId: string } {
    return member?.sessionId !== undefined && member.status !== "errored";
}

function liveWorkflowActor(
    team: Team,
    primaryName: string | undefined,
    fallbackName: string | undefined,
): (MemberState & { sessionId: string }) | undefined {
    const primary = team.members.find(
        (m) => m.name === primaryName && !m.isMaster,
    );
    if (hasLiveSession(primary)) return primary;
    const fallback = team.members.find(
        (m) => m.name === fallbackName && !m.isMaster,
    );
    return hasLiveSession(fallback) ? fallback : undefined;
}

function dispatchFailureActorName(step: WorkflowStep): string | undefined {
    switch (step.kind) {
        case "task":
            return step.member;
        case "gate":
            return step.verifier;
        case "join":
            return step.join?.reducerMember;
        case "fanout":
            return undefined;
        default:
            return assertNeverWorkflowStepKind(step.kind);
    }
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
        if (!hasLiveSession(verifier)) continue;
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

function buildJoinedWorkflowOutput(
    steps: WorkflowStep[],
    joinIndex: number,
): string {
    const joinStep = steps[joinIndex];
    const join = joinStep?.join;
    if (join === undefined) return "";

    const fanout = steps[join.fanoutIndex]?.fanout;
    const ranges =
        fanout?.branchRanges ??
        join.branchTailIndices.map((tailIndex) => ({
            startIndex: tailIndex,
            endIndex: tailIndex,
        }));
    const erroredBranchIds = new Set(join.erroredBranchIds ?? []);
    const blocks: string[] = [];
    let used = 0;

    for (let branchIndex = 0; branchIndex < ranges.length; branchIndex += 1) {
        const range = ranges[branchIndex];
        if (range === undefined) continue;
        const branchId =
            fanout?.branchIds[branchIndex] ?? `branch-${branchIndex + 1}`;
        if (erroredBranchIds.has(branchId)) continue;
        const branchBlocks: string[] = [];

        for (
            let stepIndex = range.startIndex;
            stepIndex <= range.endIndex;
            stepIndex += 1
        ) {
            const step = steps[stepIndex];
            if (step?.kind !== "task" || !step.completed || !step.output)
                continue;
            if (step.exposeOutput === false) continue;
            branchBlocks.push(
                `[Step ${stepIndex + 1} output from ${step.member ?? "?"}]\n${truncateOutput(step.output)}`,
            );
        }

        if (branchBlocks.length === 0) continue;
        const block = `[Branch ${branchId}]\n${branchBlocks.join("\n\n")}`;
        if (used + block.length > UPSTREAM_TOTAL_CAP) {
            blocks.push(
                `[…joined output truncated at ${UPSTREAM_TOTAL_CAP} bytes]`,
            );
            break;
        }
        blocks.push(block);
        used += block.length;
    }

    return blocks.join("\n\n");
}

function buildBranchWorkflowOutput(
    steps: WorkflowStep[],
    joinIndex: number,
    branchId: string,
): string {
    const join = steps[joinIndex]?.join;
    const fanout = join === undefined ? undefined : steps[join.fanoutIndex]?.fanout;
    if (join === undefined || fanout === undefined) return "";
    const branchIndex = fanout.branchIds.indexOf(branchId);
    const range = branchIndex < 0 ? undefined : fanout.branchRanges[branchIndex];
    if (range === undefined) return "";

    const branchBlocks: string[] = [];
    for (let stepIndex = range.startIndex; stepIndex <= range.endIndex; stepIndex += 1) {
        const step = steps[stepIndex];
        if (step?.kind !== "task" || !step.completed || !step.output) continue;
        if (step.exposeOutput === false) continue;
        branchBlocks.push(
            `[Step ${stepIndex + 1} output from ${step.member ?? "?"}]\n${truncateOutput(step.output)}`,
        );
    }

    return branchBlocks.length === 0 ? "" : `[Branch ${branchId}]\n${branchBlocks.join("\n\n")}`;
}

function buildWorkflowReducePrompt(
    steps: WorkflowStep[],
    joinIndex: number,
): string {
    return `[Workflow reduce task] You are the reducer for workflow join step ${joinIndex + 1}. Combine the branch outputs below into ONE joined result. Output ONLY the final result, with no preamble.\n\n${buildJoinedWorkflowOutput(steps, joinIndex)}`;
}

function buildWorkflowSelectPrompt(
    steps: WorkflowStep[],
    joinIndex: number,
): string {
    const step = steps[joinIndex];
    const branchIds = step?.join === undefined ? [] : branchIdsForJoin(steps, step.join);
    return `[Workflow select task] You are the selector for workflow join step ${joinIndex + 1}. Choose exactly one winning branch id from: ${branchIds.join(", ")}. Emit ONLY <selection>{"winner":"branch_id","rationale":"..."}</selection>.\n\n${buildJoinedWorkflowOutput(steps, joinIndex)}`;
}

function markWorkflowStepDispatched(step: WorkflowStep): void {
    const now = Date.now();
    step.startedAt ??= now;
    step.dispatchedAt = now;
}

function markWorkflowStepCompleted(step: WorkflowStep): void {
    const now = Date.now();
    step.startedAt ??= step.dispatchedAt ?? now;
    step.completedAt = now;
    step.durationMs = Math.max(0, now - step.startedAt);
}

function resetWorkflowStepTiming(step: WorkflowStep): void {
    step.startedAt = undefined;
    step.completedAt = undefined;
    step.durationMs = undefined;
    step.dispatchedAt = undefined;
    step.dispatchedActor = undefined;
}

async function dispatchWorkflowJoinReducer(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    index: number,
): Promise<boolean> {
    const step = task.steps?.[index];
    const joinPolicy = step?.join?.joinPolicy;
    const reducerMember = step?.join?.reducerMember;
    if (
        step?.kind !== "join" ||
        (joinPolicy !== "reduce" && joinPolicy !== "select") ||
        reducerMember === undefined
    ) return false;
    const reducer = liveWorkflowActor(team, reducerMember, undefined);
    if (reducer === undefined) return false;
    // Clear any stale response the reducer left from an earlier workflow step so a
    // crash during the reduce wait cannot be mistaken for a fresh reduce turn on resume.
    delete task.responses[reducer.name];
    step.dispatchedActor = reducer.name;
    step.correlationId = crypto.randomUUID();
    await dispatchToMember(
        ctx,
        reducer,
        joinPolicy === "select"
            ? buildWorkflowSelectPrompt(task.steps ?? [], index)
            : buildWorkflowReducePrompt(task.steps ?? [], index),
        reducer.worktreePath ?? ctx.directory,
        team,
        { stepIndex: index, correlationId: step.correlationId },
    );
    markWorkflowStepDispatched(step);
    return true;
}

function pushUniqueBranchId(
    branchIds: string[],
    branchId: string | undefined,
): void {
    if (branchId !== undefined && !branchIds.includes(branchId))
        branchIds.push(branchId);
}

function branchIdsForJoin(
    steps: WorkflowStep[],
    join: NonNullable<WorkflowStep["join"]>,
): readonly string[] {
    const fanout = steps[join.fanoutIndex]?.fanout;
    if (fanout !== undefined) return fanout.branchIds;

    const branchIds: string[] = [];
    for (const tailIndex of join.branchTailIndices) {
        pushUniqueBranchId(branchIds, steps[tailIndex]?.branch?.branchId);
    }
    return branchIds;
}

function survivorBranchIdsForJoin(
    steps: WorkflowStep[],
    join: NonNullable<WorkflowStep["join"]>,
): readonly string[] {
    const erroredBranchIds = new Set(join.erroredBranchIds ?? []);
    return branchIdsForJoin(steps, join).filter(
        (branchId) => !erroredBranchIds.has(branchId),
    );
}

function joinWithBranchStatus(
    steps: WorkflowStep[],
    join: NonNullable<WorkflowStep["join"]>,
): NonNullable<WorkflowStep["join"]> {
    const erroredBranchIds = [...new Set(join.erroredBranchIds ?? [])];
    return {
        ...join,
        survivorBranchIds: survivorBranchIdsForJoin(steps, join),
        ...(erroredBranchIds.length > 0 ? { erroredBranchIds } : {}),
    };
}

type WorkflowJoinAdvanceResult =
    | "completed"
    | "dispatched"
    | "waiting"
    | "failed"
    | "noop";

async function completeWorkflowJoinStep(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    steps: WorkflowStep[],
    joinIndex: number,
): Promise<WorkflowJoinAdvanceResult> {
    const step = steps[joinIndex];
    const join = step?.join;
    if (step?.kind !== "join" || join === undefined || step.completed)
        return "noop";

    const baseJoin = joinWithBranchStatus(steps, join);
    if (
        (baseJoin.joinPolicy === "reduce" || baseJoin.joinPolicy === "select") &&
        baseJoin.joinedOutput === undefined
    ) {
        step.join = baseJoin;
        if (step.dispatchedAt !== undefined) return "waiting";
        if (!(await dispatchWorkflowJoinReducer(ctx, team, task, joinIndex))) {
            await finishRun(
                ctx,
                team,
                workflowNoSessionReason(baseJoin.reducerMember),
                "failed",
            );
            return "failed";
        }
        return "dispatched";
    }

    step.join = {
        ...baseJoin,
        joinedOutput:
            baseJoin.joinedOutput ??
            buildJoinedWorkflowOutput(steps, joinIndex),
    };
    markWorkflowStepCompleted(step);
    step.dispatchedAt = undefined;
    step.correlationId = undefined;
    step.completed = true;
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "stage_advanced",
        stage: joinIndex,
        detail: `workflow join fired: step ${joinIndex + 1}; fanout step ${join.fanoutIndex + 1}`,
    });
    return "completed";
}

function evaluateWorkflowFanoutError(
    steps: WorkflowStep[],
    joinIndex: number,
): WorkflowFanoutErrorResult {
    const joinStep = steps[joinIndex];
    const join = joinStep?.join;
    if (joinStep?.kind !== "join" || join === undefined)
        return { kind: "not_fanout" };

    const branchIds = branchIdsForJoin(steps, join);
    const erroredBranchIds = [...new Set(join.erroredBranchIds ?? [])];
    const erroredSet = new Set(erroredBranchIds);
    const remainingSurvivors = branchIds.filter(
        (branchId) => !erroredSet.has(branchId),
    ).length;
    const total = branchIds.length;
    const fanoutDisplayStep = join.fanoutIndex + 1;

    // Fail-fast: can the join policy still be satisfied given current errors?
    const impossible = fanoutPolicyImpossible(
        join,
        erroredBranchIds,
        remainingSurvivors,
        total,
    );
    if (impossible) {
        return remainingSurvivors === 0
            ? {
                  kind: "failed",
                  reason: workflowFanoutAllErroredReason(fanoutDisplayStep),
              }
            : {
                  kind: "failed",
                  reason: workflowFanoutOverToleranceReason(fanoutDisplayStep),
              };
    }
    return { kind: "within_tolerance" };
}

/**
 * Given the branches that have errored so far, can the join policy still be
 * satisfied once the remaining (still-running or pending) branches resolve?
 * Used for fail-fast termination when a branch error makes success impossible.
 */
function fanoutPolicyImpossible(
    join: NonNullable<WorkflowStep["join"]>,
    erroredBranchIds: readonly string[],
    remainingSurvivors: number,
    total: number,
): boolean {
    if (join.useSurvivors === true) return remainingSurvivors === 0;
    const erroredSet = new Set(erroredBranchIds);
    switch (join.joinPolicy) {
        case undefined:
        case "tolerance":
            return (
                remainingSurvivors === 0 ||
                erroredBranchIds.length > join.maxErrored
            );
        case "all":
        case "reduce":
        case "select":
            return erroredBranchIds.length > 0;
        case "quorum": {
            const threshold = join.quorum ?? 0;
            const required = Math.ceil(threshold * total);
            return remainingSurvivors < required;
        }
        case "any_success":
            return remainingSurvivors === 0;
        case "required_branches": {
            const required = join.requiredBranchIds ?? [];
            return required.some((branchId) => erroredSet.has(branchId));
        }
        default:
            return (
                remainingSurvivors === 0 ||
                erroredBranchIds.length > join.maxErrored
            );
    }
}

function markWorkflowBranchStepsSkipped(
    steps: WorkflowStep[],
    branch: WorkflowBranchMetadata,
): void {
    const fanout = steps[branch.fanoutIndex]?.fanout;
    const range = fanout?.branchRanges[branch.branchIndex];
    const startIndex = range?.startIndex ?? branch.fanoutIndex + 1;
    const endIndex = range?.endIndex ?? branch.joinIndex - 1;

    for (let index = startIndex; index <= endIndex; index += 1) {
        const step = steps[index];
        if (
            step === undefined ||
            !isSameWorkflowBranch(step, branch) ||
            step.completed
        )
            continue;
        step.completed = true;
        step.skipped = true;
    }
}

function removeActiveWorkflowBranch(
    task: WorkflowTask,
    branch: WorkflowBranchMetadata,
): void {
    const active = getActiveWorkflowStepIndices(task);
    const next = active.filter((index) => {
        const step = task.steps?.[index];
        return step === undefined || !isSameWorkflowBranch(step, branch);
    });
    task.activeStepIndices = sortedWorkflowIndices(
        next.length > 0 ? next : [branch.joinIndex],
    );
    task.currentStageIndex = task.activeStepIndices[0] ?? branch.joinIndex;
}

function recordedErroredBranchForMember(
    steps: WorkflowStep[],
    memberName: string,
): WorkflowBranchMetadata | null {
    for (const step of steps) {
        if (
            step.branch === undefined ||
            workflowStepActorName(step) !== memberName
        )
            continue;
        const join = steps[step.branch.joinIndex]?.join;
        if (join?.erroredBranchIds?.includes(step.branch.branchId) === true)
            return step.branch;
    }
    return null;
}

export function markWorkflowFanoutBranchErrored(
    task: WorkflowTask,
    memberName: string,
): WorkflowFanoutErrorResult {
    const steps = task.steps ?? [];
    const activeIndex = findActiveWorkflowStepIndexForMember(task, memberName);
    const activeBranch =
        activeIndex === null ? null : (steps[activeIndex]?.branch ?? null);
    const branch =
        activeBranch ?? recordedErroredBranchForMember(steps, memberName);
    if (branch === null) return { kind: "not_fanout" };

    const joinStep = steps[branch.joinIndex];
    const join = joinStep?.join;
    if (joinStep?.kind !== "join" || join === undefined)
        return { kind: "not_fanout" };

    const erroredBranchIds = [
        ...new Set([...(join.erroredBranchIds ?? []), branch.branchId]),
    ];
    joinStep.join = {
        ...join,
        erroredBranchIds,
        survivorBranchIds: branchIdsForJoin(steps, join).filter(
            (branchId) => !erroredBranchIds.includes(branchId),
        ),
    };
    markWorkflowBranchStepsSkipped(steps, branch);
    removeActiveWorkflowBranch(task, branch);
    return evaluateWorkflowFanoutError(steps, branch.joinIndex);
}

export async function handleWorkflowDispatchUnavailable(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    step: WorkflowStep,
): Promise<"degraded" | "failed"> {
    const actorName = dispatchFailureActorName(step);
    if (step.branch === undefined || actorName === undefined) {
        await finishRun(ctx, team, workflowNoSessionReason(actorName), "failed");
        return "failed";
    }
    const result = markWorkflowFanoutBranchErrored(task, actorName);
    if (result.kind === "failed") {
        await finishRun(ctx, team, result.reason, "failed");
        return "failed";
    }
    return "degraded";
}

function sortedWorkflowIndices(indices: readonly number[]): number[] {
    return [...indices].sort((left, right) => left - right);
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
 * Aggregate per-verifier results into a single verdict using the ensemble policy.
 * Returns the aggregated verdict plus a parseFailed flag so the downstream
 * PASS/FAIL/INVALID handling routes malformed ensembles through on_malformed.
 */
function aggregateEnsembleVerdict(step: WorkflowStep): {
    verdict: Verdict
    parseFailed: boolean
    rationale: string
    diff: string
} {
    const results = Object.values(step.ensembleResults ?? {});
    const parseFailures = results.filter(r => r.parseFailed).length;
    if (parseFailures > 0) {
        return {
            verdict: "INVALID",
            parseFailed: true,
            rationale: `${parseFailures} verifier(s) produced malformed verdicts`,
            diff: "",
        };
    }
    const verdicts = results.map(r => r.verdict).filter(v => v !== undefined) as Verdict[];
    const passCount = verdicts.filter(v => v === "PASS").length;
    const failCount = verdicts.filter(v => v === "FAIL").length;
    const invalidCount = verdicts.filter(v => v === "INVALID").length;
    const total = verdicts.length;
    switch (step.ensemblePolicy) {
        case "majority":
            if (passCount > total / 2) return { verdict: "PASS", parseFailed: false, rationale: `Majority PASS (${passCount}/${total})`, diff: "" };
            if (failCount > total / 2) return { verdict: "FAIL", parseFailed: false, rationale: `Majority FAIL (${failCount}/${total})`, diff: "" };
            return { verdict: "INVALID", parseFailed: false, rationale: `No majority (${passCount}P/${failCount}F/${invalidCount}I)`, diff: "" };
        case "quorum": {
            const threshold = step.ensembleQuorum ?? 0.5;
            if (passCount / total >= threshold) return { verdict: "PASS", parseFailed: false, rationale: `Quorum PASS (${passCount}/${total} >= ${threshold})`, diff: "" };
            if (failCount / total >= threshold) return { verdict: "FAIL", parseFailed: false, rationale: `Quorum FAIL (${failCount}/${total} >= ${threshold})`, diff: "" };
            return { verdict: "INVALID", parseFailed: false, rationale: `No quorum (${passCount}P/${failCount}F/${invalidCount}I)`, diff: "" };
        }
        case "unanimous":
            if (passCount === total) return { verdict: "PASS", parseFailed: false, rationale: `Unanimous PASS (${passCount}/${total})`, diff: "" };
            if (failCount === total) return { verdict: "FAIL", parseFailed: false, rationale: `Unanimous FAIL (${failCount}/${total})`, diff: "" };
            return { verdict: "INVALID", parseFailed: false, rationale: `Not unanimous (${passCount}P/${failCount}F/${invalidCount}I)`, diff: "" };
        default:
            return { verdict: "INVALID", parseFailed: false, rationale: `Unknown ensemble policy`, diff: "" };
    }
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

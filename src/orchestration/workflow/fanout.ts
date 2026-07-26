/**
 * Workflow fanout/join lifecycle: branch error tolerance, join satisfaction,
 * reduce/select reducer dispatch, and joined-output construction.
 *
 * Extracted from workflow.ts so the fanout-specific state machine transitions
 * (join advance, branch error marking, tolerance evaluation, policy-impossible
 * fail-fast) live in one focused module. The core step dispatch/advance loop
 * remains in workflow.ts.
 */

import crypto from "node:crypto";

import type { PluginContext } from "../../core/context.js";
import type { Team } from "../../state/store.js";
import type {
    MemberState,
    WorkflowBranchMetadata,
    WorkflowStep,
    WorkflowTask,
    WorkflowJoinMetadata,
} from "../../core/types.js";
import { dispatchToMember } from "../control/dispatch.js";
import { finishRun } from "../control/completion.js";
import { recordEvent } from "../records/events.js";
import { truncateOutput } from "../protocol/output.js";
import { joinPolicyImpossible } from "./join-policy.js";
import {
    assertNeverWorkflowStepKind,
    findActiveWorkflowStepIndexForMember,
    getActiveWorkflowStepIndices,
    isSameWorkflowBranch,
    sortedWorkflowIndices,
    workflowStepActorName,
} from "./dag.js";
import {
    workflowFanoutAllErroredReason,
    workflowFanoutOverToleranceReason,
    workflowNoSessionReason,
} from "./reasons.js";
import { findMember } from "../../tools/support.js";

// Total byte budget for joined output (mirrors workflow.ts UPSTREAM_TOTAL_CAP).
const JOINED_TOTAL_CAP = 65_536;

/** Result of evaluating fanout branch errors against join tolerance policy. */
export type WorkflowFanoutErrorResult =
    | { readonly kind: "not_fanout" }
    | { readonly kind: "within_tolerance" }
    | { readonly kind: "failed"; readonly reason: string };

// --- shared step helpers (used by fanout.ts + workflow.ts) ---

/** Mark a workflow step as dispatched with a timestamp. */
export function markWorkflowStepDispatched(step: WorkflowStep): void {
    const now = Date.now();
    step.startedAt ??= now;
    step.dispatchedAt = now;
}

/** Mark a workflow step as completed with a duration computed from startedAt. */
export function markWorkflowStepCompleted(step: WorkflowStep): void {
    const now = Date.now();
    step.startedAt ??= step.dispatchedAt ?? now;
    step.completedAt = now;
    step.durationMs = Math.max(0, now - step.startedAt);
}

/** Check if a member has a live (non-errored) session. */
function hasLiveSession(
    member: MemberState | undefined,
): member is MemberState & { sessionId: string } {
    return member?.sessionId !== undefined && member.status !== "errored";
}

/** Resolve a live (non-errored, has session) actor from primary or fallback name. */
export function liveWorkflowActor(
    team: Team,
    primaryName: string | undefined,
    fallbackName: string | undefined,
): (MemberState & { sessionId: string }) | undefined {
    const primary = findMember(team, primaryName ?? "");
    if (hasLiveSession(primary)) return primary;
    const fallback = findMember(team, fallbackName ?? "");
    return hasLiveSession(fallback) ? fallback : undefined;
}

// --- joined output construction ---

/** Build joined output string from all surviving branches in a fanout. */
function buildJoinedWorkflowOutput(
    steps: WorkflowStep[],
    joinIndex: number,
): string {
    const joinStep = steps[joinIndex];
    const join = joinStep?.kind === "join" ? joinStep.join : undefined;
    if (join === undefined) return "";

    const fanoutStep = steps[join.fanoutIndex];
    const fanout = fanoutStep?.kind === "fanout" ? fanoutStep.fanout : undefined;
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
        const blockSize = Buffer.byteLength(block, "utf8");
        if (used + blockSize > JOINED_TOTAL_CAP) {
            blocks.push(
                `[…joined output truncated at ${JOINED_TOTAL_CAP} bytes]`,
            );
            break;
        }
        blocks.push(block);
        used += blockSize;
    }

    return blocks.join("\n\n");
}

/** Build joined output for a specific branch within a fanout. */
export function buildBranchWorkflowOutput(
    steps: WorkflowStep[],
    joinIndex: number,
    branchId: string,
): string {
    const joinStep = steps[joinIndex];
    const join = joinStep?.kind === "join" ? joinStep.join : undefined;
    const fanoutStep = join === undefined ? undefined : steps[join.fanoutIndex];
    const fanout = fanoutStep?.kind === "fanout" ? fanoutStep.fanout : undefined;
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

// --- reduce/select reducer dispatch ---

/** Build the prompt for a reduce join policy reducer. */
function buildWorkflowReducePrompt(
    steps: WorkflowStep[],
    joinIndex: number,
): string {
    return `[Workflow reduce task]\n` 
        + `You are the reducer for workflow join step ${joinIndex + 1}.`
        + ` Combine the branch outputs below into ONE joined result.`
        + ` Output ONLY the final result, with no preamble.\n\n`
        + buildJoinedWorkflowOutput(steps, joinIndex);
}

/** Build the prompt for a select join policy selector. */
function buildWorkflowSelectPrompt(
    steps: WorkflowStep[],
    joinIndex: number,
): string {
    const step = steps[joinIndex];
    const join = step?.kind === "join" ? step.join : undefined;
    const branchIds = join === undefined ? [] : branchIdsForJoin(steps, join);
    return `[Workflow select task]\n` 
        + `You are the selector for workflow join step ${joinIndex + 1}.`
        + ` Choose exactly one winning branch id from: ${branchIds.join(", ")}.`
        + ` Emit ONLY <selection>{"winner":"branch_id","rationale":"..."}</selection>.\n\n`
        + buildJoinedWorkflowOutput(steps, joinIndex);
}

/** Dispatch the reducer/selector member for a reduce or select join policy. */
export async function dispatchWorkflowJoinReducer(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    index: number,
): Promise<boolean> {
    const step = task.steps?.[index];
    if (step?.kind !== "join") return false;
    const joinPolicy = step.join.joinPolicy;
    const reducerMember = step.join.reducerMember;
    if (
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

// --- branch id helpers ---

/** Push a branch id into an array if not already present. */
function pushUniqueBranchId(
    branchIds: string[],
    branchId: string | undefined,
): void {
    if (branchId !== undefined && !branchIds.includes(branchId))
        branchIds.push(branchId);
}

/** Collect all branch ids belonging to a fanout join. */
export function branchIdsForJoin(
    steps: WorkflowStep[],
    join: WorkflowJoinMetadata,
): readonly string[] {
    const fanoutStep = steps[join.fanoutIndex];
    const fanout = fanoutStep?.kind === "fanout" ? fanoutStep.fanout : undefined;
    if (fanout !== undefined) return fanout.branchIds;

    const branchIds: string[] = [];
    for (const tailIndex of join.branchTailIndices) {
        pushUniqueBranchId(branchIds, steps[tailIndex]?.branch?.branchId);
    }
    return branchIds;
}

/** Collect branch ids that have not yet errored for a given join. */
function survivorBranchIdsForJoin(
    steps: WorkflowStep[],
    join: WorkflowJoinMetadata,
): readonly string[] {
    const erroredBranchIds = new Set(join.erroredBranchIds ?? []);
    return branchIdsForJoin(steps, join).filter(
        (branchId) => !erroredBranchIds.has(branchId),
    );
}

/** Augment join metadata with survivor and errored branch info. */
function joinWithBranchStatus(
    steps: WorkflowStep[],
    join: WorkflowJoinMetadata,
): WorkflowJoinMetadata {
    const erroredBranchIds = [...new Set(join.erroredBranchIds ?? [])];
    return {
        ...join,
        survivorBranchIds: survivorBranchIdsForJoin(steps, join),
        ...(erroredBranchIds.length > 0 ? { erroredBranchIds } : {}),
    };
}

// --- join advance ---

/** Outcome of attempting to advance a join step. Returned by completeWorkflowJoinStep:
 *  - completed: join is satisfied and marked done; ready for downstream consumers.
 *  - dispatched: reducer/selector member just got dispatched; awaiting response.
 *  - waiting: reducer/selector already in flight (dispatchedAt set); still awaiting response.
 *  - failed: reducer could not be dispatched (no live session) -> run terminated.
 *  - noop: not a join step, or already completed -> nothing to do. */
type WorkflowJoinAdvanceResult =
    | "completed"
    | "dispatched"
    | "waiting"
    | "failed"
    | "noop";

/** Complete a join step: dispatch reducer if needed, mark completed, or return waiting. */
export async function completeWorkflowJoinStep(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    steps: WorkflowStep[],
    joinIndex: number,
): Promise<WorkflowJoinAdvanceResult> {
    const step = steps[joinIndex];
    if (step?.kind !== "join") return "noop";
    const join = step.join;
    if (join === undefined || step.completed)
        return "noop";

    const baseJoin = joinWithBranchStatus(steps, join);
    if (
        (baseJoin.joinPolicy === "reduce" || baseJoin.joinPolicy === "select") &&
        baseJoin.joinedOutput === undefined
    ) {
        step.join = baseJoin;
        if (step.dispatchedAt !== undefined) {
            // If the reducer member is no longer live (crashed, errored,
            // session deleted), clear the stale dispatchedAt to allow
            // re-dispatch. Without this, a crashed reducer permanently
            // deadlocks the join.
            const liveReducer = liveWorkflowActor(team, baseJoin.reducerMember, undefined)
            if (liveReducer === undefined) {
                step.dispatchedAt = undefined
                step.dispatchedActor = undefined
                step.correlationId = undefined
                // Fall through to re-dispatch below.
            } else {
                return "waiting"
            }
        }
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

// --- fanout error evaluation ---

/** Evaluate whether a fanout's error count exceeds its join tolerance policy. */
function evaluateWorkflowFanoutError(
    steps: WorkflowStep[],
    joinIndex: number,
): WorkflowFanoutErrorResult {
    const joinStep = steps[joinIndex];
    if (joinStep?.kind !== "join") return { kind: "not_fanout" };
    const join = joinStep.join;
    if (join === undefined)
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
    const impossible = joinPolicyImpossible(
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

/** Mark all non-completed steps in a branch as skipped. */
function markWorkflowBranchStepsSkipped(
    steps: WorkflowStep[],
    branch: WorkflowBranchMetadata,
): void {
    const fanoutStep = steps[branch.fanoutIndex];
    const fanout = fanoutStep?.kind === "fanout" ? fanoutStep.fanout : undefined;
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

/** Remove all active steps belonging to a branch from the task's active set. */
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

/** Find a branch already recorded as errored for a given member name. */
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
        const joinStep = steps[step.branch.joinIndex];
        const join = joinStep?.kind === "join" ? joinStep.join : undefined;
        if (join?.erroredBranchIds?.includes(step.branch.branchId) === true)
            return step.branch;
    }
    return null;
}

/** Mark a fanout branch as errored: skip its steps, update error sets, evaluate tolerance. */
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
    if (joinStep?.kind !== "join") return { kind: "not_fanout" };
    const join = joinStep.join;
    if (join === undefined)
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

/** Handle a dispatch failure: mark the branch errored or fail the run. */
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

/** Resolve the actor name from a workflow step for dispatch failure reporting. */
function dispatchFailureActorName(step: WorkflowStep): string | undefined {
    switch (step.kind) {
        case "task":
            return step.member;
        case "gate":
            // Ensemble gates have no single verifier; return the first
            // verifier name so the branch-errored path can attribute
            // the failure. Falls back to undefined (run-fail) only when
            // neither verifier nor verifiers is set.
            return step.verifier ?? step.verifiers?.[0];
        case "join":
            return step.join?.reducerMember;
        case "fanout":
            return undefined;
        default:
            throw assertNeverWorkflowStepKind(step);
    }
}

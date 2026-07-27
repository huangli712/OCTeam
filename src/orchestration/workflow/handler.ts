/**
 * Workflow idle handler. handleWorkflowIdle captures the idle member's current
 * turn, validates that the member belongs to the active frontier, and advances
 * only that matching step. Gate-verdict routing, INVALID / parse_failure
 * handling, and ensemble aggregation live in verdict.ts.
 */

import type { PluginContext } from "../../core/context.js";
import { logger } from "../../core/log.js";
import { type Team, saveTeamState } from "../../state/store.js";
import type {
    MemberState,
    WorkflowJoinStep,
    WorkflowStep,
    WorkflowTask,
    WorkflowTaskStep,
} from "../../core/types.js";
import {
    advanceWorkflowStep,
    describeStep,
    dispatchTaskStep,
    maybePauseAfterWorkflowStep,
} from "./engine.js";
import { workflowInvalidReason } from "./reasons.js";
import { finishRun } from "../control/completion.js";
import { recordEvent } from "../records/events.js";
import { truncateOutput } from "../protocol/output.js";
import {
    findActiveWorkflowStepIndexForMember,
    readyWorkflowStepIndices,
} from "./dag.js";
import { parseSelection } from "../protocol/decisions.js";
import { maybeRequestApproval } from "../control/approval.js";
import {
    branchIdsForJoin,
    buildBranchWorkflowOutput,
    handleWorkflowDispatchUnavailable,
} from "./fanout.js";
import { handleGateVerdict, resetStepAfterCompletion } from "./verdict.js";
import { resetWorkflowStepTiming } from "./engine.js";
import { assertNeverWorkflowStepKind } from "./dag.js";

/** Check whether a task step's output matches its retry_on condition. */
export function shouldRetryTask(step: WorkflowTaskStep, output: string): boolean {
    if (step.retryOn === undefined) return false;
    switch (step.retryOn.kind) {
        case "empty":
            return output.trim().length === 0;
        case "output_contains":
            return output.includes(step.retryOn.pattern);
        case "output_not_contains":
            return !output.includes(step.retryOn.pattern);
        case "regex":
            return testRegexSafely(step.retryOn.pattern, output);
        default:
            return false;
    }
}

/** Max input size passed to a retry_on regex. Reduced from 100KB to 10KB to
 * limit the worst-case wall time of a polynomial-time backtracking pattern
 * that slips through the nested-quantifier heuristic below. 10KB is still
 * far more than any legitimate output-content check needs. */
const REDOS_INPUT_CAP = 10_000

/** Max regex pattern length. A pattern longer than this is almost certainly
 * either a mistake or an attempt to overflow the regex compiler. */
const REDOS_PATTERN_MAX_LEN = 256

/**
 * Detect nested quantifiers — the canonical ReDoS signature. Patterns like
 * `(a+)+`, `(.+)*`, `([a-z]+){2,}` have exponential or polynomial backtracking
 * on adversarial input. The heuristic checks for a quantifier (`*`, `+`,
 * `?`, `{n,m}`) immediately following a group that itself ends with a
 * quantifier. False positives are possible but rare for legitimate patterns.
 */
function hasNestedQuantifier(pattern: string): boolean {
    // Strip escaped metacharacters so they do not confuse the heuristic.
    // (e.g. `\+` is a literal +, not a quantifier.)
    const stripped = pattern.replace(/\\[+*?{}()[\].\\]/g, "")
    // A group ending with a quantifier, followed by another quantifier.
    // Matches: (a+)+, (.+)*, ([a-z]+)?, (a{2,3})+, (a+){2}, etc.
    if (/\([^)]*[+*?}]\)[+*?{]/.test(stripped)) return true
    return false
}

/**
 * Test a retry_on regex pattern against an output string, with ReDoS guards:
 *   1. Reject patterns longer than REDOS_PATTERN_MAX_LEN.
 *   2. Reject patterns with nested quantifiers (the canonical ReDoS signature).
 *   3. Cap input at REDOS_INPUT_CAP (10KB) to bound worst-case wall time for
 *      polynomial-time patterns that slip through the heuristic.
 * Returns false (no-retry) on rejection, logging the reason so operators notice.
 */
function testRegexSafely(pattern: string, output: string): boolean {
    if (pattern.length > REDOS_PATTERN_MAX_LEN) {
        logger.warn("shouldRetryTask: regex pattern exceeds length cap, treating as no-retry", {
            patternLength: pattern.length, cap: REDOS_PATTERN_MAX_LEN,
        })
        return false
    }
    if (hasNestedQuantifier(pattern)) {
        logger.warn("shouldRetryTask: regex pattern contains nested quantifiers (ReDoS risk), treating as no-retry", {
            pattern,
        })
        return false
    }
    try {
        const cappedOutput = output.length > REDOS_INPUT_CAP ? output.slice(0, REDOS_INPUT_CAP) : output
        return new RegExp(pattern).test(cappedOutput)
    } catch (err) {
        logger.warn("shouldRetryTask: invalid regex pattern, treating as no-retry", {
            pattern,
            error: err instanceof Error ? err.message : String(err),
        })
        return false
    }
}

/**
 * Handle a task step's idle: retry_on auto-retry check, output capture,
 * approval_after pause, inter-step approval, then advance.
 */
async function handleTaskIdle(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
    task: WorkflowTask,
    steps: WorkflowStep[],
    step: WorkflowTaskStep,
    activeStepIndex: number,
): Promise<void> {
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
            const nudge = `[Auto-retry attempt ${step.taskAttempts}/${maxR}]`
                + ` Previous output triggered retry_on condition. Please try again.`;
            step.output = undefined;
            resetWorkflowStepTiming(step);
            step.correlationId = undefined;
            recordEvent(team, {
                timestamp: Date.now(),
                kind: "retry",
                member: member.name,
                stage: activeStepIndex,
                stepIndex: activeStepIndex,
                detail: `workflow task step ${activeStepIndex + 1}`
                    + ` auto-retry ${step.taskAttempts}/${maxR};`
                    + ` retry_on condition matched`,
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
        bytes: step.output !== undefined ? Buffer.byteLength(step.output, "utf8") : undefined,
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
            summary: `Completed ${describeStep(step, activeStepIndex)}.`
                + ` Next: ${describeStep(steps[nextIndex], nextIndex)}.`
                + ` Review before continuing.`,
        }))
    ) {
        return;
    }
    await advanceWorkflowStep(ctx, team);
}

/**
 * Handle a join step's idle: synthesize the joined output (select or reduce
 * policy), capture, then advance.
 */
async function handleJoinIdle(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
    task: WorkflowTask,
    steps: WorkflowStep[],
    step: WorkflowJoinStep,
    activeStepIndex: number,
): Promise<void> {
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
        bytes: step.join?.joinedOutput !== undefined ? Buffer.byteLength(step.join.joinedOutput, "utf8") : undefined,
        detail: `workflow ${joinPolicy} join step ${activeStepIndex + 1} captured`,
    });
    await advanceWorkflowStep(ctx, team);
}

/** Capture idle member output, validate step membership, and route to task/gate/join completion. */
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

    switch (step.kind) {
        case "task":
            return await handleTaskIdle(ctx, team, member, task, steps, step, activeStepIndex);
        case "join":
            return await handleJoinIdle(ctx, team, member, task, steps, step, activeStepIndex);
        case "gate":
            return await handleGateVerdict(ctx, team, member, step, activeStepIndex);
        case "fanout":
            // Fanout steps have no actor and are auto-completed by advanceWorkflowStep.
            // Reaching here is unexpected but harmless — no-op.
            return;
        default:
            assertNeverWorkflowStepKind(step);
    }
}

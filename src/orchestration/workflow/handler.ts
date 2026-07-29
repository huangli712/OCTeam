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
    maybePauseBeforeWorkflowStep,
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
    const stripped = pattern.replace(/\\[+*?{}()[\].\\|]/g, "")
    // A group ending with a quantifier, followed by another quantifier.
    // Matches: (a+)+, (.+)*, ([a-z]+)?, (a{2,3})+, (a+){2}, etc.
    if (/\([^)]*[+*?}]\)[+*?{]/.test(stripped)) return true
    // C-18: consecutive identical-quantified items at top level. Patterns
    // like ^a*a*a*a*a*a*a*a*b$ have NO groups or alternation, so the checks
    // above miss them, yet V8 exhibits polynomial backtracking when the
    // trailing literal (b) does not match: the engine tries every way to
    // distribute the input characters among the consecutive quantified items.
    // Heuristic: flag 3+ consecutive `X*`/`X+` items where X is the same
    // character (the case that actually backtracks). Different chars
    // (a*b*c*) are fine — each greedily matches its own character.
    if (/([a-zA-Z0-9])([*+])(?:\1\2){2,}/.test(stripped)) return true
    // Also catch the character-class variant: [a][a][a]+ or similar via
    // repeated single-char classes under quantifiers — rare but possible.
    // Skip: too rare and complex for a heuristic; the input cap mitigates.
    // C-6: alternation-overlap under quantifier. Patterns like (a|aa)+$,
    // (a|ab)+ have exponential backtracking when two alternation branches
    // share a string-prefix overlap (one is a prefix of the other). For each
    // group `(...)` followed by a quantifier that contains `|`, check pairwise
    // prefix-overlap among the literal branches. Branches with nested groups /
    // quantifiers are skipped (the prefix check is unreliable on them, and the
    // nested-quantifier check above handles them).
    //
    // Real attack: (a|aa)+$ on 45 a's + X blocked ~500ms with V8's backtracking
    // engine before this guard was added.
    let i = 0
    while (i < stripped.length) {
        if (stripped[i] !== "(") { i++; continue }
        // Find matching close paren (depth-aware).
        let depth = 1, j = i + 1
        while (j < stripped.length && depth > 0) {
            if (stripped[j] === "(") depth++
            else if (stripped[j] === ")") depth--
            j++
        }
        if (depth !== 0) break
        const body = stripped.slice(i + 1, j - 1)
        const nextChar = stripped[j]
        if (nextChar !== undefined && "+*?{".includes(nextChar) && body.includes("|")) {
            const branches = body.split("|").filter(b => b.length > 0)
            // H3: branches containing quantifiers/group metacharacters under
            // an outer quantifier are inherently susceptible to exponential
            // backtracking (e.g. (a|a*a)+$). Pre-fix code filtered these
            // branches out for the prefix-overlap check but did not flag
            // them as risky. A branch like `a*a` under `(...)+` can silently
            // bypass both the nested-quantifier heuristic (the group ends with
            // `a`, not a quantifier) and the overlap check (the branch is
            // excluded). Now, any branch with quantifier metacharacters
            // inside an alternation under a quantifier is a red flag.
            const simpleBranches = branches.filter(b => !/[][{}()*+?]/.test(b))
            if (simpleBranches.length < branches.length) return true
            for (let a = 0; a < simpleBranches.length; a++) {
                for (let b = a + 1; b < simpleBranches.length; b++) {
                    if (
                        simpleBranches[a].startsWith(simpleBranches[b])
                        || simpleBranches[b].startsWith(simpleBranches[a])
                    ) {
                        return true
                    }
                }
            }
        }
        i = j
    }
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
            // K-1: re-request approval_before on retry re-dispatch. Pre-fix
            // code called dispatchTaskStep directly, bypassing the approval
            // gate (engine.ts:131 clears approvalBeforeGranted so the next
            // dispatch would re-request it, but dispatchTaskStep itself never
            // calls maybePauseBeforeWorkflowStep). This contradicted the
            // engine.ts:131 comment "retry/goto re-requests approval".
            if (step.approvalBefore && !step.approvalBeforeGranted) {
                if (await maybePauseBeforeWorkflowStep(ctx, team, activeStepIndex)) {
                    return; // paused for approval
                }
            }
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
        // H-W2: reject selection of errored branches. The selector prompt
        // lists all branch IDs, but a branch that errored should not be
        // selectable as the final result. Pre-fix code validated only that
        // the winner was a known branch ID, not that it was a survivor.
        const erroredBranchIds = new Set(join.erroredBranchIds ?? []);
        if (selection.parseFailed || !branchIds.includes(selection.winner) || erroredBranchIds.has(selection.winner)) {
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
    capturedNew?: boolean,
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

    // H-8: stale idle guard for task AND gate actor steps.
    //
    // task step: skip when capturedNew is false AND step.output is already
    // set — re-reading consumed output would double-complete. We do NOT skip
    // when step.output is unset because retry_on='empty' relies on processing
    // a turn that produced no assistant content (capturedNew=false but the
    // turn genuinely fired). The empty-output retry path is exercised by the
    // workflow-task-retry suite.
    //
    // gate step (H-8 regression extension): skip when capturedNew is false
    // AND step.output is already set — ensemble gates accumulate verifier
    // outputs into step.output, and a stale idle from a later verifier could
    // reuse the prior verifier's output, double-counting the verdict. Gate
    // attempt counters protect against double-processing of the same response
    // but do not protect against an empty-response stale idle routing to
    // on_malformed/parse_failure.
    //
    // join step (H49): skip when capturedNew is false — a stale reducer idle
    // would read task.responses[member.name] ?? "" and complete the join with
    // an empty string, producing a fake reduced result. Unlike task/gate,
    // join has no retry_on='empty' path — a reducer that produced no output
    // has nothing to reduce.
    if (capturedNew === false) {
        // H-W1/H49: stale idle (no new output) guard.
        // task: skip when output already set (double-complete). Do NOT skip
        // when output is undefined — retry_on='empty' relies on processing
        // a turn that produced no extractable text (capturedNew=false but
        // the turn genuinely fired).
        // gate: skip when output already set (double-count ensemble verdict).
        // join: always skip (no retry_on='empty' path for reducers).
        if ((step.kind === "task" || step.kind === "gate") && step.output !== undefined) {
            // K-3: for ENSEMBLE gates, the first verifier sets step.output,
            // so the guard would wrongly skip subsequent verifiers whose
            // empty responses still need to be recorded in ensembleResults.
            // Only skip if THIS verifier has already contributed.
            if (step.kind === "gate" && step.verifiers !== undefined) {
                if (step.ensembleResults?.[member.name] !== undefined) {
                    return // already recorded
                }
                // Fall through — this verifier hasn't contributed yet, even
                // with empty output. handleGateVerdict will record a
                // parse_failure so ensemble aggregation can complete.
            } else {
                return;
            }
        }
        if (step.kind === "join") {
            return;
        }
    }

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

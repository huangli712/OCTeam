/**
 * Workflow gate helpers: verifier prompt construction, gate target resolution,
 * goto index resolution, ensemble verdict aggregation, and condition matching.
 *
 * Extracted from workflow.ts + conditions.ts. All functions are pure (no side
 * effects, no workflow state mutation) so they can be unit-tested independently.
 */

import type {
    Verdict,
    WorkflowCondition,
    WorkflowIssue,
    WorkflowIssueSeverity,
    WorkflowStep,
} from "../../core/types.js";
import { isWorkflowIssueSeverity } from "../protocol/decisions.js";
import { truncateOutput } from "../protocol/output.js";
import { isSameWorkflowBranch } from "./dag.js";

/** Structured jump context produced by a gate's goto evaluation. */
export type WorkflowJumpTransition = {
    reason: string;
    verdict?: Verdict;
    rationale?: string;
    diff?: string;
};

/** Input values for evaluating a where condition: score, confidence, and issues from the verdict. */
type ConditionInput = {
    score?: number
    confidence?: number
    issues?: WorkflowIssue[]
}

/** Result of parsing a raw where object: either a typed condition or an error message. */
type ParsedCondition =
    | { condition: WorkflowCondition }
    | { error: string }

// --- verifier prompt construction ---

/**
 * Build the verifier's dispatch prompt: the preceding task's output, the
 * criteria, and the exact <verdict> block the verifier must emit.
 */
export function buildGateVerifierPrompt(
    step: WorkflowStep,
    producerOutput: string,
    targetLabel: string,
    targetCount: number,
): string {
    const structuredHint = buildStructuredVerdictHint(step.where);
    const aggregationHint = targetCount > 1
        ? `This gate verifies an aggregate of multiple target outputs. ` +
            `Emit one verdict for the complete target set; PASS only when every target ` +
            `satisfies the criteria and the targets are mutually consistent.`
        : "";
    return (
        `[Verification gate]\n` +
        `Verify ${targetLabel} output below against the criteria.\n` +
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
 * `<verdict>` JSON example.
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
                "issues: an array of { severity: low|medium|high|critical, " +
                    "message?: string } for every issue you found, ordered by severity",
            );
            break;
        default:
            throw new Error(`unhandled workflow condition: ${String(where)}`);
    }
    return (
        `This gate gates a downstream step on a threshold condition (${formatWorkflowCondition(where)}). ` +
        `Also emit structured fields so the condition can be evaluated:\n- ${fields.join("\n- ")}`
    );
}

/** Build a JSON example of a <verdict> block including optional condition fields. */
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
            throw new Error(`unhandled workflow condition: ${String(where)}`);
    }
    return `{${base},${extras.join(",")}}`;
}

// --- gate target resolution ---

/**
 * Find the nearest preceding TASK step index for a gate. Returns -1 when none.
 */
/** Scan backward from gateIndex for the nearest preceding task step. */
export function precedingTaskIndex(steps: WorkflowStep[], gateIndex: number): number {
    for (let i = gateIndex - 1; i >= 0; i--) {
        if (canGateReferenceTask(steps, gateIndex, i)) return i;
    }
    return -1;
}

/** Return the single target task index for a gate (first of multi-target if present). */
export function gateTargetIndex(steps: WorkflowStep[], gateIndex: number): number {
    const targets = gateTargetIndices(steps, gateIndex);
    return targets[0] ?? -1;
}

/** Return all target task indices a gate verifies (explicit or inferred). */
export function gateTargetIndices(steps: WorkflowStep[], gateIndex: number): number[] {
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

/** Check whether a gate can reference a given task or join step (same-branch check). */
function canGateReferenceTask(
    steps: WorkflowStep[],
    gateIndex: number,
    targetIndex: number,
): boolean {
    const gate = steps[gateIndex];
    const target = steps[targetIndex];
    if (gate?.kind !== "gate") return false;
    // join is always top-level (no branch) and carries joinedOutput; allow it.
    if (target?.kind === "join") return true;
    if (target?.kind !== "task") return false;

    const gateBranch = gate.branch;
    if (gateBranch === undefined) return target.branch === undefined;
    return isSameWorkflowBranch(target, gateBranch);
}

// --- labels ---

/** Format a list of 1-based step indices into a human label like "step 3" or "steps 1, 2, 4". */
export function stepIndicesLabel(indices: number[]): string {
    if (indices.length === 0) return "nearest task";
    const labels = indices.map((index) => String(index + 1));
    const first = labels[0];
    if (first === undefined) return "nearest task";
    return labels.length === 1 ? `step ${first}` : `steps ${labels.join(", ")}`;
}

/** Build a human target label prefixed with "workflow" for verifier prompts. */
export function workflowTargetLabel(indices: number[]): string {
    return `workflow ${stepIndicesLabel(indices)}`;
}

/** Concatenate truncated outputs of all target producer steps for a gate. */
export function buildGateProducerOutput(
    steps: WorkflowStep[],
    targetIndices: number[],
): string {
    const blocks: string[] = [];
    for (const targetIndex of targetIndices) {
        const producerStep = steps[targetIndex];
        if (!producerStep) continue;
        if (producerStep.kind === "task") {
            blocks.push(
                `[Step ${targetIndex + 1} output from ${producerStep.member ?? "?"}]\n` +
                    `${truncateOutput(producerStep.output ?? "")}`,
            );
        } else if (producerStep.kind === "join") {
            const joined = producerStep.join?.joinedOutput ?? "";
            if (joined) {
                blocks.push(
                    `[Joined output from workflow step ${targetIndex + 1}]\n` +
                        `${truncateOutput(joined)}`,
                );
            }
        }
    }
    return blocks.join("\n\n");
}

// --- goto resolution ---

/** Build a prefixed jump context string for re-dispatch prompts. */
export function buildJumpContext(transition: WorkflowJumpTransition): string {
    const lines = [`[Workflow jump: ${transition.reason}]`];
    if (transition.verdict !== undefined)
        lines.push(`Verdict: ${transition.verdict}`);
    if (transition.rationale !== undefined)
        lines.push(`Rationale: ${transition.rationale}`);
    if (transition.diff !== undefined) lines.push(`Diff: ${transition.diff}`);
    return lines.join("\n");
}

/** Resolve a goto target index, valid only when the gate's where condition matches. */
export function gatedGotoIndex(
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

/** Check whether a gate can jump/goto a given step (same-branch or no branch). */
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

/** Describe the jump reason prefixed with the where condition kind, or fallback. */
export function whereReason(step: WorkflowStep, fallback: string): string {
    return step.where === undefined ? fallback : `when:${step.where.kind}`;
}

// --- ensemble verdict aggregation ---

/** Build an ensemble aggregation result with the given verdict and rationale. */
function ensembleResult(verdict: Verdict, rationale: string): {
    verdict: Verdict
    parseFailed: boolean
    rationale: string
    diff: string
} {
    return { verdict, parseFailed: false, rationale, diff: "" }
}

/**
 * Aggregate per-verifier results into a single verdict using the ensemble policy.
 */
export function aggregateEnsembleVerdict(step: WorkflowStep): {
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
    const verdicts = results.map(r => r.verdict).filter((v): v is Verdict => v !== undefined);
    const passCount = verdicts.filter(v => v === "PASS").length;
    const failCount = verdicts.filter(v => v === "FAIL").length;
    const invalidCount = verdicts.filter(v => v === "INVALID").length;
    const total = verdicts.length;
    switch (step.ensemblePolicy) {
        case "majority":
            if (passCount > total / 2) return ensembleResult("PASS", `Majority PASS (${passCount}/${total})`);
            if (failCount > total / 2) return ensembleResult("FAIL", `Majority FAIL (${failCount}/${total})`);
            return ensembleResult("INVALID", `No majority (${passCount}P/${failCount}F/${invalidCount}I)`);
        case "quorum": {
            const threshold = step.ensembleQuorum ?? 0.5;
            if (passCount / total >= threshold) return ensembleResult("PASS", `Quorum PASS (${passCount}/${total} >= ${threshold})`);
            if (failCount / total >= threshold) return ensembleResult("FAIL", `Quorum FAIL (${failCount}/${total} >= ${threshold})`);
            return ensembleResult("INVALID", `No quorum (${passCount}P/${failCount}F/${invalidCount}I)`);
        }
        case "unanimous":
            if (passCount === total) return ensembleResult("PASS", `Unanimous PASS (${passCount}/${total})`);
            if (failCount === total) return ensembleResult("FAIL", `Unanimous FAIL (${failCount}/${total})`);
            return ensembleResult("INVALID", `Not unanimous (${passCount}P/${failCount}F/${invalidCount}I)`);
        default:
            return ensembleResult("INVALID", `Unknown ensemble policy`);
    }
}

// --- condition matching (merged from conditions.ts) ---

/** Map a severity string to its numeric rank for comparison. */
function severityRank(severity: WorkflowIssueSeverity): number {
    switch (severity) {
        case "low": return 0
        case "medium": return 1
        case "high": return 2
        case "critical": return 3
        default: return assertNeverCondition(severity)
    }
}

/** Type guard: check if a string is a valid WorkflowCondition kind. */
function isConditionKey(key: string): key is WorkflowCondition["kind"] {
    return key === "score_gte" || key === "score_lt" || key === "confidence_gte" || key === "has_issue_severity"
}

/** Type guard: check if a value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parse a where condition object into a typed WorkflowCondition. */
export function parseWorkflowCondition(raw: unknown): ParsedCondition {
    if (!isRecord(raw)) return { error: "where must be an object" }
    const conditionKeys = Object.keys(raw).filter(isConditionKey)
    if (conditionKeys.length !== 1 || Object.keys(raw).some(key => key !== conditionKeys[0])) {
        return { error: "where must contain exactly one supported condition" }
    }
    const key = conditionKeys[0]
    if (key === undefined) return { error: "where must contain exactly one supported condition" }
    const value = raw[key]
    switch (key) {
        case "score_gte":
        case "score_lt":
        case "confidence_gte":
            return typeof value === "number" && Number.isFinite(value)
                ? { condition: { kind: key, value } }
                : { error: `where.${key} must be a finite number` }
        case "has_issue_severity":
            return isWorkflowIssueSeverity(value)
                ? { condition: { kind: key, value } }
                : { error: "where.has_issue_severity must be one of low, medium, high, critical" }
        default:
            return assertNeverCondition(key)
    }
}

/** Evaluate whether a WorkflowCondition holds for the given input values. */
export function matchesWorkflowCondition(condition: WorkflowCondition, input: ConditionInput): boolean {
    switch (condition.kind) {
        case "score_gte": return input.score !== undefined && input.score >= condition.value
        case "score_lt": return input.score !== undefined && input.score < condition.value
        case "confidence_gte": return input.confidence !== undefined && input.confidence >= condition.value
        case "has_issue_severity":
            return (input.issues ?? []).some(issue => severityRank(issue.severity) >= severityRank(condition.value))
        default:
            return assertNeverCondition(condition)
    }
}

/** Format a WorkflowCondition as a human-readable string. */
export function formatWorkflowCondition(condition: WorkflowCondition): string {
    return `${condition.kind} ${condition.value}`
}

/** Exhaustive check helper that throws for unhandled severity or condition kinds. */
function assertNeverCondition(value: never): never {
    throw new Error(`unhandled workflow value: ${String(value)}`)
}

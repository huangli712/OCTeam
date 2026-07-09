/**
 * Workflow gate helpers: verifier prompt construction, gate target resolution,
 * goto index resolution, and ensemble verdict aggregation.
 *
 * Extracted from workflow.ts. All functions are pure (no side effects, no
 * workflow state mutation) so they can be unit-tested independently.
 */

import type {
    Verdict,
    WorkflowCondition,
    WorkflowStep,
} from "../core/types.js";
import { truncateOutput } from "./output.js";
import {
    formatWorkflowCondition,
    matchesWorkflowCondition,
} from "./conditions.js";
import { isSameWorkflowBranch } from "./dag.js";

export type WorkflowJumpTransition = {
    reason: string;
    verdict?: Verdict;
    rationale?: string;
    diff?: string;
};

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
                "issues: an array of { severity: low|medium|high|critical, message?: string } for every issue you found, ordered by severity",
            );
            break;
        default:
            throw new Error(`unhandled workflow condition: ${String(where)}`);
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
            throw new Error(`unhandled workflow condition: ${String(where)}`);
    }
    return `{${base},${extras.join(",")}}`;
}

// --- gate target resolution ---

/**
 * Find the nearest preceding TASK step index for a gate. Returns -1 when none.
 */
export function precedingTaskIndex(steps: WorkflowStep[], gateIndex: number): number {
    for (let i = gateIndex - 1; i >= 0; i--) {
        if (canGateReferenceTask(steps, gateIndex, i)) return i;
    }
    return -1;
}

export function gateTargetIndex(steps: WorkflowStep[], gateIndex: number): number {
    const targets = gateTargetIndices(steps, gateIndex);
    return targets[0] ?? -1;
}

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

// --- labels ---

export function stepIndicesLabel(indices: number[]): string {
    if (indices.length === 0) return "nearest task";
    const labels = indices.map((index) => String(index + 1));
    const first = labels[0];
    if (first === undefined) return "nearest task";
    return labels.length === 1 ? `step ${first}` : `steps ${labels.join(", ")}`;
}

export function workflowTargetLabel(indices: number[]): string {
    return `workflow ${stepIndicesLabel(indices)}`;
}

export function buildGateProducerOutput(
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

// --- goto resolution ---

export function buildJumpContext(transition: WorkflowJumpTransition): string {
    const lines = [`[Workflow jump: ${transition.reason}]`];
    if (transition.verdict !== undefined)
        lines.push(`Verdict: ${transition.verdict}`);
    if (transition.rationale !== undefined)
        lines.push(`Rationale: ${transition.rationale}`);
    if (transition.diff !== undefined) lines.push(`Diff: ${transition.diff}`);
    return lines.join("\n");
}

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

export function whereReason(step: WorkflowStep, fallback: string): string {
    return step.where === undefined ? fallback : `when:${step.where.kind}`;
}

// --- ensemble verdict aggregation ---

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

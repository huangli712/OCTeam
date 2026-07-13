/**
 * Workflow step ledger formatting: renders the 1-based per-step ledger and
 * the task/join output sections for a workflow run's summary.
 *
 * Extracted from summary.ts. All functions are pure formatting helpers —
 * they read WorkflowStep data and produce strings, with no side effects.
 */

import type { WorkflowStep } from "../../core/types.js";
import { truncateOutput } from "../protocol/output.js";

/** Per-issue detail lines for a gate step with structured verdict. Severity-sorted
 * (critical > high > medium > low) so the most actionable issues surface first. */
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

function hasWorkflowBranchTree(steps: readonly WorkflowStep[]): boolean {
    return steps.some(step => step.kind === "fanout" || step.kind === "join" || step.branch !== undefined)
}

/** Render the target step label for a gate step (e.g. "step 3" or "nearest task"). */
export function workflowTargetLabel(s: WorkflowStep): string {
    if (s.targetStepIndices !== undefined && s.targetStepIndices.length > 0) {
        const targets = s.targetStepIndices.map(index => index + 1)
        return targets.length === 1 ? `step ${targets[0]}` : `steps ${targets.join(", ")}`
    }
    return s.targetStepIndex === undefined ? "nearest task" : `step ${s.targetStepIndex + 1}`
}

/** Render verdict metrics (score, confidence, issue count) as a bracketed string. */
export function workflowVerdictMetrics(s: WorkflowStep): string {
    const metrics: string[] = []
    if (s.score !== undefined) metrics.push(`score=${s.score}`)
    if (s.confidence !== undefined) metrics.push(`confidence=${s.confidence}`)
    if (s.issues !== undefined && s.issues.length > 0) metrics.push(`issues=${s.issues.length}`)
    return metrics.length > 0 ? ` [${metrics.join(", ")}]` : ""
}

/** Classify a fanout branch status: completed, skipped, errored, or pending. */
export function workflowBranchStatus(steps: readonly WorkflowStep[], fanoutStep: WorkflowStep, branchId: string, branchIndex: number): string {
    const fanout = fanoutStep.fanout
    if (fanout === undefined) throw new Error("workflow fanout step missing fanout metadata")
    const range = fanout.branchRanges[branchIndex]
    if (range === undefined) throw new Error(`workflow fanout missing branch range ${branchIndex}`)
    const join = steps[fanout.joinIndex]?.join
    if (join?.erroredBranchIds?.includes(branchId) === true) return "errored"
    if (join?.survivorBranchIds?.includes(branchId) === true) return "completed"
    const tail = steps[range.endIndex]
    if (tail?.skipped === true) return "skipped"
    return tail?.completed === true ? "completed" : "pending"
}

function workflowBranchStatusList(steps: readonly WorkflowStep[], fanoutStep: WorkflowStep): string {
    const fanout = fanoutStep.fanout
    if (fanout === undefined) throw new Error("workflow fanout step missing fanout metadata")
    return fanout.branchIds
        .map((branchId, branchIndex) => `${branchId}:${workflowBranchStatus(steps, fanoutStep, branchId, branchIndex)}`)
        .join(", ")
}

/** Format the per-issue detail lines for a gate step's structured verdict, severity-sorted. */
export function formatWorkflowIssueDetail(s: WorkflowStep): string {
    const issues = s.issues
    if (!issues || issues.length === 0) return ""
    const sorted = [...issues].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99))
    const lines = sorted.map(issue => {
        const msg = issue.message && issue.message.trim() !== "" ? `: ${issue.message}` : ""
        return `    - [${issue.severity}]${msg}`
    })
    return "\n" + lines.join("\n")
}

function formatWorkflowBranchLine(steps: readonly WorkflowStep[], fanoutStep: WorkflowStep, branchId: string, branchIndex: number): string {
    const fanout = fanoutStep.fanout
    if (fanout === undefined) throw new Error("workflow fanout step missing fanout metadata")
    const range = fanout.branchRanges[branchIndex]
    if (range === undefined) throw new Error(`workflow fanout missing branch range ${branchIndex}`)
    const status = workflowBranchStatus(steps, fanoutStep, branchId, branchIndex)
    return `  - Branch ${branchId} [${status}] steps ${range.startIndex + 1}-${range.endIndex + 1}`
}

/** Format a single workflow step as a 1-based ledger line (task/gate/fanout/join). */
export function formatWorkflowLedgerStep(steps: readonly WorkflowStep[], step: WorkflowStep, index: number): string {
    const idTag = step.id ? ` (${step.id})` : ""
    switch (step.kind) {
        case "task": {
            const state = step.skipped ? " (skipped)" : step.completed ? " (done)" : ""
            return `${index + 1}. [task]${idTag} ${step.member ?? "?"}${state}`
        }
        case "gate": {
            const target = workflowTargetLabel(step)
            const invalidTag = step.onInvalid && step.onInvalid !== "fail" ? `, on_invalid=${step.onInvalid}${(step.invalidAttempts ?? 0) > 0 ? ` (${step.invalidAttempts})` : ""}` : ""
            const jumpTag = (step.jumpCount ?? 0) > 0 ? `, jumps=${step.jumpCount}` : ""
            return `${index + 1}. [gate]${idTag} ${step.verifier ?? "?"} verifies ${target} -> ${step.verdict ?? "pending"}${workflowVerdictMetrics(step)}${(step.attempts ?? 0) > 0 ? ` (${step.attempts} retries)` : ""}${invalidTag}${jumpTag}${formatWorkflowIssueDetail(step)}`
        }
        case "fanout": {
            const fanout = step.fanout
            if (fanout === undefined) throw new Error(`workflow fanout step ${index + 1} missing fanout metadata`)
            const branchList = fanout.branchIds.length > 0 ? fanout.branchIds.join(", ") : "(none)"
            return `${index + 1}. [fanout]${idTag} branches ${branchList} -> join step ${fanout.joinIndex + 1}`
        }
        case "join": {
            const join = step.join
            if (join === undefined) throw new Error(`workflow join step ${index + 1} missing join metadata`)
            const fanoutStep = steps[join.fanoutIndex]
            const statuses = fanoutStep?.kind === "fanout" ? workflowBranchStatusList(steps, fanoutStep) : ""
            const statusTag = statuses === "" ? "" : ` branches ${statuses}`
            const joinedBytes = join.joinedOutput === undefined ? "" : ` (joined ${Buffer.byteLength(join.joinedOutput, "utf8")} bytes)`
            return `${index + 1}. [join]${idTag} fanout step ${join.fanoutIndex + 1}${statusTag}${joinedBytes}`
        }
        default:
            throw new Error(`unhandled WorkflowStepKind: ${String(step.kind)}`)
    }
}

/** Render the full per-step workflow ledger, including branch sub-trees under fanout markers. */
export function formatWorkflowLedgerLines(steps: readonly WorkflowStep[]): string[] {
    if (!hasWorkflowBranchTree(steps)) return steps.map((step, index) => formatWorkflowLedgerStep(steps, step, index))

    const lines: string[] = []
    const rendered = new Set<number>()
    for (let index = 0; index < steps.length; index += 1) {
        if (rendered.has(index)) continue
        const step = steps[index]
        if (step === undefined) continue
        switch (step.kind) {
            case "fanout": {
                lines.push(formatWorkflowLedgerStep(steps, step, index))
                const fanout = step.fanout
                if (fanout === undefined) throw new Error(`workflow fanout step ${index + 1} missing fanout metadata`)
                for (let branchIndex = 0; branchIndex < fanout.branchIds.length; branchIndex += 1) {
                    const branchId = fanout.branchIds[branchIndex]
                    const range = fanout.branchRanges[branchIndex]
                    if (branchId === undefined || range === undefined) continue
                    lines.push(formatWorkflowBranchLine(steps, step, branchId, branchIndex))
                    for (let branchStepIndex = range.startIndex; branchStepIndex <= range.endIndex; branchStepIndex += 1) {
                        const branchStep = steps[branchStepIndex]
                        if (branchStep === undefined) continue
                        lines.push(`    ${formatWorkflowLedgerStep(steps, branchStep, branchStepIndex)}`)
                        rendered.add(branchStepIndex)
                    }
                }
                break
            }
            case "task":
            case "gate":
            case "join":
                lines.push(formatWorkflowLedgerStep(steps, step, index))
                break
            default:
                throw new Error(`unhandled WorkflowStepKind: ${String(step.kind)}`)
        }
    }
    return lines
}

function formatWorkflowTaskOutput(step: WorkflowStep, index: number, headingLevel: "###" | "####"): string | null {
    if (step.kind !== "task" || !step.completed) return null
    return `${headingLevel} Step ${index + 1} - ${step.member ?? "?"}\n${truncateOutput(step.output ?? "")}`
}

/** Render completed task-step outputs as a list of sections, with fanout branches grouped under headers. */
export function formatWorkflowOutputSections(steps: readonly WorkflowStep[]): string[] {
    if (!hasWorkflowBranchTree(steps)) {
        return steps
            .map((step, index) => formatWorkflowTaskOutput(step, index, "###"))
            .filter((x): x is string => x !== null)
    }

    const sections: string[] = []
    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]
        if (step === undefined) continue
        switch (step.kind) {
            case "task": {
                if (step.branch !== undefined) break
                const output = formatWorkflowTaskOutput(step, index, "###")
                if (output !== null) sections.push(output)
                break
            }
            case "fanout": {
                const fanout = step.fanout
                if (fanout === undefined) throw new Error(`workflow fanout step ${index + 1} missing fanout metadata`)
                for (let branchIndex = 0; branchIndex < fanout.branchIds.length; branchIndex += 1) {
                    const branchId = fanout.branchIds[branchIndex]
                    const range = fanout.branchRanges[branchIndex]
                    if (branchId === undefined || range === undefined) continue
                    const outputs: string[] = []
                    for (let branchStepIndex = range.startIndex; branchStepIndex <= range.endIndex; branchStepIndex += 1) {
                        const branchStep = steps[branchStepIndex]
                        if (branchStep === undefined) continue
                        const output = formatWorkflowTaskOutput(branchStep, branchStepIndex, "####")
                        if (output !== null) outputs.push(output)
                    }
                    if (outputs.length > 0) {
                        const status = workflowBranchStatus(steps, step, branchId, branchIndex)
                        sections.push(`### Fanout Step ${index + 1} Branch ${branchId} [${status}]\n${outputs.join("\n\n")}`)
                    }
                }
                break
            }
            case "join": {
                const joinedOutput = step.join?.joinedOutput
                if (joinedOutput !== undefined) sections.push(`### Join Step ${index + 1}\n${truncateOutput(joinedOutput)}`)
                break
            }
            case "gate":
                break
            default:
                throw new Error(`unhandled WorkflowStepKind: ${String(step.kind)}`)
        }
    }
    return sections
}

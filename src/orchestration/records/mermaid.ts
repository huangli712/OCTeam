/**
 * Mermaid flowchart renderer for workflow run steps: produces a flowchart TD
 * diagram with subgraphs for fanout branches and styled status nodes.
 */

import type { WorkflowRunStep } from "../../core/types.js"

/** Visual status classification for a workflow step node in a Mermaid diagram. */
export type MermaidStepStatus = "done" | "active" | "pending" | "skipped"

/** Mermaid status rendering order (determines classDef emission sequence). */
const STATUS_ORDER = ["done", "active", "pending", "skipped"] as const

/** Mermaid classDef CSS strings per visual status. */
const STATUS_CLASS_DEFS: Record<MermaidStepStatus, string> = {
    done: "classDef done fill:#d4edda,stroke:#28a745;",
    active: "classDef active fill:#fff3cd,stroke:#f0ad4e;",
    pending: "classDef pending fill:#f8f9fa,stroke:#adb5bd;",
    skipped: "classDef skipped fill:#e9ecef,stroke:#adb5bd,stroke-dasharray:3;",
}

/** Build a deterministic Mermaid node id from a step (s<step_number>). */
function mermaidNodeId(step: WorkflowRunStep): string {
    return `s${step.step}`
}

/** Sanitize a branch id for use in Mermaid subgraph names. */
function mermaidSafeId(value: string): string {
    return value.replace(/[^A-Za-z0-9_]/g, "_") || "branch"
}

/** Escape a string for safe embedding inside Mermaid double-quoted labels. */
function mermaidLabel(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "'")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/[\r\n]+/g, " ")
}

/** Build the human-readable label for a single workflow step node. */
function mermaidStepLabel(step: WorkflowRunStep): string {
    const idTag = step.id ? ` (${step.id})` : ""
    switch (step.kind) {
        case "task":
            return `${step.step}. task${idTag}: ${step.dispatchedActor ?? step.member ?? "?"}`
        case "gate":
            return `${step.step}. gate${idTag}: ${step.dispatchedActor ?? step.verifier ?? "?"}`
        case "fanout":
            return `${step.step}. fanout${idTag}`
        case "join": {
            const selected = step.join?.selectedBranchId === undefined ? "" : ` selected ${step.join.selectedBranchId}`
            return `${step.step}. join${idTag}${selected}`
        }
        default:
            return `${step.step}. [unknown step kind: ${String(step.kind)}]`
    }
}

/** Append a Mermaid node line (id["label"]) at the given indent. */
function appendMermaidNode(lines: string[], step: WorkflowRunStep, indent: string): void {
    lines.push(`${indent}${mermaidNodeId(step)}["${mermaidLabel(mermaidStepLabel(step))}"]`)
}

/** Emit classDef + class assignment lines for steps that have a known status. */
function appendMermaidStatusClasses(
    lines: string[],
    steps: readonly WorkflowRunStep[],
    statusByIndex: ReadonlyMap<number, MermaidStepStatus> | undefined,
): void {
    if (statusByIndex === undefined || statusByIndex.size === 0) return

    const nodesByStatus = new Map<MermaidStepStatus, string[]>()
    for (const step of steps) {
        const status = statusByIndex.get(step.index)
        if (status === undefined) continue
        const nodes = nodesByStatus.get(status) ?? []
        nodes.push(mermaidNodeId(step))
        nodesByStatus.set(status, nodes)
    }

    for (const status of STATUS_ORDER) {
        if (nodesByStatus.has(status)) lines.push(`  ${STATUS_CLASS_DEFS[status]}`)
    }
    for (const status of STATUS_ORDER) {
        const nodes = nodesByStatus.get(status)
        if (nodes !== undefined && nodes.length > 0) {
            lines.push(`  class ${nodes.join(",")} ${status};`)
        }
    }
}

/** Render workflow run steps as a Mermaid flowchart TD string with optional status styling. */
export function formatWorkflowMermaid(
    steps: readonly WorkflowRunStep[],
    statusByIndex?: ReadonlyMap<number, MermaidStepStatus>,
): string {
    const lines = ["flowchart TD"]
    const grouped = new Set<number>()
    for (const step of steps) {
        if (step.kind !== "fanout" || step.fanout === undefined) continue
        lines.push(`  subgraph fanout_${step.step}["fanout step ${step.step}"]`)
        for (let branchIndex = 0; branchIndex < step.fanout.branchIds.length; branchIndex += 1) {
            const branchId = step.fanout.branchIds[branchIndex]
            const range = step.fanout.branchRanges[branchIndex]
            if (branchId === undefined || range === undefined) continue
            lines.push(`    subgraph branch_${step.index}_${branchIndex}_${mermaidSafeId(branchId)}["branch ${mermaidLabel(branchId)}"]`)
            for (let index = range.startIndex; index <= range.endIndex; index += 1) {
                const branchStep = steps[index]
                if (branchStep === undefined) continue
                appendMermaidNode(lines, branchStep, "      ")
                grouped.add(branchStep.index)
            }
            lines.push("    end")
        }
        lines.push("  end")
    }
    for (const step of steps) {
        if (grouped.has(step.index)) continue
        appendMermaidNode(lines, step, "  ")
    }
    for (const step of steps) {
        if (step.kind === "fanout" && step.fanout !== undefined) {
            for (const range of step.fanout.branchRanges) {
                const head = steps[range.startIndex]
                const tail = steps[range.endIndex]
                const join = steps[step.fanout.joinIndex]
                if (head !== undefined) lines.push(`  ${mermaidNodeId(step)} --> ${mermaidNodeId(head)}`)
                for (let index = range.startIndex; index < range.endIndex; index += 1) {
                    const current = steps[index]
                    const next = steps[index + 1]
                    if (current !== undefined && next !== undefined) lines.push(`  ${mermaidNodeId(current)} --> ${mermaidNodeId(next)}`)
                }
                if (tail !== undefined && join !== undefined) lines.push(`  ${mermaidNodeId(tail)} --> ${mermaidNodeId(join)}`)
            }
            continue
        }
        if (step.kind === "gate") {
            const targets = step.targetSteps ?? (step.targetStep === undefined ? [] : [step.targetStep])
            for (const targetStep of targets) {
                const target = steps[targetStep - 1]
                if (target !== undefined) lines.push(`  ${mermaidNodeId(target)} -. verifies .-> ${mermaidNodeId(step)}`)
            }
        }
        const next = steps[step.index + 1]
        if (step.branch === undefined && next !== undefined && next.branch === undefined && step.kind !== "fanout") {
            lines.push(`  ${mermaidNodeId(step)} --> ${mermaidNodeId(next)}`)
        }
    }
    appendMermaidStatusClasses(lines, steps, statusByIndex)
    return lines.join("\n")
}

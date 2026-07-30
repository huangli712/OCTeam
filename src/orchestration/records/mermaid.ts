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

/** Check if a gate step has a conditional goto (a `where` clause). */
function hasConditionalGoto(step: WorkflowRunStep): boolean {
    return step.where !== undefined
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
                    if (current === undefined || next === undefined) continue
                    // M-1: suppress the default sequential edge when the current
                    // step is a gate whose PASS verdict jumps elsewhere (mirrors
                    // the hasPassGoto check on the outer loop at line 162).
                    // Pre-fix code generated BOTH s2-->s3 (sequential) AND
                    // s2--PASS-->s4 (goto), making the diagram imply two
                    // conflicting flows from the same gate.
                    // M19 fix: only suppress when the goto is UNCONDITIONAL
                    // (no `where` clause). A conditional goto (where != null)
                    // may not fire at runtime — the sequential edge is the
                    // fallback path and must be shown.
                    const suppressSequential = current.kind === "gate"
                        && current.onPassGoto !== undefined
                        && !hasConditionalGoto(current)
                    if (!suppressSequential) {
                        lines.push(`  ${mermaidNodeId(current)} --> ${mermaidNodeId(next)}`)
                    }
                }
                // M-1 boundary: suppress the tail→join edge when the tail is a
                // gate whose PASS verdict jumps elsewhere — same contract as the
                // inner sequential-edge suppression above. Pre-fix code
                // unconditionally drew tail-->join even when the tail gate had
                // an onPassGoto, producing two conflicting flows from the tail.
                // M19 fix: same conditional-goto logic as the inner loop —
                // a gate with `where` still falls through to the join on
                // non-match, so the tail-->join edge must be drawn.
                const suppressTailJoin = tail !== undefined
                    && tail.kind === "gate"
                    && tail.onPassGoto !== undefined
                    && !hasConditionalGoto(tail)
                if (tail !== undefined && join !== undefined && !suppressTailJoin) {
                    lines.push(`  ${mermaidNodeId(tail)} --> ${mermaidNodeId(join)}`)
                }
            }
            continue
        }
        if (step.kind === "gate") {
            const targets = step.targetSteps ?? (step.targetStep === undefined ? [] : [step.targetStep])
            for (const targetStep of targets) {
                const target = steps[targetStep - 1]
                if (target !== undefined) lines.push(`  ${mermaidNodeId(target)} -. verifies .-> ${mermaidNodeId(step)}`)
            }
            // Draw goto edges so the graph reflects non-linear control flow.
            // onPassGoto replaces the default sequential edge (PASS skips ahead).
            if (step.onPassGoto !== undefined) {
                const gotoTarget = steps[step.onPassGoto - 1]
                if (gotoTarget !== undefined) lines.push(`  ${mermaidNodeId(step)} -- PASS --> ${mermaidNodeId(gotoTarget)}`)
            }
            if (step.onFailGoto !== undefined) {
                const gotoTarget = steps[step.onFailGoto - 1]
                if (gotoTarget !== undefined) lines.push(`  ${mermaidNodeId(step)} -. FAIL .-> ${mermaidNodeId(gotoTarget)}`)
            }
            if (step.onInvalidGoto !== undefined) {
                const gotoTarget = steps[step.onInvalidGoto - 1]
                if (gotoTarget !== undefined) lines.push(`  ${mermaidNodeId(step)} -. INVALID .-> ${mermaidNodeId(gotoTarget)}`)
            }
        }
        // Draw the default sequential edge ONLY when the gate does not have
        // an onPassGoto (without it, PASS flow continues to the next step).
        // M19 fix: a gate with a `where` conditional goto still falls through
        // to the next step when the condition doesn't match, so the sequential
        // edge must be preserved.
        const hasPassGoto = step.kind === "gate"
            && step.onPassGoto !== undefined
            && !hasConditionalGoto(step)
        const next = steps[step.index + 1]
        if (!hasPassGoto && step.branch === undefined && next !== undefined && next.branch === undefined && step.kind !== "fanout") {
            lines.push(`  ${mermaidNodeId(step)} --> ${mermaidNodeId(next)}`)
        }
    }
    appendMermaidStatusClasses(lines, steps, statusByIndex)
    return lines.join("\n")
}

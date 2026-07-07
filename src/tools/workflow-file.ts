import fs from "node:fs/promises"
import path from "node:path"

import type { WorkflowToolStep } from "./workflow.js"

// Supported workflow_file schema versions. When the schema gains a v2, add it
// here and branch on `version` in loadWorkflowFile. A file with an unlisted
// version is rejected explicitly so a schema drift fails loudly instead of
// silently mis-parsing fields (e.g. a renamed key, a removed shape).
const SUPPORTED_WORKFLOW_FILE_VERSIONS = new Set([1])

type WorkflowFileResult =
    | { steps: WorkflowToolStep[] }
    | { error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeBase(baseDir: string): string {
    return path.resolve(baseDir)
}

function isInside(baseDir: string, filePath: string): boolean {
    const rel = path.relative(baseDir, filePath)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function resolveWorkflowFilePath(baseDir: string, relPath: string): { filePath: string } | { error: string } {
    if (path.isAbsolute(relPath)) return { error: "Error: workflow_file must be relative to the workspace" }
    if (!relPath.endsWith(".json")) return { error: "Error: workflow_file must point to a .json file" }
    const base = normalizeBase(baseDir)
    const filePath = path.resolve(base, relPath)
    if (!isInside(base, filePath)) return { error: "Error: workflow_file must stay inside the workspace" }
    return { filePath }
}

function applyTemplateVars(value: unknown, vars: Record<string, string>): unknown {
    if (typeof value === "string") {
        return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name: string) => vars[name] ?? match)
    }
    if (Array.isArray(value)) return value.map(item => applyTemplateVars(item, vars))
    if (isRecord(value)) {
        const out: Record<string, unknown> = {}
        for (const [key, inner] of Object.entries(value)) out[key] = applyTemplateVars(inner, vars)
        return out
    }
    return value
}

function isWorkflowStepArray(value: unknown): value is WorkflowToolStep[] {
    return Array.isArray(value) && value.every(item => isRecord(item) && (item.kind === "task" || item.kind === "gate"))
}

export async function loadWorkflowFile(baseDir: string, relPath: string, vars: Record<string, string>): Promise<WorkflowFileResult> {
    const resolved = resolveWorkflowFilePath(baseDir, relPath)
    if ("error" in resolved) return resolved

    let raw: string
    try {
        raw = await fs.readFile(resolved.filePath, "utf8")
    } catch {
        return { error: `Error: workflow_file "${relPath}" could not be read` }
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return { error: `Error: workflow_file "${relPath}" is not valid JSON` }
    }

    const templated = applyTemplateVars(parsed, vars)
    if (!isRecord(templated)) {
        return { error: `Error: workflow_file "${relPath}" must contain a workflow steps array` }
    }
    // version: optional (absent => 1 for backward compatibility), but when
    // present must be an integer we recognize. An unknown version is rejected
    // explicitly so a schema-evolved file fails loud, not silent.
    if (templated.version !== undefined) {
        if (typeof templated.version !== "number" || !Number.isInteger(templated.version)) {
            return { error: `Error: workflow_file "${relPath}" version must be an integer` }
        }
        if (!SUPPORTED_WORKFLOW_FILE_VERSIONS.has(templated.version)) {
            return { error: `Error: workflow_file "${relPath}" version ${templated.version} is unsupported (expected one of: ${[...SUPPORTED_WORKFLOW_FILE_VERSIONS].join(", ")})` }
        }
    }
    const steps = templated.steps
    if (!isWorkflowStepArray(steps)) {
        return { error: `Error: workflow_file "${relPath}" must contain a workflow steps array` }
    }
    return { steps }
}

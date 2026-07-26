/**
 * Workflow file loader: read, parse, template, and validate a workflow_file
 * JSON against the supported schema version. Also exports the shared step-array
 * validator (`validateWorkflowSteps`) used by the pure planner-reuse path.
 */

import fs from "node:fs/promises"
import path from "node:path"

import type { WorkflowFanoutToolStep, WorkflowToolStep } from "../../core/types/workflow.js"

// Supported workflow_file schema versions. When the schema gains a v2, add it
// here and branch on `version` in loadWorkflowFile. A file with an unlisted
// version is rejected explicitly so a schema drift fails loudly instead of
// silently mis-parsing fields (e.g. a renamed key, a removed shape).
const SUPPORTED_WORKFLOW_FILE_VERSIONS = new Set([1])

/** Result of loading a workflow_file: parsed steps or an error message. */
type WorkflowFileResult =
    | { steps: WorkflowToolStep[] }
    | { error: string }

/** File path + human-readable prefix for error messages (e.g. "step 2 branch \"fix\" step 1"). */
type StepLocation = {
    readonly filePath: string
    readonly prefix: string
}

/** Thrown when a ${name} reference has no matching entry in `vars` under strict mode. */
class UnknownTemplateVarError extends Error {
    readonly name: string
    constructor(varName: string) {
        super(`unknown template variable "${varName}"`)
        this.name = varName
    }
}

/** Narrow unknown to a non-null non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Resolve a directory path to its absolute form. */
function normalizeBase(baseDir: string): string {
    return path.resolve(baseDir)
}

/** Check that filePath is strictly inside baseDir. */
function isInside(baseDir: string, filePath: string): boolean {
    const rel = path.relative(baseDir, filePath)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/** Resolve a relative workflow_file path, validating it stays within the workspace. */
async function resolveWorkflowFilePath(baseDir: string, relPath: string): Promise<{ filePath: string } | { error: string }> {
    if (path.isAbsolute(relPath)) return { error: "Error: workflow_file must be relative to the workspace" }
    if (!relPath.endsWith(".json")) return { error: "Error: workflow_file must point to a .json file" }
    const base = normalizeBase(baseDir)
    const filePath = path.resolve(base, relPath)
    if (!isInside(base, filePath)) return { error: "Error: workflow_file must stay inside the workspace" }
    // Resolve symlinks and re-check containment so a symlinked workflow_file
    // cannot redirect the read outside the workspace.
    try {
        const real = await fs.realpath(filePath)
        if (!isInside(base, real)) return { error: "Error: workflow_file must not be a symlink outside the workspace" }
    } catch (err: unknown) {
        // File does not exist yet — the string-path check above is sufficient.
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "ENOENT") throw err
    }
    return { filePath }
}

/** Recursively replace ${name} placeholders in value using the provided vars dictionary. */
function applyTemplateVars(value: unknown, vars: Record<string, string>, strict: boolean): unknown {
    if (typeof value === "string") {
        return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
            if (Object.prototype.hasOwnProperty.call(vars, name)) {
                return vars[name] ?? ""
            }
            // Strict mode: surface unknown variables explicitly so a typo in
            // a var name fails the run loud instead of silently leaking a
            // literal ${x} into the dispatch prompt. Non-strict keeps the
            // backward-compatible literal-preserving behavior.
            if (strict) throw new UnknownTemplateVarError(name)
            return match
        })
    }
    if (Array.isArray(value)) return value.map(item => applyTemplateVars(item, vars, strict))
    if (isRecord(value)) {
        const out: Record<string, unknown> = {}
        for (const [key, inner] of Object.entries(value)) out[key] = applyTemplateVars(inner, vars, strict)
        return out
    }
    return value
}

/** Validate an array of workflow step objects. */
function validateWorkflowStepArray(
    value: unknown, location: StepLocation,
): { steps: WorkflowToolStep[] } | { error: string } {
    if (!Array.isArray(value)) {
        return { error: `Error: workflow_file "${location.filePath}" must contain a workflow steps array` }
    }
    const steps: WorkflowToolStep[] = []
    for (let index = 0; index < value.length; index += 1) {
        const step = validateWorkflowStep(value[index], { ...location, prefix: `${location.prefix} ${index + 1}` })
        if ("error" in step) return step
        steps.push(step.step)
    }
    return { steps }
}

/**
 * Workflow step-array validation shared by the pure planner-reuse path and by
 * loadWorkflowFile. Both callers delegate to the same private step-array
 * validation, so they get identical semantics (kind, field ranges, fanout
 * recursion).
 *
 * The one-arg form is pure: it never touches the filesystem and attributes
 * errors to a stable synthetic `<workflow>` location. loadWorkflowFile passes
 * the real relative workflow_file path so its error strings keep naming the
 * actual file.
 */
export function validateWorkflowSteps(value: unknown): { steps: WorkflowToolStep[] } | { error: string }

export function validateWorkflowSteps(
    value: unknown, sourcePath: string,
): { steps: WorkflowToolStep[] } | { error: string }

export function validateWorkflowSteps(
    value: unknown, sourcePath = "<workflow>",
): { steps: WorkflowToolStep[] } | { error: string } {
    return validateWorkflowStepArray(value, { filePath: sourcePath, prefix: "step" })
}

/** Validate a single workflow step, recursing into fanout branches. */
function validateWorkflowStep(value: unknown, location: StepLocation): { step: WorkflowToolStep } | { error: string } {
    if (!isRecord(value)) {
        return { error: `Error: workflow_file "${location.filePath}" ${location.prefix} must be an object` }
    }
    const kind = value.kind
    if (kind !== "task" && kind !== "gate"
        && kind !== "fanout" && kind !== "join") {
        return {
            error: `Error: workflow_file "${location.filePath}" ${location.prefix}`
                + ` kind must be task, gate, fanout, or join`,
        }
    }
    const fieldError = validateWorkflowStepFields(value, location)
    if (fieldError !== null) return { error: fieldError }
    switch (kind) {
        case "task":
        case "gate":
        case "join":
            return { step: value as WorkflowToolStep }
        case "fanout": {
            const branches = validateWorkflowBranches(value.branches, location)
            if ("error" in branches) return branches
            return { step: { ...value, branches: branches.branches } as WorkflowToolStep }
        }
    }
}

/** Validate the branches array of a fanout step. */
function validateWorkflowBranches(
    value: unknown, location: StepLocation,
): { branches: NonNullable<WorkflowFanoutToolStep["branches"]> } | { error: string } {
    if (!Array.isArray(value)) {
        return { error: `Error: workflow_file "${location.filePath}" ${location.prefix} branches must be an array` }
    }
    const branches: Array<{ id: string; steps: WorkflowToolStep[] }> = []
    for (let index = 0; index < value.length; index += 1) {
        const branch = value[index]
        if (!isRecord(branch)) {
            return {
                error: `Error: workflow_file "${location.filePath}" ${location.prefix}`
                    + ` branch ${index + 1} must be an object`,
            }
        }
        const idValue = branch.id
        if (!isNonEmptyString(idValue) || idValue.length > 64) {
            return {
                error: `Error: workflow_file "${location.filePath}" ${location.prefix}`
                    + ` branch ${index + 1} id must be a non-empty string up to 64 characters`,
            }
        }
        const branchId = idValue
        const steps = validateWorkflowStepArray(branch.steps, {
            filePath: location.filePath,
            prefix: `${location.prefix} branch "${branchId}" step`,
        })
        if ("error" in steps) return steps
        branches.push({ id: branchId, steps: steps.steps })
    }
    return { branches }
}

/** Validate all field-level constraints on a single workflow step. Returns an error string or null. */
function validateWorkflowStepFields(step: Record<string, unknown>, location: StepLocation): string | null {
    for (const field of [
        "id", "member", "fallback_member", "verifier", "fallback_verifier", "reducer_member",
    ] as const) {
        if (step[field] !== undefined && (!isNonEmptyString(step[field]) || step[field].length > 64)) {
            return `Error: workflow_file "${location.filePath}" ${location.prefix}`
                + ` ${field} must be a non-empty string up to 64 characters`
        }
    }
    for (const field of ["task", "criteria"] as const) {
        if (step[field] !== undefined && (!isNonEmptyString(step[field]) || step[field].length > 8192)) {
            return `Error: workflow_file "${location.filePath}" ${location.prefix}`
                + ` ${field} must be a non-empty string up to 8192 characters`
        }
    }
    for (const field of ["target_step", "on_pass_goto", "on_fail_goto", "on_invalid_goto"] as const) {
        if (step[field] !== undefined && !isWorkflowStepRef(step[field])) {
            return `Error: workflow_file "${location.filePath}" ${location.prefix}`
                + ` ${field} must be a positive integer or non-empty string`
        }
    }
    if (step.targets !== undefined
        && (!Array.isArray(step.targets) || step.targets.length === 0
            || !step.targets.every(isWorkflowStepRef))) {
        return `Error: workflow_file "${location.filePath}" ${location.prefix}`
            + ` targets must be a non-empty array of positive integers or non-empty strings`
    }
    if (step.inputs !== undefined
        && (!Array.isArray(step.inputs) || step.inputs.length === 0
            || !step.inputs.every(isWorkflowStepRef))) {
        return `Error: workflow_file "${location.filePath}" ${location.prefix}`
            + ` inputs must be a non-empty array of positive integers or non-empty strings`
    }
    if (step.expose_output !== undefined && typeof step.expose_output !== "boolean") {
        return `Error: workflow_file "${location.filePath}" ${location.prefix} expose_output must be boolean`
    }
    if (step.on_fail !== undefined
        && step.on_fail !== "retry" && step.on_fail !== "fail"
        && step.on_fail !== "skip") {
        return `Error: workflow_file "${location.filePath}" ${location.prefix} on_fail must be retry, fail, or skip`
    }
    if (step.max_retries !== undefined && !isIntegerInRange(step.max_retries, 0, 5)) {
        return `Error: workflow_file "${location.filePath}" ${location.prefix}`
            + ` max_retries must be an integer from 0 to 5`
    }
    if (step.on_invalid !== undefined
        && step.on_invalid !== "fail"
        && step.on_invalid !== "retry_verifier"
        && step.on_invalid !== "escalate") {
        return `Error: workflow_file "${location.filePath}" ${location.prefix}`
            + ` on_invalid must be fail, retry_verifier, or escalate`
    }
    if (step.max_invalid_retries !== undefined && !isIntegerInRange(step.max_invalid_retries, 0, 5)) {
        return `Error: workflow_file "${location.filePath}" ${location.prefix}`
            + ` max_invalid_retries must be an integer from 0 to 5`
    }
    for (const field of ["approval_before", "approval_after"] as const) {
        if (step[field] !== undefined && typeof step[field] !== "boolean") {
            return `Error: workflow_file "${location.filePath}" ${location.prefix} ${field} must be boolean`
        }
    }
    if (step.max_output_bytes !== undefined && !isIntegerAtLeast(step.max_output_bytes, 1)) {
        return `Error: workflow_file "${location.filePath}" ${location.prefix}`
            + ` max_output_bytes must be a positive integer`
    }
    if (step.timeout_ms !== undefined && !isIntegerAtLeast(step.timeout_ms, 1000)) {
        return `Error: workflow_file "${location.filePath}" ${location.prefix} timeout_ms must be an integer >= 1000`
    }
    if (step.on_timeout !== undefined
        && step.on_timeout !== "fail" && step.on_timeout !== "retry"
        && step.on_timeout !== "skip") {
        return `Error: workflow_file "${location.filePath}" ${location.prefix} on_timeout must be fail, retry, or skip`
    }
    if (step.max_timeout_retries !== undefined && !isIntegerInRange(step.max_timeout_retries, 0, 5)) {
        return `Error: workflow_file "${location.filePath}" ${location.prefix}`
            + ` max_timeout_retries must be an integer from 0 to 5`
    }
    if (step.max_jumps !== undefined && !isIntegerInRange(step.max_jumps, 0, 10)) {
        return `Error: workflow_file "${location.filePath}" ${location.prefix}`
            + ` max_jumps must be an integer from 0 to 10`
    }
    if (step.max_errored !== undefined && !isIntegerAtLeast(step.max_errored, 0)) {
        return `Error: workflow_file "${location.filePath}" ${location.prefix}`
            + ` max_errored must be a non-negative integer`
    }
    if (step.use_survivors !== undefined && typeof step.use_survivors !== "boolean") {
        return `Error: workflow_file "${location.filePath}" ${location.prefix} use_survivors must be boolean`
    }
    if (step.join_policy !== undefined
        && step.join_policy !== "all" && step.join_policy !== "quorum"
        && step.join_policy !== "any_success"
        && step.join_policy !== "required_branches"
        && step.join_policy !== "reduce"
        && step.join_policy !== "select") {
        return `Error: workflow_file "${location.filePath}" ${location.prefix}`
            + ` join_policy must be all, quorum, any_success, required_branches, reduce, or select`
    }
    if (step.where !== undefined && !isValidWhere(step.where)) {
        return `Error: workflow_file "${location.filePath}" ${location.prefix}`
            + ` where must contain numeric thresholds or a valid issue severity`
    }
    return null
}

/** Narrow unknown to a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0
}

/** Narrow unknown to an integer >= min. */
function isIntegerAtLeast(value: unknown, min: number): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= min
}

/** Narrow unknown to an integer in [min, max]. */
function isIntegerInRange(value: unknown, min: number, max: number): value is number {
    return isIntegerAtLeast(value, min) && value <= max
}

/** Check whether value is a valid workflow step ref (positive integer or non-empty string). */
function isWorkflowStepRef(value: unknown): boolean {
    return isIntegerAtLeast(value, 1) || isNonEmptyString(value)
}

/** Validate that value is a valid where clause object. */
function isValidWhere(value: unknown): boolean {
    if (!isRecord(value)) return false
    if (value.score_gte !== undefined && typeof value.score_gte !== "number") return false
    if (value.score_lt !== undefined && typeof value.score_lt !== "number") return false
    if (value.confidence_gte !== undefined && typeof value.confidence_gte !== "number") return false
    if (value.has_issue_severity !== undefined
        && value.has_issue_severity !== "low"
        && value.has_issue_severity !== "medium"
        && value.has_issue_severity !== "high"
        && value.has_issue_severity !== "critical") return false
    return true
}

/** Load, parse, template, and validate a workflow_file JSON from disk. */
export async function loadWorkflowFile(
    baseDir: string, relPath: string, vars: Record<string, string>,
): Promise<WorkflowFileResult> {
    const resolved = await resolveWorkflowFilePath(baseDir, relPath)
    if ("error" in resolved) return resolved

    // Re-verify realpath immediately before reading. resolveWorkflowFilePath
    // checks realpath, but the gap between that check and this read is a
    // TOCTOU window where a symlink could be installed.
    const real = await fs.realpath(resolved.filePath).catch(() => resolved.filePath)
    const base = normalizeBase(baseDir)
    if (!isInside(base, real)) {
        return { error: "Error: workflow_file must not be a symlink outside the workspace" }
    }

    let raw: string
    try {
        raw = await fs.readFile(real, "utf8")
    } catch {
        return { error: `Error: workflow_file "${relPath}" could not be read` }
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return { error: `Error: workflow_file "${relPath}" is not valid JSON` }
    }

    const templated: unknown = (() => {
        // strict_vars is read from the RAW (pre-template) parsed object so the
        // config itself is never subject to templating. Default: false keeps
        // backward-compat (unknown ${x} stays literal).
        const strictVars = isRecord(parsed) && parsed.strict_vars === true
        try {
            return applyTemplateVars(parsed, vars, strictVars)
        } catch (e) {
            if (e instanceof UnknownTemplateVarError) {
                return {
                    __templateError:
                        `Error: workflow_file "${relPath}" references unknown template variable "${e.name}"`,
                }
            }
            throw e
        }
    })()
    if (isRecord(templated) && typeof templated.__templateError === "string") {
        return { error: templated.__templateError }
    }
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
            const expectedVersions = [...SUPPORTED_WORKFLOW_FILE_VERSIONS].join(", ")
            return {
                error:
                    `Error: workflow_file "${relPath}" version ${templated.version}`
                    + ` is unsupported (expected one of: ${expectedVersions})`,
            }
        }
    }
    const steps = validateWorkflowSteps(templated.steps, relPath)
    if ("error" in steps) return steps
    return steps
}

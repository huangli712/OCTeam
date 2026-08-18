/**
 * Workflow file loader: read, parse, template, and validate a workflow_file
 * JSON against the supported schema version. Also exports the shared step-array
 * validator (`validateWorkflowSteps`) used by the pure planner-reuse path.
 */

import fs from "node:fs/promises"
import path from "node:path"

import type { WorkflowFanoutToolStep, WorkflowToolStep } from "../../core/types/workflow.js"
import { logger } from "../../core/log.js"
import { assertNoSymlinkTraversal } from "../../state/locks.js"

// Supported workflow_file schema versions. When the schema gains a v2, add it
// here and branch on `version` in loadWorkflowFile. A file with an unlisted
// version is rejected explicitly so a schema drift fails loudly instead of
// silently mis-parsing fields (e.g. a renamed key, a removed shape).
const SUPPORTED_WORKFLOW_FILE_VERSIONS = new Set([1])

// Resource caps protect caller-supplied JSON read from the
// project workspace, which member agents can write to. Without caps a
// hostile or buggy file can exhaust memory (giant file, giant branch array)
// or stack (deeply nested fanout). These limits are generous enough for any
// realistic workflow and tight enough to fail fast on abuse.
const WORKFLOW_FILE_MAX_BYTES = 1024 * 1024 // 1 MiB raw file
/** Maximum number of workflow steps across linear and nested fanout definitions. */
export const WORKFLOW_MAX_TOTAL_STEPS = 256 // across linear + nested fanouts
const WORKFLOW_MAX_FANOUT_DEPTH = 8 // nested fanout levels
const WORKFLOW_MAX_BRANCHES_PER_FANOUT = 64 // raw branch array (matrix/foreach expansion is capped separately in lower.ts)

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

/** Recursively replace ${name} placeholders in value using the provided vars dictionary.
 * Bounded by max depth and cumulative expansion bytes to prevent stack
 * overflow and memory exhaustion from deeply nested or highly repetitive
 * template values in a hostile workflow_file. */
const TEMPLATE_MAX_DEPTH = 20
const TEMPLATE_MAX_EXPANSION_BYTES = 512 * 1024 // 512 KiB cumulative output

function applyTemplateVars(value: unknown, vars: Record<string, string>, strict: boolean): unknown {
    return applyTemplateVarsBounded(value, vars, strict, 0, { expansionBytes: 0 })
}

function applyTemplateVarsBounded(
    value: unknown,
    vars: Record<string, string>,
    strict: boolean,
    depth: number,
    budget: { expansionBytes: number },
): unknown {
    if (depth > TEMPLATE_MAX_DEPTH) {
        throw new Error(`applyTemplateVars: exceeded max nesting depth (${TEMPLATE_MAX_DEPTH})`)
    }
    if (typeof value === "string") {
        // Cap each variable value before substitution to
        // prevent OOM from repeated placeholders multiplied by large values.
        const MAX_VAR_VALUE_BYTES = 65_536
        const boundedVars: Record<string, string> = {}
        for (const [k, v] of Object.entries(vars)) {
            const vBytes = Buffer.byteLength(v ?? "", "utf8")
            if (vBytes > MAX_VAR_VALUE_BYTES) {
                // Use Buffer-based truncation for correct UTF-8 byte counts;
                // string slicing counts UTF-16 code units and can exceed the
                // byte cap for multibyte text.
                // Back off to the last complete UTF-8 character boundary so
                // toString doesn't insert U+FFFD replacement chars.
                const buf = Buffer.from(v ?? "", "utf8")
                let end = MAX_VAR_VALUE_BYTES
                // Walk back to a character boundary (0x00-0x7F start byte or
                // continuation byte follows a start byte).
                while (end > 0 && (buf[end] & 0xC0) === 0x80) end--
                boundedVars[k] = buf.subarray(0, end).toString("utf8") + "[...truncated]"
            } else {
                boundedVars[k] = v ?? ""
            }
        }
        const result = value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
            if (Object.prototype.hasOwnProperty.call(boundedVars, name)) {
                return boundedVars[name]
            }
            if (strict) throw new UnknownTemplateVarError(name)
            return match
        })
        budget.expansionBytes += Buffer.byteLength(result, "utf8")
        if (budget.expansionBytes > TEMPLATE_MAX_EXPANSION_BYTES) {
            throw new Error(`applyTemplateVars: exceeded max expansion bytes (${TEMPLATE_MAX_EXPANSION_BYTES})`)
        }
        return result
    }
    if (Array.isArray(value)) return value.map(item => applyTemplateVarsBounded(item, vars, strict, depth + 1, budget))
    if (isRecord(value)) {
        const out: Record<string, unknown> = {}
        for (const [key, inner] of Object.entries(value)) {
            // Block prototype pollution by rejecting keys that target
            // Object.prototype via __proto__ or constructor.
            if (key === "__proto__" || key === "constructor" || key === "prototype") continue
            out[key] = applyTemplateVarsBounded(inner, vars, strict, depth + 1, budget)
        }
        return out
    }
    return value
}

/** Internal accumulator for resource-limit tracking across the recursion. */
type ValidationBudget = {
    totalSteps: number // running count of validated steps (linear + nested)
    depth: number      // current fanout-nesting depth (0 at top level)
}

/** Recursive worker that enforces total-step and depth caps. */
function validateWorkflowStepArrayInternal(
    value: unknown,
    location: StepLocation,
    budget: ValidationBudget,
): { steps: WorkflowToolStep[] } | { error: string } {
    if (!Array.isArray(value)) {
        return { error: `Error: workflow_file "${location.filePath}" must contain a workflow steps array` }
    }
    const steps: WorkflowToolStep[] = []
    for (let index = 0; index < value.length; index += 1) {
        budget.totalSteps += 1
        if (budget.totalSteps > WORKFLOW_MAX_TOTAL_STEPS) {
            return {
                error: `Error: workflow_file "${location.filePath}" exceeds the maximum of ${WORKFLOW_MAX_TOTAL_STEPS} total steps`,
            }
        }
        const step = validateWorkflowStep(value[index], { ...location, prefix: `${location.prefix} ${index + 1}` }, budget)
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
    return validateWorkflowStepArrayInternal(value, { filePath: sourcePath, prefix: "step" }, { totalSteps: 0, depth: 0 })
}

/**
 * Bound the number of branches a matrix/foreach fanout would expand to,
 * so a large matrix cannot bypass the total-step budget at validation time.
 * Returns the product of all matrix array lengths, or foreach length, or 1.
 */
function matrixForeachExpansionBound(step: { matrix?: unknown; foreach?: unknown }): number {
    if (Array.isArray(step.foreach)) return step.foreach.length
    if (isRecord(step.matrix)) {
        let product = 1
        for (const v of Object.values(step.matrix)) {
            if (Array.isArray(v)) product *= v.length
        }
        return product
    }
    return 1
}

/** Validate a single workflow step, recursing into fanout branches. */
function validateWorkflowStep(value: unknown, location: StepLocation, budget: ValidationBudget): { step: WorkflowToolStep } | { error: string } {
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
    const fieldError = validateWorkflowStepFields(value, kind, location)
    if (fieldError !== null) return { error: fieldError }
    switch (kind) {
        case "task":
        case "gate":
        case "join":
            return { step: value as WorkflowToolStep }
        case "fanout": {
            // Matrix and foreach fanouts do not use `branches`; they
            // define variables that are expanded at runtime. Only validate
            // branches when neither matrix nor foreach is present.
            if (value.matrix !== undefined || value.foreach !== undefined) {
                // Validate matrix and foreach runtime types so malformed values
                // cannot reach runtime with a broken type contract.
                if (value.matrix !== undefined) {
                    if (!isRecord(value.matrix)) {
                        return { error: `Error: workflow_file "${location.filePath}" ${location.prefix}`
                            + ` matrix must be an object of string arrays` }
                    }
                    for (const [mk, mv] of Object.entries(value.matrix)) {
                        if (!Array.isArray(mv) || !mv.every((x): x is string => typeof x === "string")) {
                            return { error: `Error: workflow_file "${location.filePath}" ${location.prefix}`
                                + ` matrix.${mk} must be a string array` }
                        }
                    }
                }
                if (value.foreach !== undefined) {
                    if (!Array.isArray(value.foreach) || !value.foreach.every((x): x is string => typeof x === "string")) {
                        return { error: `Error: workflow_file "${location.filePath}" ${location.prefix}`
                            + ` foreach must be a string array` }
                    }
                }
                // Validate the template `steps` array recursively so an
                // invalid kind inside the template (which would be expanded
                // into N branches at runtime) is caught at load time, and so
                // the total step budget accounts for the expanded size.
                if (!Array.isArray(value.steps)) {
                    return { error: `Error: workflow_file "${location.filePath}" ${location.prefix} with matrix/foreach requires a \`steps\` array` }
                }
                // Bound the matrix/foreach expansion to prevent resource
                // exhaustion via a large matrix.
                const expansionBound = matrixForeachExpansionBound(value)
                if (expansionBound * value.steps.length > WORKFLOW_MAX_TOTAL_STEPS) {
                    return {
                        error: `Error: workflow_file "${location.filePath}" ${location.prefix}`
                            + ` matrix/foreach expansion (${expansionBound} branches × ${value.steps.length} steps)`
                            + ` exceeds the ${WORKFLOW_MAX_TOTAL_STEPS}-step budget`,
                    }
                }
                const totalBeforeTemplate = budget.totalSteps
                const parentDepth = budget.depth
                budget.depth = parentDepth + 1
                const validatedSteps = validateWorkflowStepArrayInternal(value.steps, { filePath: location.filePath, prefix: `${location.prefix} steps` }, budget)
                budget.depth = parentDepth
                if ("error" in validatedSteps) return { error: validatedSteps.error }
                const recursiveTemplateSteps = budget.totalSteps - totalBeforeTemplate
                budget.totalSteps += recursiveTemplateSteps * (expansionBound - 1)
                if (budget.totalSteps > WORKFLOW_MAX_TOTAL_STEPS) {
                    return {
                        error: `Error: workflow_file "${location.filePath}" ${location.prefix}`
                            + ` matrix/foreach expansion (${expansionBound} branches × ${recursiveTemplateSteps} recursive steps)`
                            + ` exceeds the ${WORKFLOW_MAX_TOTAL_STEPS}-step budget`,
                    }
                }
                return { step: { ...(value as Record<string, unknown>), steps: validatedSteps.steps } as unknown as WorkflowToolStep }
            }
            const branches = validateWorkflowBranches(value.branches, location, budget)
            if ("error" in branches) return branches
            return { step: { ...value, branches: branches.branches } as WorkflowToolStep }
        }
    }
}

/** Validate the branches array of a fanout step. */
function validateWorkflowBranches(
    value: unknown,
    location: StepLocation,
    budget: ValidationBudget,
): { branches: NonNullable<WorkflowFanoutToolStep["branches"]> } | { error: string } {
    if (!Array.isArray(value)) {
        return { error: `Error: workflow_file "${location.filePath}" ${location.prefix} branches must be an array` }
    }
    if (value.length > WORKFLOW_MAX_BRANCHES_PER_FANOUT) {
        return {
            error: `Error: workflow_file "${location.filePath}" ${location.prefix}`
                + ` has ${value.length} branches; limit is ${WORKFLOW_MAX_BRANCHES_PER_FANOUT}`,
        }
    }
    if (budget.depth >= WORKFLOW_MAX_FANOUT_DEPTH) {
        return {
            error: `Error: workflow_file "${location.filePath}" ${location.prefix}`
                + ` exceeds the maximum fanout nesting depth of ${WORKFLOW_MAX_FANOUT_DEPTH}`,
        }
    }
    const branches: Array<{ id: string; steps: WorkflowToolStep[] }> = []
    const childBudget: ValidationBudget = { totalSteps: budget.totalSteps, depth: budget.depth + 1 }
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
        const steps = validateWorkflowStepArrayInternal(branch.steps, {
            filePath: location.filePath,
            prefix: `${location.prefix} branch "${branchId}" step`,
        }, childBudget)
        if ("error" in steps) return steps
        branches.push({ id: branchId, steps: steps.steps })
    }
    // Propagate the running totals back up so siblings see them.
    budget.totalSteps = childBudget.totalSteps
    return { branches }
}

/** Validate all field-level constraints on a single workflow step. Returns an error string or null. */
function validateWorkflowStepFields(
    step: Record<string, unknown>,
    kind: WorkflowToolStep["kind"],
    location: StepLocation,
): string | null {
    if (kind === "fanout" || kind === "join") {
        for (const field of ["approval_before", "timeout_ms", "max_output_bytes"] as const) {
            if (step[field] !== undefined) {
                return `Error: workflow_file "${location.filePath}" ${location.prefix}`
                    + ` ${kind} marker does not support ${field}`
            }
        }
    }
    if (kind === "join") {
        for (const field of ["join_policy", "quorum", "reducer_member"] as const) {
            if (step[field] !== undefined) {
                return `Error: workflow_file "${location.filePath}" ${location.prefix}`
                    + ` join marker does not support ${field}`
            }
        }
    }
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
    if (step.on_malformed !== undefined
        && step.on_malformed !== "fail"
        && step.on_malformed !== "retry_verifier"
        && step.on_malformed !== "skip"
        && step.on_malformed !== "escalate") {
        return `Error: workflow_file "${location.filePath}" ${location.prefix}`
            + ` on_malformed must be fail, retry_verifier, skip, or escalate`
    }
    if (step.ensemble_policy !== undefined
        && step.ensemble_policy !== "majority"
        && step.ensemble_policy !== "quorum"
        && step.ensemble_policy !== "unanimous") {
        return `Error: workflow_file "${location.filePath}" ${location.prefix}`
            + ` ensemble_policy must be majority, quorum, or unanimous`
    }
    if (step.loop !== undefined) {
        if (!isRecord(step.loop)) {
            return `Error: workflow_file "${location.filePath}" ${location.prefix} loop must be an object`
        }
        if (!isIntegerInRange(step.loop.max_iterations, 1, 20)) {
            return `Error: workflow_file "${location.filePath}" ${location.prefix}`
                + ` loop.max_iterations must be an integer from 1 to 20`
        }
        if (step.loop.on_exhaust !== undefined
            && step.loop.on_exhaust !== "fail"
            && step.loop.on_exhaust !== "continue") {
            return `Error: workflow_file "${location.filePath}" ${location.prefix}`
                + ` loop.on_exhaust must be fail or continue`
        }
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
    try {
        return await loadWorkflowFileUnchecked(baseDir, relPath, vars)
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        return { error: `Error: workflow_file "${relPath}" could not be loaded: ${message}` }
    }
}

async function loadWorkflowFileUnchecked(
    baseDir: string, relPath: string, vars: Record<string, string>,
): Promise<WorkflowFileResult> {
    const resolved = await resolveWorkflowFilePath(baseDir, relPath)
    if ("error" in resolved) return resolved

    const base = normalizeBase(baseDir)

    // Re-verify no symlink traversal immediately before reading.
    // resolveWorkflowFilePath checks the resolved string path, but the gap
    // between that check and this read is a TOCTOU window where a symlink
    // could be installed. The helper walks every ancestor with lstat (no
    // follow), failing closed on any symlink or non-ENOENT lstat error in
    // the chain.
    try {
        await assertNoSymlinkTraversal(base, resolved.filePath)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { error: msg.startsWith("assertNoSymlinkTraversal")
            ? `Error: workflow_file must not be a symlink outside the workspace (${msg})`
            : `Error: workflow_file symlink check failed: ${msg}` }
    }
    const real = resolved.filePath
    if (!isInside(base, real)) {
        return { error: "Error: workflow_file must not be a symlink outside the workspace" }
    }

    let raw: string
    try {
        // O_NOFOLLOW rejects leaf symlinks; O_NONBLOCK prevents a
        // FIFO named .json from blocking open() indefinitely.
        const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
        const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0
        const fh = await fs.open(resolved.filePath, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        try {
            const fileStat = await fh.stat()
            if (!fileStat.isFile()) {
                return { error: `Error: workflow_file "${relPath}" is not a regular file` }
            }
            if (fileStat.size > WORKFLOW_FILE_MAX_BYTES) {
                return {
                    error: `Error: workflow_file "${relPath}" is too large: ${fileStat.size} bytes exceeds the ${WORKFLOW_FILE_MAX_BYTES}-byte limit`,
                }
            }
            // Read with an explicit cap so a concurrent append between the stat
            // check and read cannot bypass the size limit.
            const maxBytes = Math.min(fileStat.size, WORKFLOW_FILE_MAX_BYTES)
            const buffer = Buffer.alloc(maxBytes)
            const { bytesRead } = await fh.read(buffer, 0, maxBytes, 0)
            raw = buffer.subarray(0, bytesRead).toString("utf8")
        } finally {
            await fh.close().catch((err: unknown) => {
                logger.warn("loadWorkflowFile: failed to close workflow file", {
                    filePath: resolved.filePath,
                    error: err instanceof Error ? err.message : String(err),
                })
            })
        }
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

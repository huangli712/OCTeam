/**
 * team_planner tool + planner-session runner.
 *
 * Human-in-the-loop team/workflow authoring:
 *   - op="propose": open ONE oct-metis child session, ask for a tagged
 *     team+workflow JSON block, validate it, and return a preview (no write).
 *   - op="revise": same, but seed the prompt with prior team/workflow + feedback.
 *   - op="write": deterministic validation ONLY (never calls a model), then
 *     persist team.<id>.json + workflow.<id>.json under ctx.directory.
 *
 * The runner (runPlannerSession) owns transport + retry + timeout and extracts
 * JSON strictly from a <team_planner>...</team_planner> tag (prompt-injection
 * safety). Validation is injected as a seam so the runner stays independent of
 * the team/workflow validators. This module reads NO team lifecycle state.
 */

import { existsSync } from "node:fs"
import { unlink, writeFile } from "node:fs/promises"
import path from "node:path"

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { isIndexedMember } from "../../state/resolve.js"
import { validateMemberAgent, validateMemberName } from "../support.js"
import { validateWorkflowSteps } from "../../orchestration/workflow/loader.js"
import { validateWorkflowStepsAgainstMembers } from "./engine.js"

/** Agent name for planner child sessions. */
const PLANNER_AGENT = "oct-metis"

/** Maximum wall-clock wait (ms) for a single planner attempt. */
const PLANNER_TIMEOUT_MS = 300_000

/** Poll interval (ms) while awaiting planner output. */
const PLANNER_POLL_MS = 2_000

/** Number of correction rounds before failing the planner session. */
const PLANNER_MAX_RETRIES = 2

/** Regex for a safe lowercase-slug team_id. */
const TEAM_ID_SLUG = /^[a-z0-9-]+$/

/** Regex to extract the <team_planner> JSON block from assistant output. */
const TEAM_PLANNER_TAG = /<team_planner>([\s\S]*?)<\/team_planner>/

/** The parsed planner payload: the two artifacts the runner returns. */
type PlannerResult = { team: unknown; workflow: unknown }

/**
 * Injected validation seam. Returns the (possibly canonicalized) artifacts on
 * success, or `{ error }` with a message fed back to the planner for a retry.
 */
type PlannerValidate = (parsed: PlannerResult) => PlannerResult | { error: string }

/** Polling configuration for awaiting child session output. */
type PollConfig = { readonly timeoutMs: number; readonly pollMs: number }

/** Options for running a single planner session (team_planner). */
type RunPlannerOptions = {
    teamId: string
    parentSessionId: string
    prompt: string
    validate: PlannerValidate
    timeoutMs: number
    pollMs: number
    maxRetries: number
}

/** Result of evaluating a planner session output: either a parsed result or an error message. */
type EvaluatedOutput = { value: PlannerResult } | { error: string }

/** Type guard: check if a value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Promise-based delay helper. */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Collect the current turn's assistant text. Mirrors captureMemberOutput: scan
 * from the last user message forward, take assistant text parts, skip synthetic
 * parts. Tolerant of the loosely-typed message shape the SDK/test client returns.
 */
function extractAssistantText(raw: unknown): string {
    if (!Array.isArray(raw)) return ""
    let start = 0
    for (let i = raw.length - 1; i >= 0; i -= 1) {
        const msg: unknown = raw[i]
        if (isRecord(msg) && isRecord(msg.info) && msg.info.role === "user") {
            start = i + 1
            break
        }
    }
    const texts: string[] = []
    for (let i = start; i < raw.length; i += 1) {
        const msg: unknown = raw[i]
        if (!isRecord(msg) || !isRecord(msg.info) || msg.info.role !== "assistant") continue
        const parts = msg.parts
        if (!Array.isArray(parts)) continue
        for (const part of parts) {
            if (!isRecord(part)) continue
            if (part.type === "text" && part.synthetic !== true && typeof part.text === "string") {
                texts.push(part.text)
            }
        }
    }
    return texts.join("")
}

/**
 * Extract + validate the tagged planner block. JSON is parsed ONLY from inside
 * <team_planner>...</team_planner>; surrounding prose (including injected,
 * untagged JSON) is never parsed or executed.
 */
function evaluatePlannerOutput(output: string, validate: PlannerValidate): EvaluatedOutput {
    const match = TEAM_PLANNER_TAG.exec(output)
    if (match === null) {
        return {
            error: 'No <team_planner>...</team_planner> block found. Reply with exactly one'
                + ' <team_planner>{"team":...,"workflow":...}</team_planner> block and nothing else.',
        }
    }
    const jsonText = (match[1] ?? "").trim()
    let parsed: unknown
    try {
        parsed = JSON.parse(jsonText)
    } catch {
        return { error: `The content inside <team_planner> was not valid JSON: ${jsonText}` }
    }
    if (!isRecord(parsed) || !("team" in parsed) || !("workflow" in parsed)) {
        return { error: 'The <team_planner> JSON must be an object with "team" and "workflow" keys.' }
    }
    const result = validate({ team: parsed.team, workflow: parsed.workflow })
    if ("error" in result) return { error: result.error }
    return { value: { team: result.team, workflow: result.workflow } }
}

/** Build a re-prompt that tells the planner what was wrong and asks it to try again. */
function buildCorrectionPrompt(error: string): string {
    return (
        `Your previous response was rejected:\n\n${error}`
        + `\n\nReply again with exactly one <team_planner>{"team":...,"workflow":...}</team_planner>`
        + ` block that fixes this problem. Output only that block.`
    )
}

/** Poll the child session until it yields assistant text, or throw on timeout. */
async function pollForAssistantOutput(ctx: PluginContext, childId: string, poll: PollConfig): Promise<string> {
    const deadline = Date.now() + poll.timeoutMs
    for (;;) {
        const res = await ctx.client.session.messages({ path: { id: childId } })
        const output = extractAssistantText(res.data ?? [])
        if (output.trim().length > 0) return output
        if (Date.now() >= deadline) {
            throw new Error("team_planner: timed out waiting for planner output")
        }
        await sleep(poll.pollMs)
    }
}

/**
 * Drive a single oct-metis child session to produce a validated team+workflow.
 * Creates exactly ONE child session, dispatches the prompt, polls for output,
 * and re-prompts the SAME session with the exact error on a missing tag /
 * malformed JSON / validation failure, up to maxRetries corrections.
 */
export async function runPlannerSession(ctx: PluginContext, opts: RunPlannerOptions): Promise<PlannerResult> {
    const created = await ctx.client.session.create({
        body: { parentID: opts.parentSessionId, title: `team_planner/${opts.teamId}` },
        query: { directory: ctx.directory },
    })
    const childId = created.data?.id
    if (!childId) {
        throw new Error("team_planner: session.create returned no child session id")
    }

    const poll: PollConfig = { timeoutMs: opts.timeoutMs, pollMs: opts.pollMs }
    let dispatchText = opts.prompt
    let lastError = ""
    for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
        await ctx.client.session.promptAsync({
            path: { id: childId },
            body: {
                parts: [
                    {
                        type: "text",
                        text: dispatchText,
                        synthetic: false,
                    }
                ],
                agent: PLANNER_AGENT,
            },
            query: { directory: ctx.directory },
        })
        const output = await pollForAssistantOutput(ctx, childId, poll)
        const evaluated = evaluatePlannerOutput(output, opts.validate)
        if ("value" in evaluated) return evaluated.value
        lastError = evaluated.error
        dispatchText = buildCorrectionPrompt(evaluated.error)
    }
    throw new Error(
        `team_planner: planner did not return a valid team/workflow after`
            + ` ${opts.maxRetries + 1} attempt(s). Last error: ${lastError}`,
    )
}

// --- deterministic validation (shared by the validate seam and op=write) ----

/** Validate that team_id is a safe lowercase slug within length bounds. */
function validateTeamId(teamId: string): string | null {
    if (teamId.length < 1 || teamId.length > 64 || !TEAM_ID_SLUG.test(teamId)) {
        return `Error: team_id "${teamId}" must be a safe lowercase slug (lowercase letters, digits, and hyphens only)`
    }
    return null
}

/** Validate team bounds object: numeric fields, maxMembers >= member count. */
function validatePlannerBounds(bounds: unknown, memberCount: number): string | null {
    if (bounds === undefined) return null
    if (!isRecord(bounds)) return "Error: team.bounds must be an object"
    for (const [key, value] of Object.entries(bounds)) {
        if (value !== undefined && typeof value !== "number") {
            return `Error: team.bounds.${key} must be numeric`
        }
    }
    const maxMembers = bounds.maxMembers
    if (typeof maxMembers === "number" && maxMembers < memberCount) {
        return `Error: team.bounds.maxMembers (${maxMembers}) is less than the number of members (${memberCount})`
    }
    return null
}

/**
 * Coerce a write/revise argument to a parsed value. Accepts a JS object
 * (programmatic callers, tests) or a JSON string (natural from LLM tool-call
 * under the unknown() schema). Returns a clear error for malformed input so
 * the caller can surface it as a tool result.
 */
function coerceJsonArg(value: unknown, name: string): { value: unknown } | { error: string } {
    if (value === undefined) return { error: `Error: ${name} is required` }
    if (typeof value === "string") {
        try {
            return { value: JSON.parse(value) }
        } catch (err) {
            return { error: `Error: ${name} is a string but not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
        }
    }
    return { value }
}

/** Validate team_create-args-like shape; returns member names or an error. */
function validatePlannerTeam(teamId: string, team: unknown): { memberNames: string[] } | { error: string } {
    if (!isRecord(team)) return { error: "Error: team must be an object" }
    if (team.name !== teamId) {
        return { error: `Error: team.name must match team_id "${teamId}"` }
    }
    const members = team.members
    if (!Array.isArray(members) || members.length === 0) {
        return { error: "Error: team.members must be a non-empty array of named members" }
    }
    const memberNames: string[] = []
    const seen = new Set<string>()
    for (let i = 0; i < members.length; i += 1) {
        const member: unknown = members[i]
        if (!isRecord(member)) return { error: `Error: team.members[${i}] must be an object` }
        const name = member.name
        if (typeof name !== "string" || name.length === 0) {
            return { error: `Error: team.members[${i}] is missing a member name` }
        }
        const nameError = validateMemberName(name)
        if (nameError) return { error: nameError }
        if (seen.has(name)) return { error: `Error: duplicate member name "${name}"` }
        seen.add(name)
        memberNames.push(name)
        if (member.agent !== undefined) {
            if (typeof member.agent !== "string") return { error: `Error: team.members[${i}] agent must be a string` }
            const agentError = validateMemberAgent(member.agent)
            if (agentError) return { error: agentError }
        }
        if (member.role !== undefined && typeof member.role !== "string") {
            return { error: `Error: team.members[${i}] role must be a string` }
        }
    }
    const boundsError = validatePlannerBounds(team.bounds, memberNames.length)
    if (boundsError) return { error: boundsError }
    return { memberNames }
}

/** Validate a planner-produced workflow: version, strict_vars, steps structure, and member references. */
function validatePlannerWorkflow(teamId: string, workflow: unknown, memberNames: readonly string[]): string | null {
    if (!isRecord(workflow)) return "Error: workflow must be an object"
    if (workflow.version !== undefined && workflow.version !== 1) {
        return "Error: workflow.version must be absent or 1"
    }
    if (workflow.strict_vars !== undefined && typeof workflow.strict_vars !== "boolean") {
        return "Error: workflow.strict_vars must be a boolean"
    }
    const stepsResult = validateWorkflowSteps(workflow.steps)
    if ("error" in stepsResult) return stepsResult.error
    return validateWorkflowStepsAgainstMembers(stepsResult.steps, memberNames, teamId)
}

/** Full deterministic validation of a team_id + team + workflow triple. */
function validatePlannerPayload(teamId: string, team: unknown, workflow: unknown): string | null {
    const teamIdError = validateTeamId(teamId)
    if (teamIdError) return teamIdError
    const teamResult = validatePlannerTeam(teamId, team)
    if ("error" in teamResult) return teamResult.error
    return validatePlannerWorkflow(teamId, workflow, teamResult.memberNames)
}

/** Create a PlannerValidate closure that validates against the given team_id. */
function makePlannerValidate(teamId: string): PlannerValidate {
    return parsed => {
        const error = validatePlannerPayload(teamId, parsed.team, parsed.workflow)
        if (error) return { error }
        return { team: parsed.team, workflow: parsed.workflow }
    }
}

// --- prompt + preview construction ------------------------------------------

/** Build the formatting contract instruction shown to the planner agent. */
function plannerContract(teamId: string): string {
    return [
        "Respond with EXACTLY one block and nothing else:",
        `<team_planner>{"team":{...},"workflow":{...}}</team_planner>`,
        "",
        `- team.name MUST equal "${teamId}".`,
        "- team.members: 1-12 members, each with a preset pool name, a role, and a prompt.",
        "- workflow.steps: task/gate steps. Every member/verifier must be a declared team member,"
            + " and a gate verifier must differ from the task member it verifies.",
        "- Emit raw JSON inside the tag. Do not use markdown fences or add prose.",
    ].join("\n")
}

/** Build the initial propose prompt: goal, constraints, and formatting contract. */
function buildProposePrompt(teamId: string, goal: string, constraints: string | undefined): string {
    const lines = [
        `Design an OpenCode team and a deterministic team_workflow for team "${teamId}".`,
        "",
        `Goal: ${goal}`,
    ]
    if (constraints !== undefined && constraints.length > 0) {
        lines.push(`Constraints: ${constraints}`)
    }
    lines.push("", plannerContract(teamId))
    return lines.join("\n")
}

/** Request shape for the revise planner operation. */
type ReviseRequest = {
    readonly teamId: string
    readonly goal: string
    readonly previousTeam: unknown
    readonly previousWorkflow: unknown
    readonly feedback: string
}

/** Build the revise prompt: goal, feedback, and previous team/workflow as context. */
function buildRevisePrompt(req: ReviseRequest): string {
    return [
        `Revise the OpenCode team and team_workflow for team "${req.teamId}".`,
        "",
        `Goal: ${req.goal}`,
        `Feedback to address: ${req.feedback}`,
        "",
        "Previous team JSON:",
        JSON.stringify(req.previousTeam, null, 2),
        "",
        "Previous workflow JSON:",
        JSON.stringify(req.previousWorkflow, null, 2),
        "",
        plannerContract(req.teamId),
    ].join("\n")
}

/** Derive the team loader filename from a team_id. */
function teamFileName(teamId: string): string {
    return `team.${teamId}.json`
}

/** Derive the workflow loader filename from a team_id. */
function workflowFileName(teamId: string): string {
    return `workflow.${teamId}.json`
}

/** Output artifact: team and workflow data ready for serialization. */
type PlannerArtifact = {
    readonly directory: string
    readonly teamId: string
    readonly team: unknown
    readonly workflow: unknown
}

/** Format an artifact preview string with file paths and JSON dumps. */
function formatArtifact(artifact: PlannerArtifact): string {
    const teamPath = path.join(artifact.directory, teamFileName(artifact.teamId))
    const workflowPath = path.join(artifact.directory, workflowFileName(artifact.teamId))
    return [
        "Target loaders:",
        `- ${teamPath}`,
        `- ${workflowPath}`,
        "",
        `${teamFileName(artifact.teamId)}:`,
        JSON.stringify(artifact.team, null, 4),
        "",
        `${workflowFileName(artifact.teamId)}:`,
        JSON.stringify(artifact.workflow, null, 4),
    ].join("\n")
}

// --- op handlers ------------------------------------------------------------

/** Parsed arguments for the team_planner tool. */
type TeamPlannerArgs = {
    op: "propose" | "revise" | "write"
    team_id: string
    goal?: string
    constraints?: string
    previous_team?: unknown
    previous_workflow?: unknown
    feedback?: string
    team?: unknown
    workflow?: unknown
    dry_run?: boolean
    overwrite?: boolean
}

/** Handle op="propose": validate args, run planner session, return a preview. */
async function runProposeOp(ctx: PluginContext, sessionID: string, args: TeamPlannerArgs): Promise<string> {
    const goal = args.goal
    if (typeof goal !== "string" || goal.length === 0) return "Error: op=propose requires `goal`"
    const constraints = typeof args.constraints === "string" ? args.constraints : undefined
    const result = await runPlannerSession(ctx, {
        teamId: args.team_id,
        parentSessionId: sessionID,
        prompt: buildProposePrompt(args.team_id, goal, constraints),
        validate: makePlannerValidate(args.team_id),
        timeoutMs: PLANNER_TIMEOUT_MS,
        pollMs: PLANNER_POLL_MS,
        maxRetries: PLANNER_MAX_RETRIES,
    })
    const artifact = formatArtifact({
        directory: ctx.directory, teamId: args.team_id,
        team: result.team, workflow: result.workflow,
    })
    return `Proposed team + workflow for "${args.team_id}" (nothing written).`
        + `\n\n${artifact}\n\nReview, then call team_planner op="write" to persist.`
}

/** Handle op="revise": validate args, run planner session with feedback, return a preview. */
async function runReviseOp(ctx: PluginContext, sessionID: string, args: TeamPlannerArgs): Promise<string> {
    const goal = args.goal
    if (typeof goal !== "string" || goal.length === 0) return "Error: op=revise requires `goal`"
    const feedback = args.feedback
    if (typeof feedback !== "string" || feedback.length === 0) return "Error: op=revise requires `feedback`"
    if (args.previous_team === undefined) return "Error: op=revise requires `previous_team`"
    if (args.previous_workflow === undefined) return "Error: op=revise requires `previous_workflow`"
    // Coerce at the boundary: previous_team/workflow may arrive as JSON strings
    // (LLM tool-call) or objects (programmatic callers); strings must be parsed
    // before buildRevisePrompt stringifies them, or the prompt shows escaped JSON.
    const prevTeamCoerced = coerceJsonArg(args.previous_team, "previous_team")
    if ("error" in prevTeamCoerced) return prevTeamCoerced.error
    const prevWorkflowCoerced = coerceJsonArg(args.previous_workflow, "previous_workflow")
    if ("error" in prevWorkflowCoerced) return prevWorkflowCoerced.error
    const result = await runPlannerSession(ctx, {
        teamId: args.team_id,
        parentSessionId: sessionID,
        prompt: buildRevisePrompt({
            teamId: args.team_id,
            goal,
            previousTeam: prevTeamCoerced.value,
            previousWorkflow: prevWorkflowCoerced.value,
            feedback,
        }),
        validate: makePlannerValidate(args.team_id),
        timeoutMs: PLANNER_TIMEOUT_MS,
        pollMs: PLANNER_POLL_MS,
        maxRetries: PLANNER_MAX_RETRIES,
    })
    const artifact = formatArtifact({
        directory: ctx.directory, teamId: args.team_id,
        team: result.team, workflow: result.workflow,
    })
    return `Revised team + workflow for "${args.team_id}" (nothing written).`
        + `\n\n${artifact}\n\nReview, then call team_planner op="write" to persist.`
}

/** Handle op="write": validate payload deterministically, write loaders to disk. */
async function runWriteOp(ctx: PluginContext, args: TeamPlannerArgs): Promise<string> {
    // Coerce at the boundary: LLM tool-call naturally delivers these as JSON
    // strings under the unknown() schema; programmatic callers deliver objects.
    const teamCoerced = coerceJsonArg(args.team, "team")
    if ("error" in teamCoerced) return teamCoerced.error
    const workflowCoerced = coerceJsonArg(args.workflow, "workflow")
    if ("error" in workflowCoerced) return workflowCoerced.error
    const team = teamCoerced.value
    const workflow = workflowCoerced.value

    const validationError = validatePlannerPayload(args.team_id, team, workflow)
    if (validationError) return validationError
    const teamPath = path.join(ctx.directory, teamFileName(args.team_id))
    const workflowPath = path.join(ctx.directory, workflowFileName(args.team_id))
    const artifact = formatArtifact({
        directory: ctx.directory, teamId: args.team_id,
        team, workflow,
    })
    if (args.dry_run === true) {
        return `Validation OK for "${args.team_id}". Dry run — nothing written.\n\n${artifact}`
    }
    if (args.overwrite !== true && (existsSync(teamPath) || existsSync(workflowPath))) {
        return (
            `Error: refusing to overwrite existing loader(s). ${teamFileName(args.team_id)}`
            + ` or ${workflowFileName(args.team_id)} already exists; pass overwrite: true to replace both.`
        )
    }
    await writeFile(teamPath, `${JSON.stringify(team, null, 4)}\n`)
    try {
        await writeFile(workflowPath, `${JSON.stringify(workflow, null, 4)}\n`)
    } catch (err) {
        // Rollback: remove the team loader so we don't leave a half-written pair.
        await unlink(teamPath).catch(() => { /* best-effort rollback */ })
        throw err
    }
    return (
        `Wrote ${teamFileName(args.team_id)} and ${workflowFileName(args.team_id)}`
        + ` under ${ctx.directory}.\n\n${artifact}`
    )
}

/** Plan and persist team definitions and workflows via a child oct-metis session. */
export function teamPlannerTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Master-only planner for authoring a team + team_workflow via an oct-metis child session,"
            + " with a human-in-the-loop propose/revise/write flow. op='propose' generates a"
            + " team+workflow from a goal and returns a preview (writes nothing). op='revise'"
            + " regenerates from previous team/workflow + feedback (writes nothing). op='write'"
            + " performs deterministic validation only (never calls a model) and persists"
            + " team.<team_id>.json + workflow.<team_id>.json; supports dry_run, defaults to"
            + " no-overwrite, and overwrite:true replaces both. Reads no existing team state.",
        args: {
            op: tool.schema.enum(["propose", "revise", "write"]),
            team_id: tool.schema.string().min(1).describe(
                "Safe lowercase slug; the generated team.name must equal it.",
            ),
            goal: tool.schema.string().optional().describe(
                "propose/revise: the objective the team+workflow must accomplish.",
            ),
            constraints: tool.schema.string().optional().describe(
                "propose: optional extra constraints for the planner.",
            ),
            previous_team: tool.schema.unknown().optional().describe("revise: the prior team JSON to revise."),
            previous_workflow: tool.schema.unknown().optional().describe("revise: the prior workflow JSON to revise."),
            feedback: tool.schema.string().optional().describe("revise: what to change about the previous plan."),
            team: tool.schema.unknown().optional().describe("write: the team JSON to validate and persist."),
            workflow: tool.schema.unknown().optional().describe("write: the workflow JSON to validate and persist."),
            dry_run: tool.schema.boolean().optional().describe(
                "write: validate + preview target paths without writing.",
            ),
            overwrite: tool.schema.boolean().optional().describe("write: replace both loaders if they already exist."),
        },
        async execute(args, context) {
            // Master-only: reject an indexed member session BEFORE any planner
            // session is opened or any loader is written.
            if (isIndexedMember(context.sessionID)) {
                return "Error: team_planner is master-only; a team member session cannot run it"
            }
            const teamIdError = validateTeamId(args.team_id)
            if (teamIdError) return teamIdError
            switch (args.op) {
                case "propose":
                    return await runProposeOp(ctx, context.sessionID, args)
                case "revise":
                    return await runReviseOp(ctx, context.sessionID, args)
                case "write":
                    return await runWriteOp(ctx, args)
                default:
                    args.op satisfies never
                    return "Error: unknown team_planner op"
            }
        },
    })
}

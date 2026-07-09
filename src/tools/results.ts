/**
 * team_results / team_result_get tools (roadmap #2).
 *
 * Read-only retrieval of persisted run records (runs/<runId>/record.json + the
 * per-member full outputs runs/<runId>/<member>.md). Both are any-member,
 * read-only (requireActive: false) — like team_details / team_task_get.
 *
 * team_result_get with no run_id returns the LATEST run, directly covering the
 * common "I lost the team_result summary" case.
 */

import fs from "node:fs/promises"

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { truncateOutput } from "../core/utils.js"
import { formatWorkflowMermaid } from "../orchestration/mermaid.js"
import { resolveCallerInTeam } from "../state/resolve.js"
import { listRunRecords, readRunRecord } from "../orchestration/runs.js"
import { runMemberOutputPath, isSafePathSegment } from "../state/paths.js"
import type { RunRecord, WorkflowRunStep } from "../core/types.js"

function workflowTargetLabel(step: WorkflowRunStep): string {
    if (step.targetSteps !== undefined && step.targetSteps.length > 0) {
        return step.targetSteps.length === 1 ? `step ${step.targetSteps[0]}` : `steps ${step.targetSteps.join(", ")}`
    }
    return step.targetStep === undefined ? "nearest task" : `step ${step.targetStep}`
}

function workflowVerdictMetrics(step: WorkflowRunStep): string {
    const metrics: string[] = []
    if (step.score !== undefined) metrics.push(`score=${step.score}`)
    if (step.confidence !== undefined) metrics.push(`confidence=${step.confidence}`)
    if (step.issues !== undefined && step.issues.length > 0) metrics.push(`issues=${step.issues.length}`)
    return metrics.length > 0 ? ` [${metrics.join(", ")}]` : ""
}

/** Per-issue detail lines for a gate step with structured verdict. Severity-sorted
 * (critical > high > medium > low) so the most actionable issues surface first. */
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

function assertNeverWorkflowStepKind(kind: never): never {
    throw new Error(`unhandled WorkflowStepKind: ${String(kind)}`)
}

function formatWorkflowIssueDetail(step: WorkflowRunStep): string {
    const issues = step.issues
    if (!issues || issues.length === 0) return ""
    const sorted = [...issues].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99))
    const lines = sorted.map(issue => {
        const msg = issue.message && issue.message.trim() !== "" ? `: ${issue.message}` : ""
        return `    - [${issue.severity}]${msg}`
    })
    return "\n" + lines.join("\n")
}

/** Per-step static control config tag (for post-run audit). Mirrors the
 * dry_run rendering so a reviewer can see which controls a step declared. */
function workflowStepControlsTag(step: WorkflowRunStep): string {
    const controls: string[] = []
    if (step.approvalBefore) controls.push("approval_before")
    if (step.approvalAfter) controls.push("approval_after")
    if (step.maxOutputBytes !== undefined) controls.push(`max_output_bytes=${step.maxOutputBytes}`)
    return controls.length > 0 ? `  [${controls.join(", ")}]` : ""
}

function workflowStepDurationTag(step: WorkflowRunStep): string {
    return step.durationMs === undefined ? "" : ` duration=${step.durationMs}ms`
}

function workflowFanoutPolicyTag(fanout: NonNullable<WorkflowRunStep["fanout"]>): string {
    const controls: string[] = []
    if (fanout.joinPolicy !== undefined) controls.push(`join_policy=${fanout.joinPolicy}`)
    if (fanout.quorum !== undefined) controls.push(`quorum=${fanout.quorum}`)
    if (fanout.requiredBranchIds !== undefined) controls.push(`required_branches=${fanout.requiredBranchIds.join(",")}`)
    if (fanout.reducerMember !== undefined) controls.push(`reducer_member=${fanout.reducerMember}`)
    return controls.length > 0 ? `  [${controls.join(", ")}]` : ""
}

function formatBranchStatusList(statuses: Record<string, string> | undefined): string {
    if (statuses === undefined) return ""
    const pairs = Object.entries(statuses).map(([branchId, status]) => `${branchId}:${status}`)
    return pairs.length > 0 ? pairs.join(", ") : ""
}

function formatWorkflowBranchLine(fanoutStep: WorkflowRunStep, branchId: string, branchIndex: number): string {
    const range = fanoutStep.fanout?.branchRanges[branchIndex]
    if (range === undefined) throw new Error(`workflow fanout step ${fanoutStep.step} missing branch range ${branchIndex}`)
    const status = fanoutStep.branchStatuses?.[branchId] ?? "pending"
    return `  - Branch ${branchId} [${status}] steps ${range.startIndex + 1}-${range.endIndex + 1}`
}

function formatIndentedOutput(output: string, indent: string): string {
    const text = truncateOutput(output, 1024)
    if (indent === "") return text
    return text.split("\n").map(line => `${indent}  ${line}`).join("\n")
}

function appendWorkflowStepLines(lines: string[], step: WorkflowRunStep, indent: string): void {
    lines.push(`${indent}${formatWorkflowStepLine(step)}`)
    if (step.kind === "task" && step.output) {
        lines.push(formatIndentedOutput(step.output, indent))
    }
}

function formatWorkflowStepLine(step: WorkflowRunStep): string {
    const idTag = step.id ? ` (${step.id})` : ""
    switch (step.kind) {
        case "task": {
            const bytes = step.outputBytes === undefined ? "" : ` (${step.outputBytes} bytes)`
            const state = step.skipped ? " (skipped)" : step.completed ? " (done)" : ""
            return `- Step ${step.step}: [task]${idTag} ${step.dispatchedActor ?? step.member ?? "?"}${state}${bytes}${workflowStepDurationTag(step)}${workflowStepControlsTag(step)}`
        }
        case "gate": {
            const target = workflowTargetLabel(step)
            const attempts = step.attempts && step.attempts > 0 ? ` (${step.attempts} retries)` : ""
            const invalidTag = step.onInvalid && step.onInvalid !== "fail" ? `, on_invalid=${step.onInvalid}${(step.invalidAttempts ?? 0) > 0 ? ` (${step.invalidAttempts})` : ""}` : ""
            const malformedTag = step.onMalformed && step.onMalformed !== "fail" ? `, on_malformed=${step.onMalformed}${(step.malformedAttempts ?? 0) > 0 ? ` (${step.malformedAttempts})` : ""}` : ""
            const jumpTag = (step.jumpCount ?? 0) > 0 ? `, jumps=${step.jumpCount}` : ""
            return `- Step ${step.step}: [gate]${idTag} ${step.dispatchedActor ?? step.verifier ?? "?"} verifies ${target} -> ${step.verdict ?? "pending"}${workflowVerdictMetrics(step)}${attempts}${invalidTag}${malformedTag}${jumpTag}${workflowStepDurationTag(step)}${formatWorkflowIssueDetail(step)}${workflowStepControlsTag(step)}`
        }
        case "fanout": {
            const fanout = step.fanout
            if (fanout === undefined) throw new Error(`workflow fanout step ${step.step} missing fanout metadata`)
            const branchList = fanout.branchIds.length > 0 ? fanout.branchIds.join(", ") : "(none)"
            return `- Step ${step.step}: [fanout]${idTag} branches ${branchList} -> join step ${fanout.joinIndex + 1}${workflowStepDurationTag(step)}${workflowFanoutPolicyTag(fanout)}${workflowStepControlsTag(step)}`
        }
        case "join": {
            const join = step.join
            if (join === undefined) throw new Error(`workflow join step ${step.step} missing join metadata`)
            const statuses = formatBranchStatusList(step.branchStatuses)
            const statusTag = statuses === "" ? "" : ` branches ${statuses}`
            const joinedBytes = step.joinedOutputBytes === undefined ? "" : ` (joined ${step.joinedOutputBytes} bytes)`
            return `- Step ${step.step}: [join]${idTag} fanout step ${join.fanoutIndex + 1}${statusTag}${joinedBytes}${workflowStepDurationTag(step)}${workflowStepControlsTag(step)}`
        }
        default:
            return assertNeverWorkflowStepKind(step.kind)
    }
}

function hasWorkflowBranchTree(steps: readonly WorkflowRunStep[]): boolean {
    return steps.some(step => step.kind === "fanout" || step.kind === "join" || step.branch !== undefined)
}

function formatWorkflowStepLines(steps: readonly WorkflowRunStep[]): string[] {
    if (!hasWorkflowBranchTree(steps)) {
        const lines: string[] = []
        for (const step of steps) appendWorkflowStepLines(lines, step, "")
        return lines
    }

    const lines: string[] = []
    const rendered = new Set<number>()
    for (const step of steps) {
        if (rendered.has(step.index)) continue
        switch (step.kind) {
            case "fanout": {
                appendWorkflowStepLines(lines, step, "")
                const fanout = step.fanout
                if (fanout === undefined) throw new Error(`workflow fanout step ${step.step} missing fanout metadata`)
                for (let branchIndex = 0; branchIndex < fanout.branchIds.length; branchIndex += 1) {
                    const branchId = fanout.branchIds[branchIndex]
                    const range = fanout.branchRanges[branchIndex]
                    if (branchId === undefined || range === undefined) continue
                    lines.push(formatWorkflowBranchLine(step, branchId, branchIndex))
                    for (let branchStepIndex = range.startIndex; branchStepIndex <= range.endIndex; branchStepIndex += 1) {
                        const branchStep = steps[branchStepIndex]
                        if (branchStep === undefined) continue
                        appendWorkflowStepLines(lines, branchStep, "    ")
                        rendered.add(branchStep.index)
                    }
                }
                break
            }
            case "task":
            case "gate":
            case "join":
                appendWorkflowStepLines(lines, step, "")
                break
            default:
                assertNeverWorkflowStepKind(step.kind)
        }
    }
    return lines
}

function formatRunLine(r: RunRecord): string {
    const mode = r.mode ? `/${r.mode}` : ""
    const when = new Date(r.finishedAt).toISOString()
    const members = Object.keys(r.memberOutputs).length
    const winner = r.arena?.winner ? `  winner=${r.arena.winner}` : ""
    return `- ${r.runId}  [${r.type}${mode}] ${r.status}  reason=${r.reason}  ${when}  tokens=${r.tokensUsed}  members=${members}${winner}`
}

/** Arena winner + evaluator-attested scoreboard audit trail (4e). The winner is
 * read VERBATIM from record.arena.winner (selection already happened in the
 * evaluate phase) — never re-derived from the scoreboard here. A scored
 * candidate absent from survivingCandidates is tagged [ineligible] so an
 * errored-but-scored competitor is visibly audited as not eligible to win. */
function formatArenaPreview(arena: NonNullable<RunRecord["arena"]>, reason: string): string {
    const basis = `${arena.scoreDirection} ${arena.winnerMetric}`
    const lines = [
        arena.winner ? `Winner: ${arena.winner} (${basis})` : `Winner: (none) — ${reason} (${basis})`,
        `Evaluator: ${arena.evaluator}`,
    ]
    const surviving = arena.survivingCandidates
    if (surviving !== undefined) lines.push(`Surviving: ${surviving.join(", ")}`)
    for (const s of arena.scoreboard?.scores ?? []) {
        const val = arena.winnerMetric === "score" ? s.score : s.metrics?.[arena.winnerMetric]
        const ineligible = surviving !== undefined && !surviving.includes(s.member) ? " [ineligible]" : ""
        const rationale = s.rationale ? ` — ${s.rationale}` : ""
        lines.push(`- ${s.member}: ${arena.winnerMetric}=${val ?? "n/a"} passed=${s.passed ?? false}${ineligible}${rationale}`)
    }
    return `### arena\n${lines.join("\n")}`
}

export function teamResultsTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "List recent orchestration run records for a team (newest first). Each run is one completed/failed workflow with persisted full outputs. Use team_result_get to fetch a single run's details.",
        args: {
            team_id: tool.schema.string().min(1),
            limit: tool.schema.number().int().min(1).max(50).optional().describe("max runs to return (default 10)"),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id, {
                requireActive: false,
            })
            if (!caller) return "Error: caller is not a member of this team"
            const records = await listRunRecords(caller.directory)
            if (records.length === 0) return `No run records for team "${args.team_id}" yet.`
            const limit = args.limit ?? 10
            const lines = records.slice(0, limit).map(formatRunLine)
            return [`Runs for team "${args.team_id}" (newest first, ${records.length} total):`, ...lines].join("\n")
        },
    })
}

export function teamResultGetTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Get one orchestration run's full record. Omit run_id for the LATEST run (covers 'I lost the summary'). Pass member= to get that member's full untruncated output; otherwise returns metadata + a bounded preview of each member's output.",
        args: {
            team_id: tool.schema.string().min(1),
            run_id: tool.schema.string().optional().describe("run id; omit for the most recent run"),
            member: tool.schema.string().optional().describe("return this member's full output verbatim"),
            format: tool.schema.enum(["text", "mermaid"]).optional().describe("output format; default text"),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id, {
                requireActive: false,
            })
            if (!caller) return "Error: caller is not a member of this team"

            // Path-safety: run_id / member are interpolated into runs/<...> paths.
            // Reject traversal so a caller cannot read another team's records.
            if (args.run_id !== undefined && !isSafePathSegment(args.run_id)) {
                return `Error: invalid run_id "${args.run_id}"`
            }
            if (args.member !== undefined && !isSafePathSegment(args.member)) {
                return `Error: invalid member "${args.member}"`
            }

            let record: RunRecord | null
            if (args.run_id) {
                record = await readRunRecord(caller.directory, args.run_id)
                if (!record) return `Error: run "${args.run_id}" not found for team "${args.team_id}"`
            } else {
                const records = await listRunRecords(caller.directory)
                if (records.length === 0) return `No run records for team "${args.team_id}" yet.`
                record = records[0]
            }

            // member= → return that member's full output verbatim.
            if (args.member) {
                const out = record.memberOutputs[args.member]
                if (!out) {
                    return `Error: member "${args.member}" has no output in run ${record.runId}`
                }
                try {
                    return await fs.readFile(runMemberOutputPath(caller.directory, record.runId, args.member), "utf8")
                } catch {
                    return `Error: output file for "${args.member}" is missing in run ${record.runId}`
                }
            }

            if ((args.format ?? "text") === "mermaid") {
                if (record.workflow === undefined || record.workflow.steps.length === 0) {
                    return `Error: run ${record.runId} has no persisted workflow steps`
                }
                return formatWorkflowMermaid(record.workflow.steps)
            }

            // Otherwise: metadata + bounded per-member previews.
            const mode = record.mode ? `/${record.mode}` : ""
            const header = [
                `Run ${record.runId}`,
                `Team: ${record.teamName}  Type: ${record.type}${mode}  Status: ${record.status}`,
                `Reason: ${record.reason}`,
                `Started: ${new Date(record.startedAt).toISOString()}  Finished: ${new Date(record.finishedAt).toISOString()}`,
                `Tokens: ${record.tokensUsed}  Messages: ${record.messagesSent}`,
            ]
            if (record.consensusReached !== undefined) header.push(`Consensus reached: ${record.consensusReached}`)
            if (record.currentRound !== undefined) header.push(`Rounds: ${record.currentRound}`)

            const previews: string[] = []
            for (const [name, info] of Object.entries(record.memberOutputs)) {
                try {
                    const content = await fs.readFile(
                        runMemberOutputPath(caller.directory, record.runId, name),
                        "utf8",
                    )
                    previews.push(
                        `### ${name} (${info.bytes} bytes)\n${truncateOutput(content, 1024)}\n` +
                            `[full output: team_result_get(team_id="${record.teamName}", run_id="${record.runId}", member="${name}")]`,
                    )
                } catch {
                    previews.push(`### ${name} (${info.bytes} bytes)\n[output file missing]`)
                }
            }

            if (record.tasks && record.tasks.length > 0) {
                const taskLines = record.tasks.map(
                    t => `- [${t.status}] ${t.subject}${t.owner ? ` (@${t.owner})` : ""}`,
                )
                previews.push(`### tasks\n${taskLines.join("\n")}`)
            }

            if (record.workflow && record.workflow.steps.length > 0) {
                const lines = formatWorkflowStepLines(record.workflow.steps)
                previews.push(`### workflow steps\n${lines.join("\n")}`)
            }

            if (record.arena) {
                previews.push(formatArenaPreview(record.arena, record.reason))
            }

            const body = previews.length > 0 ? previews.join("\n\n") : "(no member outputs captured)"
            return `${header.join("\n")}\n\n${body}`
        },
    })
}

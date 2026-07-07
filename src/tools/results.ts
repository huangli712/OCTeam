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

function formatWorkflowStepLine(step: WorkflowRunStep): string {
    const idTag = step.id ? ` (${step.id})` : ""
    if (step.kind === "task") {
        const bytes = step.outputBytes === undefined ? "" : ` (${step.outputBytes} bytes)`
        const state = step.skipped ? " (skipped)" : step.completed ? " (done)" : ""
        return `- Step ${step.step}: [task]${idTag} ${step.member ?? "?"}${state}${bytes}`
    }
    const target = workflowTargetLabel(step)
    const attempts = step.attempts && step.attempts > 0 ? ` (${step.attempts} retries)` : ""
    const invalidTag = step.onInvalid && step.onInvalid !== "fail" ? `, on_invalid=${step.onInvalid}${(step.invalidAttempts ?? 0) > 0 ? ` (${step.invalidAttempts})` : ""}` : ""
    const jumpTag = (step.jumpCount ?? 0) > 0 ? `, jumps=${step.jumpCount}` : ""
    return `- Step ${step.step}: [gate]${idTag} ${step.verifier ?? "?"} verifies ${target} -> ${step.verdict ?? "pending"}${attempts}${invalidTag}${jumpTag}`
}

function formatRunLine(r: RunRecord): string {
    const mode = r.mode ? `/${r.mode}` : ""
    const when = new Date(r.finishedAt).toISOString()
    const members = Object.keys(r.memberOutputs).length
    return `- ${r.runId}  [${r.type}${mode}] ${r.status}  reason=${r.reason}  ${when}  tokens=${r.tokensUsed}  members=${members}`
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
                const lines: string[] = []
                for (const step of record.workflow.steps) {
                    lines.push(formatWorkflowStepLine(step))
                    if (step.kind === "task" && step.output) {
                        lines.push(truncateOutput(step.output, 1024))
                    }
                }
                previews.push(`### workflow steps\n${lines.join("\n")}`)
            }

            const body = previews.length > 0 ? previews.join("\n\n") : "(no member outputs captured)"
            return `${header.join("\n")}\n\n${body}`
        },
    })
}

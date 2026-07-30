/**
 * team_progress tool.
 *
 * Master real-time observability: merges a LIVE snapshot of member states with
 * the run's event TIMELINE (runs/<runId>/events.jsonl). team_details gives a
 * snapshot only; team_result_get gives the post-hoc full record. team_progress
 * answers "where are we, and how did we get here" — mid-run or just after.
 *
 * Read-only, any-member (requireActive: false), like team_details.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"

import type { PluginContext } from "../../core/context.js"
import { formatWorkflowMermaid, type MermaidStepStatus } from "../../orchestration/records/mermaid.js"
import { resolveCallerInTeam } from "../../state/resolve.js"
import { loadTeamState } from "../../state/store.js"
import { listRunRecords, readRunEvents } from "../../orchestration/records/runs.js"
import { isSafePathSegment } from "../../state/paths.js"
import { getActiveWorkflowStepIndices } from "../../orchestration/workflow/dag.js"
import type { RunEvent, WorkflowRunStep, WorkflowStep, WorkflowTask } from "../../core/types.js"
import type { Team } from "../../state/store.js"

/** Join policy tag for the active fanout frontier. */
function activeFanoutJoinPolicy(task: WorkflowTask): string {
    const steps = task.steps ?? []
    for (const index of getActiveWorkflowStepIndices(task)) {
        const branch = steps[index]?.branch
        if (branch === undefined) continue
        const fanoutStep = steps[branch.fanoutIndex]
        const joinPolicy = fanoutStep?.kind === "fanout" ? fanoutStep.fanout.joinPolicy : undefined
        if (joinPolicy !== undefined) return ` join_policy=${joinPolicy}`
    }
    return ""
}

/** Convert live WorkflowStep[] into WorkflowRunStep[] for mermaid rendering. */
function liveStepsToRunSteps(steps: readonly WorkflowStep[]): WorkflowRunStep[] {
    return steps.map((step, index) => {
        const base = {
            index,
            step: index + 1,
            kind: step.kind,
            id: step.id,
            dispatchedActor: step.dispatchedActor,
            skipped: step.skipped,
            completed: step.completed,
            output: step.output,
            startedAt: step.startedAt,
            completedAt: step.completedAt,
            durationMs: step.durationMs,
            inputs: step.inputs,
            exposeOutput: step.exposeOutput,
            branch: step.branch,
            approvalBefore: step.approvalBefore,
            approvalAfter: step.approvalAfter,
            maxOutputBytes: step.maxOutputBytes,
        }
        switch (step.kind) {
            case "task":
                return { ...base, member: step.member }
            case "gate":
                return {
                    ...base,
                    verifier: step.verifier,
                    targetStep: step.targetStepIndex === undefined ? undefined : step.targetStepIndex + 1,
                    targetSteps: step.targetStepIndices?.map(targetIndex => targetIndex + 1),
                    verdict: step.verdict,
                    score: step.score,
                    confidence: step.confidence,
                    issues: step.issues,
                    attempts: step.attempts,
                    onInvalid: step.onInvalid,
                    invalidAttempts: step.invalidAttempts,
                    jumpCount: step.jumpCount,
                }
            case "fanout":
                return { ...base, fanout: step.fanout }
            case "join":
                return { ...base, join: step.join }
        }
    })
}

/** Build a status map (pending/active/done/skipped) by step index. */
function liveStatusByIndex(task: WorkflowTask): Map<number, MermaidStepStatus> {
    const active = new Set(getActiveWorkflowStepIndices(task))
    const statuses = new Map<number, MermaidStepStatus>()
    const steps = task.steps ?? []
    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]
        if (step === undefined) continue
        if (step.skipped === true) {
            statuses.set(index, "skipped")
        } else if (step.completed) {
            statuses.set(index, "done")
        } else if (active.has(index)) {
            statuses.set(index, "active")
        } else {
            statuses.set(index, "pending")
        }
    }
    return statuses
}

/** Elapsed time suffix for a workflow step line. */
function formatWorkflowStepElapsed(step: WorkflowStep | undefined): string {
    if (step?.startedAt === undefined) return ""
    return ` elapsed=${Math.max(0, Date.now() - step.startedAt)}ms`
}

/** One-line frontier indicator for a single active step. */
function formatWorkflowFrontierStep(steps: readonly WorkflowStep[], index: number): string {
    const step = steps[index]
    const branch = step?.branch
    const branchTag = branch === undefined ? "" : `${branch.branchId}: `
    return `${branchTag}step ${index + 1}/${steps.length}${formatWorkflowStepElapsed(step)}`
}

/** Stage description line for a workflow task (frontier or simple progress). */
function formatWorkflowStage(task: WorkflowTask): string {
    const steps = task.steps ?? []
    if (steps.length === 0) return ""
    const activeIndices = getActiveWorkflowStepIndices(task)
    const hasBranchFrontier =
        activeIndices.length > 1 || activeIndices.some(index => steps[index]?.branch !== undefined)
    if (!hasBranchFrontier) {
        return (
            `  step ${task.currentStageIndex + 1}/${steps.length}` +
            `${formatWorkflowStepElapsed(steps[task.currentStageIndex])}`
        )
    }
    return (
        `  frontier ${activeIndices.map(index => formatWorkflowFrontierStep(steps, index)).join(", ")}` +
        `${activeFanoutJoinPolicy(task)}`
    )
}

/** One-line-per-member live snapshot (current state, not history). */
function formatSnapshot(team: Team): string[] {
    const lines: string[] = [`Team: ${team.teamName}  status: ${team.status}`]
    if (team.activeTask) {
        const t = team.activeTask
        const stage = t.type === "workflow"
            ? formatWorkflowStage(t)
            : (t.stages.length > 0 ? `  stage ${t.currentStageIndex + 1}/${t.stages.length}` : "")
        const round = t.currentRound !== undefined ? `  round ${t.currentRound}/${t.maxRounds ?? "-"}` : ""
        lines.push(`Active: ${t.type}${t.mode ? `/${t.mode}` : ""}${stage}${round}  tokens ${t.tokensUsed}`)
        if (t.approvalStage && t.approvalRequest) {
            const req = t.approvalRequest
            const age = Math.max(0, Math.floor((Date.now() - req.requestedAt) / 1000))
            const where = [
                req.stage !== undefined ? `stage ${req.stage}` : "",
                req.round !== undefined ? `round ${req.round}` : "",
            ].filter(Boolean).join(" ")
            lines.push(
                `Awaiting approval: ${req.kind} ${req.id.slice(0, 8)}` +
                    `${where ? ` (${where})` : ""} requested ${age}s ago`,
            )
        }
    } else {
        const lm = team.lastMode
        const lastTokens = lm?.tokensUsed !== undefined ? `  last tokens ${lm.tokensUsed}` : ""
        lines.push(`Active: none${lastTokens}`)
    }
    lines.push("Members:")
    for (const m of team.members) {
        if (m.isMaster) continue
        const tok =
            team.activeTask?.tokensByMember?.[m.name] ??
            team.lastMode?.tokensByMember?.[m.name]
        const err = m.error ? `  "${m.error}"` : ""
        lines.push(
            `  - ${m.name}: ${m.status}` +
                `${m.turnCount ? `  ${m.turnCount} turns` : ""}${tok ? `  tokens ${tok}` : ""}${err}`,
        )
    }
    return lines
}

/** Render the event timeline with times relative to the first event. */
function formatTimeline(events: RunEvent[], runId: string, totalBefore: number): string[] {
    if (events.length === 0) return ["Timeline: (no events yet)"]
    const t0 = events[0].timestamp
    const rel = (ts: number) => `+${((ts - t0) / 1000).toFixed(1)}s`
    const lines = events.map(e => {
        const who = e.member ? ` ${e.member}` : ""
        const extra = [
            e.stage !== undefined ? `stage ${e.stage + 1}` : "",
            e.round !== undefined ? `round ${e.round}` : "",
            e.bytes !== undefined ? `${e.bytes} bytes` : "",
            e.reason ? `— ${e.reason}` : "",
            e.detail ? `(${e.detail})` : "",
        ].filter(Boolean).join(" ")
        return `  [${rel(e.timestamp)}] ${e.kind}${who}${extra ? ` ${extra}` : ""}`
    })
    const shown = events.length
    const header = totalBefore > shown
        ? `Timeline (last ${shown} of ${totalBefore}, run ${runId.slice(0, 8)}…):`
        : `Timeline (${shown} events, run ${runId.slice(0, 8)}…):`
    return [header, ...lines]
}

/** Render a live mermaid diagram for an in-progress workflow, or null. */
function formatLiveWorkflowMermaid(team: Team): string | null {
    const task = team.activeTask
    if (task?.type !== "workflow") return null
    const steps = task.steps ?? []
    if (steps.length === 0) return null
    return formatWorkflowMermaid(liveStepsToRunSteps(steps), liveStatusByIndex(task))
}

/** Show live orchestration progress with member states and event timeline. */
export function teamProgressTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Show a team's live progress: current member states PLUS the run's event timeline " +
                "(dispatched/captured/errored/retry/stage/round/signoff/terminated). " +
                "Use mid-run to see where an orchestration is, or after to review how it unfolded. " +
                "Omit run_id for the active (or latest) run. " +
                "Use format='mermaid' for a live team_workflow graph.",
        args: {
            team_id: tool.schema.string().min(1),
            limit: tool.schema.number().int().min(1).max(200).optional()
                .describe("max events, most-recent kept (default 40)"),
            since: tool.schema.number().int().optional()
                .describe("epoch ms; only events strictly after this (incremental polling)"),
            run_id: tool.schema.string().optional()
                .describe("a specific finished run; omit for the active or latest run"),
            format: tool.schema.enum(["text", "mermaid"]).optional().describe("output format; default text"),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id, {
                requireActive: false,
            })
            if (!caller) return "Error: caller is not a member of this team"

            // Path-safety: run_id is interpolated into runs/<...> paths. Reject
            // traversal so a caller cannot read another team's event timeline.
            if (args.run_id !== undefined && !isSafePathSegment(args.run_id)) {
                return `Error: invalid run_id "${args.run_id}"`
            }

            let team
            try {
                team = await loadTeamState(ctx.storageRoot, caller.teamName, caller.leadSessionId)
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
            }

            if ((args.format ?? "text") === "mermaid") {
                const mermaid = formatLiveWorkflowMermaid(team)
                if (mermaid === null) {
                    return (
                        `Error: team_progress format=mermaid requires an in-progress team_workflow ` +
                        `(no active workflow on team "${args.team_id}")`
                    )
                }
                return mermaid
            }

            // Resolve which run's timeline to read.
            let runId = args.run_id ?? team.activeTask?.runId
            if (!runId) {
                let records
                try {
                    records = await listRunRecords(team.directory)
                } catch (err) {
                    logSwallowed(ctx, "team_progress failed to read run records", err, { team: args.team_id })
                    return `Error: run records for team "${args.team_id}" could not be read: ${err instanceof Error ? err.message : String(err)}`
                }
                runId = records[0]?.runId
            }

            const snapshot = formatSnapshot(team)
            if (!runId) {
                return [...snapshot, "", "Timeline: (no runs yet)"].join("\n")
            }

            let events
            try {
                events = await readRunEvents(team.directory, runId)
            } catch (err) {
                logSwallowed(ctx, "team_progress failed to read run events", err, { team: args.team_id, runId })
                return `Error: events for run "${runId}" could not be read: ${err instanceof Error ? err.message : String(err)}`
            }
            const totalBefore = events.length
            if (args.since !== undefined) {
                const since = args.since
                events = events.filter(e => e.timestamp > since)
            }
            const limit = args.limit ?? 40
            if (events.length > limit) {
                events = events.slice(-limit)
            }

            const timeline = formatTimeline(events, runId, totalBefore)
            return [...snapshot, "", ...timeline].join("\n")
        },
    })
}

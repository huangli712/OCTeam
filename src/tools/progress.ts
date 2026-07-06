/**
 * team_progress tool (roadmap #5).
 *
 * Master real-time observability: merges a LIVE snapshot of member states with
 * the run's event TIMELINE (runs/<runId>/events.jsonl). team_details gives a
 * snapshot only; team_result_get gives the post-hoc full record. team_progress
 * answers "where are we, and how did we get here" — mid-run or just after.
 *
 * Read-only, any-member (requireActive: false), like team_details.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { resolveCallerInTeam } from "../state/resolve.js"
import { loadTeamState } from "../state/store.js"
import { listRunRecords, readRunEvents } from "../orchestration/runs.js"
import { isSafePathSegment } from "../state/paths.js"
import type { RunEvent } from "../core/types.js"
import type { Team } from "../state/store.js"

/** One-line-per-member live snapshot (current state, not history). */
function formatSnapshot(team: Team): string[] {
    const lines: string[] = [`Team: ${team.teamName}  status: ${team.status}`]
    if (team.activeTask) {
        const t = team.activeTask
        const stage = t.stages.length > 0 ? `  stage ${t.currentStageIndex}/${t.stages.length}` : ""
        const round = t.currentRound !== undefined ? `  round ${t.currentRound}/${t.maxRounds ?? "-"}` : ""
        lines.push(`Active: ${t.type}${t.mode ? `/${t.mode}` : ""}${stage}${round}  tokens ${t.tokensUsed}`)
        if (t.approvalStage && t.approvalRequest) {
            const req = t.approvalRequest
            const age = Math.max(0, Math.floor((Date.now() - req.requestedAt) / 1000))
            const where = [
                req.stage !== undefined ? `stage ${req.stage}` : "",
                req.round !== undefined ? `round ${req.round}` : "",
            ].filter(Boolean).join(" ")
            lines.push(`Awaiting approval: ${req.kind} ${req.id.slice(0, 8)}${where ? ` (${where})` : ""} requested ${age}s ago`)
        }
    } else {
        lines.push("Active: none")
    }
    lines.push("Members:")
    for (const m of team.members) {
        if (m.isMaster) continue
        const tok = team.activeTask?.tokensByMember?.[m.name]
        const err = m.error ? `  "${m.error}"` : ""
        lines.push(`  - ${m.name}: ${m.status}${m.turnCount ? `  ${m.turnCount} turns` : ""}${tok ? `  tok ${tok}` : ""}${err}`)
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
            e.stage !== undefined ? `stage ${e.stage}` : "",
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

export function teamProgressTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Show a team's live progress: current member states PLUS the run's event timeline (dispatched/captured/errored/retry/stage/round/signoff/terminated). Use mid-run to see where an orchestration is, or after to review how it unfolded. Omit run_id for the active (or latest) run.",
        args: {
            team_id: tool.schema.string().min(1),
            limit: tool.schema.number().int().min(1).max(200).optional().describe("max events, most-recent kept (default 40)"),
            since: tool.schema.number().int().optional().describe("epoch ms; only events strictly after this (incremental polling)"),
            run_id: tool.schema.string().optional().describe("a specific finished run; omit for the active or latest run"),
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
            } catch {
                return `Error: team "${args.team_id}" not found`
            }

            // Resolve which run's timeline to read.
            let runId = args.run_id ?? team.activeTask?.runId
            if (!runId) {
                const records = await listRunRecords(team.directory)
                runId = records[0]?.runId
            }

            const snapshot = formatSnapshot(team)
            if (!runId) {
                return [...snapshot, "", "Timeline: (no runs yet)"].join("\n")
            }

            let events = await readRunEvents(team.directory, runId)
            const totalBefore = events.length
            if (args.since !== undefined) {
                events = events.filter(e => e.timestamp > args.since!)
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

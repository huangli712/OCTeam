/**
 * team_details tool -- show a team's current status: orchestration progress,
 * member states, and token usage.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"

import type { PluginContext } from "../../core/context.js"
import { loadTeamState } from "../../state/store.js"
import { resolveCallerInTeam } from "../../state/resolve.js"
import { countUnreadMessages } from "../../messaging/mailbox.js"
import { listAllTasks } from "../../state/tasks.js"

/** Show a team's current status, orchestration progress, member states, and token usage. */
export function teamDetailsTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "Show a team's current status: orchestration progress, member states, and token usage.",
        args: {
            team_id: tool.schema.string().min(1),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(
                ctx.storageRoot, context.sessionID, args.team_id, { requireActive: false },
            )
            if (!caller) return "Error: caller is not a member of this team"
            let team
            try {
                team = await loadTeamState(caller.storageRoot, caller.teamName, caller.leadSessionId)
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
            }
            const active = team.activatedAt !== undefined
            const lines: string[] = [
                `Team: ${team.teamName}  status: ${team.status}  active: ${active ? "yes" : "no"}`,
            ]
            if (team.activeTask) {
                const t = team.activeTask
                const activeStr = `Active: ${t.type}${t.mode ? `/${t.mode}` : ""} `
                    + `round ${t.currentRound ?? "-"}/${t.maxRounds ?? "-"}  tokens ${t.tokensUsed}`
                lines.push(activeStr)
                if (t.approvalStage && t.approvalRequest) {
                    const req = t.approvalRequest
                    const where = [
                        req.stage !== undefined ? `stage ${req.stage}` : "",
                        req.round !== undefined ? `round ${req.round}` : "",
                    ].filter(Boolean).join(" ")
                    lines.push(`Awaiting approval: ${req.kind} ${req.id.slice(0, 8)}${where ? ` (${where})` : ""}`)
                }
                // parallel: reduce + signoff policy
                if (t.type === "parallel") {
                    const pol: string[] = []
                    if (t.reducePolicy) {
                        const rubric = t.reduceRubric ? ` (${t.reduceRubric})` : ""
                        const select = t.reduceSelect ? ` (${t.reduceSelect})` : ""
                        pol.push(`reduce: ${t.reducePolicy}${rubric}${select}`)
                    }
                    if (t.signoffPolicy) {
                        let s = `signoff: ${t.signoffPolicy}`
                        if (t.signoffDecider) s += ` (decider: ${t.signoffDecider})`
                        if (t.signoffQuorum !== undefined) s += ` (quorum: ${t.signoffQuorum})`
                        if (t.signoffStage) s += " [in signoff]"
                        pol.push(s)
                    }
                    if (pol.length > 0) lines.push(pol.join("  "))
                }
                // delegate: shared tasklist summary
                if (t.type === "delegate") {
                    try {
                        const tasks = await listAllTasks(team.directory)
                        const by = (s: string) => tasks.filter(x => x.status === s).length
                        lines.push(
                            `Tasks: ${by("completed")} done, ${by("in_progress")} in progress, `
                                + `${by("claimed")} claimed, ${by("pending")} pending (of ${tasks.length})`,
                        )
                    } catch (err) {
                        logSwallowed(ctx, "team_details: tasklist unreadable", err, {}, "debug")
                    }
                }
                // loop: decider + last decision
                if (t.type === "loop") {
                    const p: string[] = []
                    if (t.deciderMember) p.push(`decider: ${t.deciderMember}`)
                    const last = t.decisionHistory[t.decisionHistory.length - 1]
                    if (last) p.push(`last: ${last.decision} (round ${last.round})`)
                    if (t.decisionParseFailures > 0) p.push(`parse failures: ${t.decisionParseFailures}`)
                    if (p.length > 0) lines.push(p.join("  "))
                }
                // consensus: reached flag
                if (t.type === "consensus") {
                    lines.push(`Consensus: ${t.consensusReached ? "reached" : "not reached"}`)
                }
            } else {
                lines.push("Active: none")
            }
            lines.push("Members:")
            const unreadCounts = await Promise.all(
                team.members.map(m => countUnreadMessages(team.directory, m.name)),
            )
            team.members.forEach((m, i) => {
                const unread = unreadCounts[i]
                const modelStr = m.model ? ` (${m.model})` : ""
                const memberLine = `  - ${m.name}: ${m.status}${modelStr}`
                    + `${unread ? ` ${unread} unread` : ""}`
                    + `${m.turnCount ? ` ${m.turnCount} turns` : ""}`
                lines.push(memberLine)
            })
            return lines.join("\n")
        },
    })
}

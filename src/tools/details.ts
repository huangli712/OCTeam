/**
 * team_details tool -- show a team's current status: orchestration progress,
 * member states, and token usage.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { loadTeamState } from "../state/store.js"
import { resolveCallerInTeam } from "../state/resolve.js"
import { countUnreadMessages } from "../messaging/mailbox.js"
import { listAllTasks } from "../state/tasks.js"

export function teamDetailsTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "Show a team's current status: orchestration progress, member states, and token usage.",
        args: {
            team_id: tool.schema.string().min(1),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id, { requireActive: false })
            if (!caller) return "Error: caller is not a member of this team"
            let team
            try {
                team = await loadTeamState(ctx.storageRoot, caller.teamName, caller.leadSessionId)
            } catch {
                return `Error: team "${args.team_id}" not found`
            }
            const active = team.activatedAt !== undefined
            const lines: string[] = [`Team: ${team.teamName}  status: ${team.status}  active: ${active ? "yes" : "no"}`]
            if (team.activeTask) {
                const t = team.activeTask
                lines.push(
                    `Active: ${t.type}${t.mode ? `/${t.mode}` : ""}  round ${t.currentRound ?? "-"}/${t.maxRounds ?? "-"}  tokens ${t.tokensUsed}`,
                )
                // parallel: reduce + signoff policy
                if (t.type === "parallel") {
                    const pol: string[] = []
                    if (t.reducePolicy) pol.push(`reduce: ${t.reducePolicy}${t.reduceRubric ? ` (${t.reduceRubric})` : ""}${t.reduceCriteria ? ` (${t.reduceCriteria})` : ""}`)
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
                        lines.push(`Tasks: ${by("completed")} done, ${by("in_progress")} in progress, ${by("claimed")} claimed, ${by("pending")} pending (of ${tasks.length})`)
                    } catch {
                        // tasklist unreadable — skip
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
            for (const m of team.members) {
                const unread = await countUnreadMessages(team.directory, m.name)
                const modelStr = m.model ? ` (${m.model})` : ""
                lines.push(
                    `  - ${m.name}: ${m.status}${modelStr}${unread ? ` ${unread} unread` : ""}${m.turnCount ? ` ${m.turnCount} turns` : ""}`,
                )
            }
            return lines.join("\n")
        },
    })
}

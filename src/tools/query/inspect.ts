/**
 * team_query tool -- query detailed information about a specific team member.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { loadTeamState, readTeamSpec } from "../../state/store.js"
import { resolveCallerInTeam } from "../../state/resolve.js"
import { safeMemberAgent } from "../../core/role.js"

/** Query detailed information about a specific team member. */
export function teamQueryTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "Query detailed information about a specific team member by name.",
        args: {
            team_id: tool.schema.string().min(1),
            member_name: tool.schema.string().min(1),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id, {
                requireActive: false,
            })
            if (!caller) return "Error: caller is not a member of this team"
            let team
            try {
                team = await loadTeamState(ctx.storageRoot, caller.teamName, caller.leadSessionId)
            } catch {
                return `Error: team "${args.team_id}" not found`
            }
            const member = team.members.find(m => m.name === args.member_name)
            if (!member) return `Error: member "${args.member_name}" not found in team "${args.team_id}"`

            let role: string | undefined
            let prompt: string | undefined
            try {
                const spec = await readTeamSpec(ctx.storageRoot, caller.teamName, caller.leadSessionId)
                const sm = spec?.members.find(m => m.name === args.member_name)
                role = sm?.role
                prompt = sm?.prompt
            } catch {
                // spec unreadable
            }

            const lines: string[] = [
                `Name: ${member.name}`,
                `Role: ${role ?? "unknown"}`,
                `Prompt: ${prompt ?? "unknown"}`,
                `Agent: ${safeMemberAgent(member.agent)}`,
                `Model: ${member.model ?? "unknown"}`,
                `Status: ${member.status}`,
                `Initialized: ${member.initialized}`,
                `Turn count: ${member.turnCount}`,
            ]
            if (member.sessionId) lines.push(`Session ID: ${member.sessionId}`)
            if (member.worktreePath) lines.push(`Worktree: ${member.worktreePath}`)
            if (member.error) lines.push(`Error: ${member.error}`)
            if (team.activeTask?.tokensByMember?.[member.name]) {
                lines.push(`Tokens used: ${team.activeTask.tokensByMember[member.name]}`)
            }
            return lines.join("\n")
        },
    })
}

/**
 * team_remove_member tool -- remove a member from an existing team (live only).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { loadTeamState, readTeamSpec, saveTeamState, writeTeamSpec } from "../state/store.js"
import type { TeamSpec } from "../core/types.js"

export function teamRemoveMemberTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Remove a member from an existing team. Only allowed when team status is \"live\" " +
            "(sessions not yet spawned) and only by the master session. At least 1 member must " +
            "remain after removal.",
        args: {
            team_id: tool.schema.string().min(1),
            member_name: tool.schema.string().min(1),
        },
        async execute(args, context) {
            const pathLeadSessionId = ctx.scope === "project" ? context.sessionID : undefined
            let team
            try {
                team = await loadTeamState(ctx.storageRoot, args.team_id, pathLeadSessionId)
            } catch {
                return `Error: team "${args.team_id}" not found`
            }
            if (team.leadSessionId !== context.sessionID) {
                return "Error: team_remove_member is master-only (only the team's leader can remove members)"
            }
            if (team.status !== "live") {
                return `Error: team "${args.team_id}" status is "${team.status}", not "live". Members can only be removed before sessions are spawned (workflow calls).`
            }

            const stateIdx = team.members.findIndex(m => m.name === args.member_name)
            if (stateIdx === -1) {
                return `Error: member "${args.member_name}" not found in team "${args.team_id}"`
            }
            if (team.members.length <= 1) {
                return `Error: team "${args.team_id}" has only ${team.members.length} member(s). Cannot remove the last member.`
            }

            let spec: TeamSpec | null = null
            try {
                spec = await readTeamSpec(ctx.storageRoot, args.team_id, pathLeadSessionId)
            } catch {
                return `Error: cannot read config for team "${args.team_id}"`
            }
            if (!spec) return `Error: cannot read config for team "${args.team_id}"`
            const specToPersist = spec
            await team.mutex.runExclusive(async () => {
                const specIdx = specToPersist.members.findIndex(m => m.name === args.member_name)
                if (specIdx !== -1) specToPersist.members.splice(specIdx, 1)
                team.members.splice(stateIdx, 1)

                await writeTeamSpec(ctx.storageRoot, specToPersist, pathLeadSessionId)
                await saveTeamState(team)
            })

            return `Member "${args.member_name}" removed from team "${args.team_id}" (${team.members.length} members remaining).`
        },
    })
}

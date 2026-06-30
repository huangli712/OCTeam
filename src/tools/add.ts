/**
 * team_add_member tool -- add a member to an existing team (live status only).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { loadTeamState, readTeamSpec, saveTeamState, writeTeamSpec } from "../state/store.js"
import { normalizeRole, roleAgent } from "../core/role.js"
import type { MemberSpec, MemberState, TeamSpec } from "../core/types.js"
import { MEMBER_NAME_POOL } from "../state/naming.js"

export function teamAddMemberTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Add a member to an existing team. Only allowed when team status is \"live\" " +
            "(sessions not yet spawned) and only by the master session. The new member's " +
            "name is auto-picked from the preset pool if not specified, and must not " +
            "duplicate any existing member in the team.",
        args: {
            team_id: tool.schema.string().min(1),
            name: tool.schema.string().min(1).max(32).regex(/^[a-z0-9-]+$/).optional(),
            role: tool.schema.string().min(1).max(64).regex(/^[a-zA-Z]+$/, "a single English word, letters only, e.g. \"coder\""),
            prompt: tool.schema.string().min(1).max(8192),
            model: tool.schema.string().optional(),
            agent: tool.schema.string().optional(),
            worktree: tool.schema.boolean().optional(),
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
                return "Error: team_add_member is master-only (only the team's leader can add members)"
            }
            if (team.status !== "live") {
                return `Error: team "${args.team_id}" status is "${team.status}", not "live". Members can only be added before sessions are spawned (workflow calls).`
            }
            if (team.members.length >= team.bounds.maxMembers) {
                return `Error: team already has ${team.bounds.maxMembers} members (maximum)`
            }

            let spec: TeamSpec | null = null
            try {
                spec = await readTeamSpec(ctx.storageRoot, args.team_id, pathLeadSessionId)
            } catch {
                return `Error: cannot read config for team "${args.team_id}"`
            }
            if (!spec) return `Error: cannot read config for team "${args.team_id}"`

            // Resolve name: explicit name or auto-pick from pool.
            const existingNames = new Set(team.members.map(m => m.name))
            let memberName: string
            if (args.name) {
                if (args.name === "master" || args.name === "orchestrator") {
                    return `Error: "${args.name}" is a reserved name and cannot be a member name`
                }
                if (!(MEMBER_NAME_POOL as readonly string[]).includes(args.name)) {
                    return `Error: name "${args.name}" is not a preset pool name. Choose one of: ${MEMBER_NAME_POOL.join(", ")}`
                }
                if (existingNames.has(args.name)) {
                    return `Error: name "${args.name}" already exists in team "${args.team_id}"`
                }
                memberName = args.name
            } else {
                const pool = (MEMBER_NAME_POOL as readonly string[]).filter(n => !existingNames.has(n))
                if (pool.length === 0) {
                    return "Error: no available names left in the pool (all taken by existing members)"
                }
                memberName = pool[Math.floor(Math.random() * pool.length)]
            }

            const role = normalizeRole(args.role)
            const agent = args.agent ?? roleAgent(role)
            const newSpec: MemberSpec = {
                name: memberName,
                role,
                prompt: args.prompt,
                agent,
                model: args.model,
                worktree: args.worktree,
            }
            const newState: MemberState = {
                name: memberName,
                status: "pending",
                initialized: false,
                turnCount: 0,
                model: args.model,
                agent,
            }

            const specToPersist = spec
            await team.mutex.runExclusive(async () => {
                specToPersist.members.push(newSpec)
                team.members.push(newState)

                await writeTeamSpec(ctx.storageRoot, specToPersist, pathLeadSessionId)
                await saveTeamState(team)
            })

            return `Member "${memberName}" added to team "${args.team_id}" (${team.members.length} members).`
        },
    })
}

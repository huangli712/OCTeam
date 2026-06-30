/**
 * Team lifecycle tools: member management.
 * team_add_member, team_remove_member, team_rename, team_fix_member.
 * Extracted from the original lifecycle.ts.
 */

import fs from "node:fs/promises"

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { invalidateTeam, listTeamNames, loadTeamState, readTeamSpec, saveTeamState, writeTeamSpec } from "../state/store.js"
import { indexMasterTeam, indexMember, resolveCallerInTeam, setActiveTeam, unindexMasterTeam, unindexSession } from "../state/resolve.js"
import { inboxPath, teamDir } from "../state/paths.js"
import { normalizeRole, roleAgent } from "../core/role.js"
import type { MemberSpec, MemberState, TeamSpec } from "../core/types.js"
import { MEMBER_NAME_POOL } from "../state/naming.js"

export function teamFixMemberTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Modify a team member's name, role, system prompt, and/or agent. new_role must be a preset role (unknown → \"reviewer\", read-only) and re-derives the member's agent unless new_agent is also given. new_name must be a preset pool name. Changing the agent re-resolves the model from the agent registry. Only allowed when the team is not busy and the target member is not running.",
        args: {
            team_id: tool.schema.string().min(1),
            member_name: tool.schema.string().min(1),
            new_name: tool.schema.string().min(1).max(32).regex(/^[a-z0-9-]+$/).optional(),
            new_role: tool.schema.string().min(1).max(64).regex(/^[a-zA-Z]+$/, "a single English word, letters only, e.g. \"coder\"").optional(),
            new_prompt: tool.schema.string().min(1).max(8192).optional(),
            new_agent: tool.schema.string().min(1).optional(),
        },
        async execute(args, context) {
            if (!args.new_name && !args.new_role && !args.new_prompt && !args.new_agent) {
                return "Error: provide at least one of new_name, new_role, new_prompt, or new_agent"
            }
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id, { requireActive: false })
            if (!caller) return "Error: caller is not a member of this team"
            if (!caller.isMaster) return "Error: team_fix_member is master-only (only the team's leader session can modify members)"
            let team
            try {
                team = await loadTeamState(ctx.storageRoot, caller.teamName, caller.leadSessionId)
            } catch {
                return `Error: team "${args.team_id}" not found`
            }
            if (team.status === "busy") {
                return `Error: team "${args.team_id}" is busy. Wait for the workflow to finish before modifying members.`
            }
            const member = team.members.find(m => m.name === args.member_name)
            if (!member) return `Error: member "${args.member_name}" not found in team "${args.team_id}"`
            if (member.status === "running") {
                return `Error: member "${args.member_name}" is currently running. Wait for it to finish before modifying.`
            }

            let spec: TeamSpec | null = null
            try {
                spec = await readTeamSpec(ctx.storageRoot, caller.teamName, caller.leadSessionId)
            } catch { /* best-effort */ }
            const specMember = spec?.members.find(m => m.name === args.member_name)

            // Validate new_name BEFORE taking the lock.
            const renaming = !!(args.new_name && args.new_name !== args.member_name)
            if (renaming) {
                if (!(MEMBER_NAME_POOL as readonly string[]).includes(args.new_name!)) {
                    return `Error: name "${args.new_name}" is not a preset pool name. Choose one of: ${MEMBER_NAME_POOL.join(", ")}`
                }
                if (team.members.some(m => m.name === args.new_name)) {
                    return `Error: name "${args.new_name}" already exists in this team`
                }
            }

            const changes: string[] = []

            await team.mutex.runExclusive(async () => {
                // --- new_name: rename member across state, spec, index, mailbox ---
                if (renaming) {
                    const oldName = member.name
                    member.name = args.new_name!
                    if (specMember) specMember.name = args.new_name!
                    if (member.sessionId) {
                        unindexSession(member.sessionId)
                        indexMember(member.sessionId, team.teamName, args.new_name!, caller.leadSessionId, ctx.storageRoot)
                    }
                    try {
                        await fs.rename(inboxPath(team.directory, oldName), inboxPath(team.directory, args.new_name!))
                    } catch { /* inbox may not exist yet */ }
                    if (team.activeTask) {
                        const at = team.activeTask
                        if (at.tokensByMember[oldName] !== undefined) {
                            at.tokensByMember[args.new_name!] = at.tokensByMember[oldName]
                            delete at.tokensByMember[oldName]
                        }
                        if (at.responses[oldName] !== undefined) {
                            at.responses[args.new_name!] = at.responses[oldName]
                            delete at.responses[oldName]
                        }
                        if (at.type === "loop" && at.deciderMember === oldName) at.deciderMember = args.new_name!
                        for (const s of at.stages) {
                            if (s.member === oldName) s.member = args.new_name!
                        }
                    }
                    changes.push(`name: ${oldName} → ${args.new_name}`)
                }

                // --- new_role: normalize to a preset role ---
                if (args.new_role && specMember) {
                    specMember.role = normalizeRole(args.new_role)
                    changes.push(`role: ${specMember.role}`)
                }

                // --- new_prompt: spec only ---
                if (args.new_prompt && specMember) {
                    specMember.prompt = args.new_prompt
                    changes.push("prompt: updated")
                }

                // --- agent: explicit new_agent wins; otherwise a changed role
                // re-derives the agent. Either way the bound model is re-resolved. ---
                const targetAgent =
                    args.new_agent ?? (args.new_role ? roleAgent(normalizeRole(args.new_role)) : undefined)
                if (targetAgent) {
                    member.agent = targetAgent
                    if (specMember) specMember.agent = targetAgent
                    try {
                        const agentsRes = await ctx.client.app.agents({ query: { directory: ctx.directory } })
                        const entry = (agentsRes.data ?? []).find(a => a.name === targetAgent)
                        if (entry?.model) {
                            const m = `${entry.model.providerID}/${entry.model.modelID}`
                            member.model = m
                            if (specMember) specMember.model = m
                            changes.push(`agent: ${targetAgent}, model: ${m}`)
                        } else {
                            changes.push(`agent: ${targetAgent} (no bound model — model unchanged)`)
                        }
                    } catch {
                        changes.push(`agent: ${targetAgent} (registry unavailable — model unchanged)`)
                    }
                }

                await saveTeamState(team)
                if (spec) await writeTeamSpec(ctx.storageRoot, spec, caller.leadSessionId)
            })

            return `Member "${args.member_name}" updated — ${changes.join("; ")}`
        },
    })
}

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

export function teamRenameTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Rename an existing team. Only allowed when team status is \"live\" " +
            "(sessions not yet spawned) and only by the master session. The new name " +
            "must follow the same format as team creation (lowercase letters, digits, hyphens) " +
            "and must not collide with another team owned by this session.",
        args: {
            team_id: tool.schema.string().min(1),
            new_name: tool.schema
                .string()
                .min(1)
                .max(64)
                .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, hyphens only"),
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
                return "Error: team_rename is master-only (only the team's leader can rename it)"
            }
            if (team.status !== "live") {
                return `Error: team "${args.team_id}" status is "${team.status}", not "live". Teams can only be renamed before sessions are spawned.`
            }
            if (args.team_id === args.new_name) {
                return `Team "${args.team_id}" is already named "${args.new_name}".`
            }
            for (const other of await listTeamNames(ctx.storageRoot, pathLeadSessionId)) {
                if (other === args.new_name) {
                    return `Error: a team named "${args.new_name}" already exists under this session`
                }
            }

            const oldDir = team.directory
            const newDir = teamDir(ctx.storageRoot, args.new_name, pathLeadSessionId)

            let spec: TeamSpec | null = null
            try {
                spec = await readTeamSpec(ctx.storageRoot, args.team_id, pathLeadSessionId)
            } catch { /* best-effort; spec may be absent for old teams */ }

            const wasActive = team.activatedAt !== undefined

            await team.mutex.runExclusive(async () => {
                // Rename directory on disk.
                await fs.rename(oldDir, newDir)

                // Update in-memory state references.
                team.teamName = args.new_name
                team.directory = newDir

                // Evict the old registry cache entry (keyed by oldDir).
                invalidateTeam(oldDir)

                // Update TeamSpec and write to new directory.
                if (spec) {
                    spec = { ...spec, name: args.new_name }
                    await writeTeamSpec(ctx.storageRoot, spec, pathLeadSessionId)
                }

                // Update master index.
                unindexMasterTeam(context.sessionID, oldDir)
                indexMasterTeam(context.sessionID, args.new_name, pathLeadSessionId, ctx.storageRoot, newDir)
                if (wasActive) {
                    setActiveTeam(context.sessionID, newDir)
                }

                // Save state to the new directory.
                await saveTeamState(team)
            })

            return `Team "${args.team_id}" renamed to "${args.new_name}".`
        },
    })
}

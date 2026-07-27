/**
 * team_fix_member tool -- modify a member's name, role, prompt, and/or agent.
 * Changing the agent re-resolves the bound model from the agent registry.
 */

import fs from "node:fs/promises"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { logger } from "../../core/log.js"
import { loadTeamState, readTeamSpec, saveTeamState, writeTeamSpec } from "../../state/store.js"
import { indexMember, resolveCallerInTeam, unindexSession } from "../../state/resolve.js"
import { inboxPath } from "../../state/paths.js"
import { OCTEAM_AGENTS, isOCTeamAgent, normalizeRole, roleAgent } from "../../core/role.js"
import type { TeamSpec } from "../../core/types.js"
import { MEMBER_NAME_POOL } from "../../state/naming.js"

/** Modify a team member's name, role, prompt, or agent. */
export function teamFixMemberTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Modify a team member's name, role, system prompt, and/or agent. new_role must be a preset role "
            + `(unknown → "reviewer", read-only) and re-derives the member's agent unless new_agent is also given. `
            + "new_name must be a preset pool name. Changing the agent re-resolves the model from the agent registry. "
            + "Only allowed when the team is not busy and the target member is not running.",
        args: {
            team_id: tool.schema.string().min(1),
            member_name: tool.schema.string().min(1),
            new_name: tool.schema.string().min(1).max(32).regex(/^[a-z0-9-]+$/).optional(),
            new_role: tool.schema.string().min(1).max(64).regex(
                /^[a-zA-Z]+$/,
                "a single English word, letters only, e.g. \"coder\"",
            ).optional(),
            new_prompt: tool.schema.string().min(1).max(8192).optional(),
            new_agent: tool.schema.string().min(1).optional(),
        },
        async execute(args, context) {
            if (!args.new_name && !args.new_role && !args.new_prompt && !args.new_agent) {
                return "Error: provide at least one of new_name, new_role, new_prompt, or new_agent"
            }
            const caller = await resolveCallerInTeam(
                ctx.storageRoot, context.sessionID, args.team_id, { requireActive: false },
            )
            if (!caller) {
                return "Error: caller is not a member of this team"
            }
            if (!caller.isMaster) {
                return "Error: team_fix_member is master-only (only the team's leader session can modify members)"
            }
            let team
            try {
                team = await loadTeamState(ctx.storageRoot, caller.teamName, caller.leadSessionId)
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
            }
            if (team.status === "busy") {
                return `Error: team "${args.team_id}" is busy. `
                    + `Wait for the workflow to finish before modifying members.`
            }
            const member = team.members.find(m => m.name === args.member_name)
            if (!member) return `Error: member "${args.member_name}" not found in team "${args.team_id}"`
            if (member.status === "running") {
                return `Error: member "${args.member_name}" is currently running. `
                    + `Wait for it to finish before modifying.`
            }

            // Agent override (optional): must be one of OCTeam's hardened oct-*
            // agents. A bare host agent (e.g. "build") would bypass the
            // role->agent permission-hardening chokepoint (role.ts).
            if (args.new_agent !== undefined && !isOCTeamAgent(args.new_agent)) {
                return `Error: agent "${args.new_agent}" is not a hardened oct-* agent. `
                    + `Members must run as one of: ${OCTEAM_AGENTS.join(", ")}. `
                    + `Omit 'new_agent' to derive it from the role.`
            }

            // Validate new_name BEFORE taking the lock.
            const renaming = !!(args.new_name && args.new_name !== args.member_name)
            if (renaming) {
                if (!(MEMBER_NAME_POOL as readonly string[]).includes(args.new_name!)) {
                    return `Error: name "${args.new_name}" is not a preset pool name. `
                        + `Choose one of: ${MEMBER_NAME_POOL.join(", ")}`
                }
                if (team.members.some(m => m.name === args.new_name)) {
                    return `Error: name "${args.new_name}" already exists in this team`
                }
            }

            const changes: string[] = []

            // Pre-fetch agent registry OUTSIDE the mutex — this API call can
            // be slow (network/IPC) and would block all team operations while
            // the mutex is held. Only needed when changing agent/role.
            let agentsList: Array<{ name: string; model?: { providerID: string; modelID: string } }> = []
            const targetAgent = args.new_agent ?? (args.new_role ? roleAgent(normalizeRole(args.new_role)) : undefined)
            if (targetAgent) {
                try {
                    agentsList = (await ctx.client.app.agents({ query: { directory: ctx.directory } })).data ?? []
                } catch {
                    agentsList = []
                }
            }

            let staleState = false
            let renameCollision = false
            let specMissing = false
            await team.mutex.runExclusive(async () => {
                // Revalidate inside the mutex: a concurrent
                // startOrchestration may have flipped status to "busy" since
                // the outside-mutex check at line 43. Refuse rather than
                // modifying members during an active run.
                if (team.status === "busy") {
                    staleState = true
                    return
                }
                // Re-read config.json INSIDE the mutex so concurrent mutators
                // don't clobber each other's spec changes.
                let spec: TeamSpec | null = null
                try {
                    spec = await readTeamSpec(ctx.storageRoot, caller.teamName, caller.leadSessionId)
                } catch (err) {
                    logger.warn("fixmember: failed to read team spec", { teamName: caller.teamName, error: String(err) })
                }
                const specMember = spec?.members.find(m => m.name === args.member_name)

                // Re-check name collision INSIDE the mutex: a concurrent
                // fixmember could have renamed another member to the same
                // new_name since the outside-mutex check at line 88.
                if (renaming && team.members.some(m => m.name === args.new_name && m !== member)) {
                    renameCollision = true
                    return
                }
                // If renaming, the spec must be readable and contain the
                // member — otherwise config.json would retain the old name
                // after rename, creating a state/spec inconsistency.
                if (renaming && !specMember) {
                    specMissing = true
                    return
                }

                // --- H-23: snapshot all fields that will be mutated, for complete rollback ---
                const savedAgent = member.agent
                const savedModel = member.model
                const savedRole = specMember?.role
                const savedPrompt = specMember?.prompt
                const savedSpecModel = specMember?.model

                // --- new_name: rename member across state, spec, index, mailbox ---
                if (renaming) {
                    const newName = args.new_name!
                    const oldName = member.name
                    member.name = newName
                    if (specMember) specMember.name = newName
                    if (member.sessionId) {
                        unindexSession(member.sessionId)
                        indexMember(
                            member.sessionId, team.teamName, newName,
                            caller.leadSessionId, ctx.storageRoot,
                        )
                    }
                    try {
                        await fs.rename(inboxPath(team.directory, oldName), inboxPath(team.directory, newName))
                    } catch (err) {
                        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                            changes.push(`warning: mailbox rename failed (${err instanceof Error ? err.message : String(err)})`)
                        }
                    }
                    if (team.activeTask) {
                        const at = team.activeTask
                        if (at.tokensByMember[oldName] !== undefined) {
                            at.tokensByMember[newName] = at.tokensByMember[oldName]
                            delete at.tokensByMember[oldName]
                        }
                        if (at.responses[oldName] !== undefined) {
                            at.responses[newName] = at.responses[oldName]
                            delete at.responses[oldName]
                        }
                        if (at.type === "loop" && at.deciderMember === oldName) at.deciderMember = newName
                        for (const s of at.stages) {
                            if (s.member === oldName) s.member = newName
                        }
                    }
                    changes.push(`name: ${oldName} → ${newName}`)
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
                // re-derives the agent. The agent registry was pre-fetched outside the mutex.
                if (targetAgent) {
                    member.agent = targetAgent
                    if (specMember) specMember.agent = targetAgent
                    const entry = agentsList.find(a => a.name === targetAgent)
                    if (entry?.model) {
                        const m = `${entry.model.providerID}/${entry.model.modelID}`
                        member.model = m
                        if (specMember) specMember.model = m
                        changes.push(`agent: ${targetAgent}, model: ${m}`)
                    } else if (agentsList.length > 0) {
                        changes.push(`agent: ${targetAgent} (no bound model — model unchanged)`)
                    } else {
                        changes.push(`agent: ${targetAgent} (registry unavailable — model unchanged)`)
                    }
                }

                // Write spec FIRST so that if saveTeamState fails, the
                // disk state.json (runtime source of truth) retains the old
                // values while config.json has the new ones — strictly better
                // than the reverse where state.json is ahead of config.json.
                const writeErr = await (async () => {
                    if (spec) await writeTeamSpec(ctx.storageRoot, spec, caller.leadSessionId)
                    await saveTeamState(team)
                    return null
                })().catch(e => e as Error)

                if (writeErr) {
                    // Rollback snapshot — capture ALL mutated fields BEFORE any
                    // write attempt so we can restore them atomically on failure.
                    // H-23: the pre-fix code restored rename-related fields but
                    // left agent/role/model mutations in place, so a saveTeamState
                    // failure left the in-memory object with agent/model changes
                    // that the next unrelated save would silently persist.
                    if (renaming) {
                        const newName = args.new_name!
                        const oldName = member.name === newName ? args.member_name : newName
                        // Restore member name
                        member.name = args.member_name
                        if (specMember) specMember.name = args.member_name
                        // Restore index
                        if (member.sessionId) {
                            unindexSession(member.sessionId)
                            indexMember(
                                member.sessionId, team.teamName, args.member_name,
                                caller.leadSessionId, ctx.storageRoot,
                            )
                        }
                        // Restore activeTask references
                        if (team.activeTask) {
                            const at = team.activeTask
                            if (at.tokensByMember[newName] !== undefined) {
                                at.tokensByMember[oldName] = at.tokensByMember[newName]
                                delete at.tokensByMember[newName]
                            }
                            if (at.responses[newName] !== undefined) {
                                at.responses[oldName] = at.responses[newName]
                                delete at.responses[newName]
                            }
                            if (at.type === "loop" && at.deciderMember === newName) at.deciderMember = oldName
                            for (const s of at.stages) {
                                if (s.member === newName) s.member = oldName
                            }
                        }
                        // Attempt to revert mailbox rename (best-effort)
                        try {
                            await fs.rename(
                                inboxPath(team.directory, newName),
                                inboxPath(team.directory, args.member_name),
                            )
                        } catch {
                            // Mailbox may not exist or rename fails; not critical
                        }
                    }
                    // H-23: restore agent/model mutations too. Pre-fix code left
                    // these as-is, so the in-memory object diverged from disk
                    // after a save failure, and a subsequent unrelated save
                    // would persist the unwanted agent/model change.
                    if (savedAgent !== undefined) member.agent = savedAgent
                    if (savedModel !== undefined) member.model = savedModel
                    if (specMember) {
                        if (savedAgent !== undefined) specMember.agent = savedAgent
                        if (savedRole !== undefined) specMember.role = savedRole
                        if (savedPrompt !== undefined) specMember.prompt = savedPrompt
                        if (savedSpecModel !== undefined) specMember.model = savedSpecModel
                    }
                    throw writeErr
                }
            })

            if (staleState) {
                return `Error: team "${args.team_id}" is busy. `
                    + `Wait for the workflow to finish before modifying members.`
            }
            if (renameCollision) {
                return `Error: name "${args.new_name}" already exists in this team`
            }
            if (specMissing) {
                return `Error: cannot rename member — team config (config.json) is unreadable or member absent from spec`
            }

            return `Member "${args.member_name}" updated — ${changes.join("; ")}`
        },
    })
}

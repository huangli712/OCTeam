/**
 * Team lifecycle tools: team_create, team_delete, team_list, team_details, team_query, team_fix.
 * (design §4.1, §4.10, §4.11)
 */

import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../context.js"
import { deleteTeamStorage, initTeamState, invalidateTeam, listTeamNames, loadTeamState, readTeamSpec, saveTeamState, writeTeamSpec } from "../state/store.js"
import { indexMember, indexMaster, isIndexedMember, resolveCallerInTeam, unindexSession } from "../utils.js"
import { countUnreadMessages } from "../mailbox.js"
import { clearWakeHint } from "../wake-hint.js"
import { inboxPath } from "../state/paths.js"
import type { Bounds, MemberState, MemberSpec, TeamSpec } from "../types.js"

const execFileP = promisify(execFile)

/**
 * Best-effort git worktree teardown. Removes the worktree registration + files
 * for a member that was created with worktree: true. Must run BEFORE the team
 * directory is deleted, while the worktree files still exist on disk.
 */
async function cleanWorktree(
    projectDir: string,
    worktreePath: string | undefined,
): Promise<void> {
    if (!worktreePath) return
    await execFileP("git", ["worktree", "remove", worktreePath, "--force"], {
        cwd: projectDir,
    }).catch(() => {
        // best effort
    })
}

/** Resource bounds with design defaults (§8.1), overridden by user input. */
function defaultBounds(override?: Partial<Bounds>): Bounds {
    return {
        maxMembers: 8,
        maxParallelMembers: 4,
        maxMessagesPerRun: 100,
        maxWallClockMinutes: 30,
        maxMemberTurns: 50,
        maxTasks: 200,
        messagePayloadMaxBytes: 32768,
        messageUnreadMaxBytes: 1048576,
        ...override,
    }
}

/**
 * Derive a reasonable agent from a member's role text. Ordered FIRST-hit
 * substring match (case-insensitive). NOTE: "research" must be checked before
 * "search" — "research" contains the substring "search".
 */
function deriveAgent(role: string): string {
    const r = role.toLowerCase()
    if (r.includes("research") || r.includes("研究")) return "explore"
    if (r.includes("find") || r.includes("search") || r.includes("查")) return "librarian"
    if (r.includes("review") || r.includes("architect") || r.includes("审查") || r.includes("架构")) return "oracle"
    if (r.includes("implement") || r.includes("write") || r.includes("实现") || r.includes("写")) return "build"
    return "build"
}

export function teamCreateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Define an agent team. Writes config.json + initial state.json. Does NOT spawn member sessions — they are spawned lazily on the first workflow call (team_parallel/pipeline/loop/delegate). The calling session becomes the team leader (\"master\").",
        args: {
            name: tool.schema
                .string()
                .min(1)
                .max(64)
                .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, hyphens only"),
            description: tool.schema.string().max(2048).optional(),
            members: tool.schema
                .array(
                    tool.schema.object({
                        name: tool.schema.string().min(1).max(32).regex(/^[a-z0-9-]+$/),
                        role: tool.schema.string().min(1).max(2048),
                        model: tool.schema.string().optional(),
                        agent: tool.schema.string().optional(),
                        worktree: tool.schema.boolean().optional(),
                    }),
                )
                .min(1)
                .max(8),
            bounds: tool.schema
                .object({
                    maxMembers: tool.schema.number().min(1).optional(),
                    maxParallelMembers: tool.schema.number().min(1).optional(),
                    maxMessagesPerRun: tool.schema.number().min(1).optional(),
                    maxWallClockMinutes: tool.schema.number().min(1).optional(),
                    maxMemberTurns: tool.schema.number().min(1).optional(),
                    maxTasks: tool.schema.number().min(1).optional(),
                })
                .optional(),
        },
        async execute(args, context) {
            // A member (child) session must not create its own team: indexMaster
            // below would overwrite its member index entry, orphaning its original
            // team and escalating it to master of a new team.
            if (isIndexedMember(context.sessionID)) {
                return "Error: a team member session cannot create a team"
            }

            const names = new Set<string>()
            for (const m of args.members) {
                // "master" and "orchestrator" are reserved synthetic identities
                // (the leader pseudo-member and the orchestrator message sender);
                // a real member by either name would collide with them.
                if (m.name === "master" || m.name === "orchestrator") {
                    return `Error: "${m.name}" is a reserved name and cannot be a member name`
                }
                if (names.has(m.name)) return `Error: duplicate member name "${m.name}"`
                names.add(m.name)
            }

            // Session scoping: project-scope teams are stored under
            // <storageRoot>/<leadSessionId>/teams/<name>/; user-scope teams stay
            // flat (<userStorageRoot>/teams/<name>/). leadSessionId is undefined
            // for user scope.
            const leadSessionId = ctx.scope === "project" ? context.sessionID : undefined

            // M4: refuse if this session already leads a non-terminal team. One
            // interactive session drives one active team at a time (§252); otherwise
            // indexMaster below would silently overwrite the prior team's master
            // index and orphan its result delivery.
            for (const other of await listTeamNames(ctx.storageRoot, leadSessionId)) {
                if (other === args.name) continue
                try {
                    const t = await loadTeamState(ctx.storageRoot, other, leadSessionId)
                    if (
                        t.leadSessionId === context.sessionID
                        && (t.status === "live" || t.status === "busy" || t.status === "idle")
                    ) {
                        return `Error: this session already leads team "${other}" (status ${t.status}). Shut it down or delete it before creating another team.`
                    }
                } catch {
                    // unreadable team state — ignore
                }
            }

            // Auto-assign agent + model for members that omitted them. The agent
            // is derived from the role text; the model is resolved from the
            // opencode agent registry (client.app.agents) or the global default.
            const modelByAgent = new Map<string, string | undefined>()
            try {
                const agentsRes = await ctx.client.app.agents({ query: { directory: ctx.directory } })
                for (const a of agentsRes.data ?? []) {
                    if (a.model) modelByAgent.set(a.name, `${a.model.providerID}/${a.model.modelID}`)
                }
            } catch {
                // best-effort — members fall back to no explicit model
            }
            let defaultModel: string | undefined
            try {
                defaultModel = (await ctx.client.config.get()).data?.model
            } catch {
                // best-effort — build/agents with no model use the provider default
            }
            // Final fallback: the leader session's active model (from its most
            // recent assistant message). Covers the built-in "build" agent which
            // has no explicit model and inherits whatever the leader session uses.
            let sessionModel: string | undefined
            try {
                const msgsRes = await ctx.client.session.messages({
                    path: { id: context.sessionID },
                    query: { directory: ctx.directory, limit: 10 },
                })
                const msgs = msgsRes.data ?? []
                for (let i = msgs.length - 1; i >= 0; i--) {
                    const info = msgs[i].info
                    if (info.role === "assistant") {
                        sessionModel = `${info.providerID}/${info.modelID}`
                        break
                    }
                }
            } catch {
                // best-effort
            }
            const resolved: MemberSpec[] = args.members.map(m => {
                const agent = m.agent ?? deriveAgent(m.role)
                const model = m.model ?? modelByAgent.get(agent) ?? defaultModel ?? sessionModel
                return { name: m.name, role: m.role, agent, model, worktree: m.worktree }
            })

            const now = Date.now()
            const spec: TeamSpec = {
                version: 1,
                name: args.name,
                description: args.description,
                createdAt: now,
                members: resolved,
            }
            await writeTeamSpec(ctx.storageRoot, spec, leadSessionId)

            const members: MemberState[] = resolved.map(m => ({
                name: m.name,
                status: "pending",
                initialized: false,
                turnCount: 0,
                model: m.model,
                agent: m.agent,
            }))

            await initTeamState(ctx.storageRoot, {
                version: 1,
                teamRunId: crypto.randomUUID(),
                teamName: args.name,
                status: "live",
                leadSessionId: context.sessionID,
                members,
                bounds: defaultBounds(args.bounds),
                createdAt: now,
            }, leadSessionId)

            // Index the leader session as master so its mailbox (queued team
            // results) can be drained by the event handler / Transform hook.
            indexMaster(context.sessionID, args.name, leadSessionId, ctx.storageRoot)

            return `Team "${args.name}" created with ${members.length} member(s): ${members.map(m => m.name).join(", ")}. Status: live. Sessions will spawn on first workflow call.`
        },
    })
}

export function teamListTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "List all teams in the current scope with their status and member count.",
        args: {},
        async execute(_args, context) {
            // Project scope: only teams owned by the current session are visible.
            const leadSessionId = ctx.scope === "project" ? context.sessionID : undefined
            const names = await listTeamNames(ctx.storageRoot, leadSessionId)
            if (names.length === 0) return "No teams found."
            const rows = await Promise.all(
                names.map(async name => {
                    const spec = await readTeamSpec(ctx.storageRoot, name, leadSessionId)
                    let status = "unknown"
                    let count = spec?.members.length ?? 0
                    try {
                        const team = await loadTeamState(ctx.storageRoot, name, leadSessionId)
                        status = team.status
                        count = team.members.length
                    } catch {
                        // state unreadable
                    }
                    return `- ${name}: ${status} (${count} member${count === 1 ? "" : "s"})`
                }),
            )
            return rows.join("\n")
        },
    })
}

export function teamDetailsTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "Show a team's current status: orchestration progress, member states, and token usage.",
        args: {
            team_id: tool.schema.string().min(1),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller) return "Error: caller is not a member of this team"
            let team
            try {
                team = await loadTeamState(ctx.storageRoot, caller.teamName, caller.leadSessionId)
            } catch {
                return `Error: team "${args.team_id}" not found`
            }
            const lines: string[] = [`Team: ${team.teamName}  status: ${team.status}`]
            if (team.activeTask) {
                const t = team.activeTask
                lines.push(
                    `Active: ${t.type}${t.mode ? `/${t.mode}` : ""}  round ${t.currentRound ?? "-"}/${t.maxRounds ?? "-"}  tokens ${t.tokensUsed}`,
                )
            } else {
                lines.push("Active: none")
            }
            lines.push("Members:")
            for (const m of team.members) {
                // P2: unread is computed from the mailbox file on read (no persisted
                // counter to drift); reserved/in-flight messages are excluded.
                const unread = await countUnreadMessages(team.directory, m.name)
                lines.push(
                    `  - ${m.name}: ${m.status}${m.model ? ` (${m.model.split("/").pop()})` : ""}${unread ? ` ${unread} unread` : ""}${m.turnCount ? ` ${m.turnCount} turns` : ""}`,
                )
            }
            return lines.join("\n")
        },
    })
}

export function teamQueryTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "Query detailed information about a specific team member by name.",
        args: {
            team_id: tool.schema.string().min(1),
            member_name: tool.schema.string().min(1),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller) return "Error: caller is not a member of this team"
            let team
            try {
                team = await loadTeamState(ctx.storageRoot, caller.teamName, caller.leadSessionId)
            } catch {
                return `Error: team "${args.team_id}" not found`
            }
            const member = team.members.find(m => m.name === args.member_name)
            if (!member) return `Error: member "${args.member_name}" not found in team "${args.team_id}"`

            // Role lives in the spec (config.json), not in runtime state.
            let role: string | undefined
            try {
                const spec = await readTeamSpec(ctx.storageRoot, caller.teamName, caller.leadSessionId)
                role = spec?.members.find(m => m.name === args.member_name)?.role
            } catch {
                // spec unreadable
            }

            const lines: string[] = [
                `Name: ${member.name}`,
                `Role: ${role ?? "unknown"}`,
                `Agent: ${member.agent ?? "build"}`,
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

export function teamFixTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Modify a team member's name, role, and/or agent. Changing the agent automatically updates the model to the agent's bound model (if one exists in the agent registry). Only allowed when the team is not busy.",
        args: {
            team_id: tool.schema.string().min(1),
            member_name: tool.schema.string().min(1),
            new_name: tool.schema.string().min(1).max(32).regex(/^[a-z0-9-]+$/).optional(),
            new_role: tool.schema.string().min(1).max(2048).optional(),
            new_agent: tool.schema.string().min(1).optional(),
        },
        async execute(args, context) {
            if (!args.new_name && !args.new_role && !args.new_agent) {
                return "Error: provide at least one of new_name, new_role, or new_agent"
            }
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller) return "Error: caller is not a member of this team"
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

            let spec: TeamSpec | null = null
            try {
                spec = await readTeamSpec(ctx.storageRoot, caller.teamName, caller.leadSessionId)
            } catch { /* best-effort */ }
            const specMember = spec?.members.find(m => m.name === args.member_name)

            const changes: string[] = []

            // --- new_name: rename member across state, spec, index, mailbox ---
            if (args.new_name && args.new_name !== args.member_name) {
                if (team.members.some(m => m.name === args.new_name)) {
                    return `Error: name "${args.new_name}" already exists in this team`
                }
                const oldName = member.name
                member.name = args.new_name
                if (specMember) specMember.name = args.new_name
                if (member.sessionId) {
                    unindexSession(member.sessionId)
                    indexMember(member.sessionId, team.teamName, args.new_name, caller.leadSessionId, ctx.storageRoot)
                }
                try {
                    await fs.rename(inboxPath(team.directory, oldName), inboxPath(team.directory, args.new_name))
                } catch { /* inbox may not exist yet */ }
                if (team.activeTask) {
                    const at = team.activeTask
                    if (at.tokensByMember[oldName] !== undefined) {
                        at.tokensByMember[args.new_name] = at.tokensByMember[oldName]
                        delete at.tokensByMember[oldName]
                    }
                    if (at.responses[oldName] !== undefined) {
                        at.responses[args.new_name] = at.responses[oldName]
                        delete at.responses[oldName]
                    }
                    if (at.deciderMember === oldName) at.deciderMember = args.new_name
                    for (const s of at.stages) {
                        if (s.member === oldName) s.member = args.new_name
                    }
                }
                changes.push(`name: ${oldName} → ${args.new_name}`)
            }

            // --- new_role: spec only (role is a config field) ---
            if (args.new_role && specMember) {
                specMember.role = args.new_role
                changes.push("role: updated")
            }

            // --- new_agent: update spec + state, auto-resolve bound model ---
            if (args.new_agent) {
                member.agent = args.new_agent
                if (specMember) specMember.agent = args.new_agent
                try {
                    const agentsRes = await ctx.client.app.agents({ query: { directory: ctx.directory } })
                    const entry = (agentsRes.data ?? []).find(a => a.name === args.new_agent)
                    if (entry?.model) {
                        const m = `${entry.model.providerID}/${entry.model.modelID}`
                        member.model = m
                        if (specMember) specMember.model = m
                        changes.push(`agent: ${args.new_agent}, model: ${m}`)
                    } else {
                        changes.push(`agent: ${args.new_agent} (no bound model — model unchanged)`)
                    }
                } catch {
                    changes.push(`agent: ${args.new_agent} (registry unavailable — model unchanged)`)
                }
            }

            await saveTeamState(team)
            if (spec) await writeTeamSpec(ctx.storageRoot, spec, caller.leadSessionId)

            return `Member "${args.member_name}" updated — ${changes.join("; ")}`
        },
    })
}

export function teamDeleteTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Delete a team. Without force, refuses while the team is busy with an active orchestration. With force, removes on-disk state immediately (member worktrees are cleaned up; sessions stay in OpenCode history; running agents finish their current turn but receive no further dispatch).",
        args: {
            team_id: tool.schema.string().min(1),
            force: tool.schema.boolean().optional(),
        },
        async execute(args, context) {
            // team_delete bypasses sessionIndex and reads team state directly
            // from disk. sessionIndex maps sessionID -> {teamName} 1:1, so
            // creating a second team in the same session (allowed by M4 when the
            // prior team is failed) overwrites the prior team's index
            // entry. Without this bypass, orphaned teams cannot be cleaned up
            // because resolveCallerInTeam returns null.
            const pathLeadSessionId = ctx.scope === "project" ? context.sessionID : undefined
            let team
            try {
                team = await loadTeamState(ctx.storageRoot, args.team_id, pathLeadSessionId)
            } catch {
                return `Error: team "${args.team_id}" not found`
            }
            if (team.leadSessionId !== context.sessionID) {
                return "Error: team_delete is master-only (only the team's leader session can delete it)"
            }
            const force = args.force ?? false
            if (!force && team.status === "busy") {
                return `Error: team "${args.team_id}" is busy with an active orchestration. Wait for it to finish, or re-run with force: true.`
            }
            // Clean up worktrees, then unindex all known sessions (and drop their
            // wake-hint throttle entries, L1). Worktree teardown must precede
            // deleteTeamStorage so git can remove the still-present worktree files.
            for (const m of team.members) {
                await cleanWorktree(ctx.directory, m.worktreePath)
                if (m.sessionId) {
                    unindexSession(m.sessionId)
                    clearWakeHint(m.sessionId)
                }
            }
            unindexSession(team.leadSessionId)
            clearWakeHint(team.leadSessionId)
            await deleteTeamStorage(ctx.storageRoot, args.team_id, pathLeadSessionId)
            invalidateTeam(team.directory)
            return `Team "${args.team_id}" deleted${force ? " (forced)" : ""}.`
        },
    })
}

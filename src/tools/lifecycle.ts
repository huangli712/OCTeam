/**
 * Team lifecycle tools: team_create, team_delete, team_list, team_status.
 * (design §4.1, §4.10, §4.11)
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../context.js"
import { deleteTeamStorage, initTeamState, invalidateTeam, listTeamNames, loadTeamState, readTeamSpec, writeTeamSpec } from "../state/store.js"
import { indexMaster, isIndexedMember, resolveCallerInTeam, unindexSession } from "../utils.js"
import { countUnreadMessages } from "../mailbox.js"
import { clearWakeHint } from "../wake-hint.js"
import type { Bounds, RuntimeMember, TeamMemberSpec, TeamSpec } from "../types.js"

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
            const resolved: TeamMemberSpec[] = args.members.map(m => {
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

            const members: RuntimeMember[] = resolved.map(m => ({
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

export function teamStatusTool(ctx: PluginContext): ToolDefinition {
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

export function teamDeleteTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Delete a team. Without force, requires all members to be shutdown_approved/completed. With force, removes on-disk state immediately (sessions stay in OpenCode history; running agents finish their current turn but receive no further dispatch).",
        args: {
            team_id: tool.schema.string().min(1),
            force: tool.schema.boolean().optional(),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller?.isMaster) {
                return "Error: team_delete is master-only (only the team's leader session can delete it)"
            }
            let team
            try {
                team = await loadTeamState(ctx.storageRoot, caller.teamName, caller.leadSessionId)
            } catch {
                return `Error: team "${args.team_id}" not found`
            }
            const force = args.force ?? false
            if (!force) {
                const busy = team.members.filter(
                    m => m.status !== "shutdown_approved" && m.status !== "completed" && m.sessionId,
                )
                if (busy.length > 0) {
                    return `Error: ${busy.length} member(s) still active (${busy.map(m => m.name).join(", ")}). Use team_shutdown_request first, or re-run with force: true.`
                }
            }
            // Unindex all known sessions (and drop their wake-hint throttle entries, L1).
            for (const m of team.members) {
                if (m.sessionId) {
                    unindexSession(m.sessionId)
                    clearWakeHint(m.sessionId)
                }
            }
            unindexSession(team.leadSessionId)
            clearWakeHint(team.leadSessionId)
            await deleteTeamStorage(ctx.storageRoot, args.team_id, caller.leadSessionId)
            invalidateTeam(team.directory)
            return `Team "${args.team_id}" deleted${force ? " (forced)" : ""}.`
        },
    })
}

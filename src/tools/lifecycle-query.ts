/**
 * Team lifecycle tools: creation + read-only inspection.
 * team_create, team_list, team_details, team_query.
 * Extracted from the original lifecycle.ts.
 */

import fs from "node:fs/promises"

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { initTeamState, listTeamNames, loadTeamState, readTeamSpec, writeTeamSpec } from "../state/store.js"
import { indexMasterTeam, isIndexedMember, resolveCallerInTeam } from "../state/resolve.js"
import { countUnreadMessages } from "../messaging/mailbox.js"
import { teamDir, teamsDir } from "../state/paths.js"
import { listAllTasks } from "../state/tasks.js"
import { normalizeRole, roleAgent } from "../core/role-presets.js"
import type { MemberSpec, MemberState, TeamSpec } from "../core/types.js"
import { MEMBER_NAME_POOL, pickName } from "../state/naming.js"
import { defaultBounds } from "./lifecycle-shared.js"

/**
 * Best-effort model resolution for team_create. Resolves, in order:
 *   1. per-agent models (agents lookup),
 *   2. the configured default model,
 *   3. the leader session's most recent assistant model.
 * Each step swallows errors intentionally — members fall back to no explicit
 * model when a step is unavailable. The returned triple is merged per member as
 * `m.model ?? modelByAgent.get(agent) ?? defaultModel ?? sessionModel`.
 */
async function resolveCreateModel(
    ctx: PluginContext,
    sessionId: string,
): Promise<{
    modelByAgent: Map<string, string | undefined>
    defaultModel: string | undefined
    sessionModel: string | undefined
}> {
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
    // Final fallback: the leader session's active model.
    let sessionModel: string | undefined
    try {
        const msgsRes = await ctx.client.session.messages({
            path: { id: sessionId },
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
    return { modelByAgent, defaultModel, sessionModel }
}

export function teamCreateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Define an agent team. Each member has a role, a prompt (the member's instructions), and an optional name. role must be one of the preset roles (coder, debugger, optimizer, tester, reviewer, architect, explorer, writer, mathematician, physicist, simulator, chemist, analyst, visualizer, researcher, author, fantast, almighty); it fixes the member's agent and preset instruction, and any unknown role falls back to \"reviewer\" (read-only). name, if given, must be one of the preset pool names; if omitted it is auto-picked from the pool. Writes config.json + initial state.json. Does NOT spawn member sessions — they are spawned lazily on the first workflow call (team_parallel/pipeline/loop/delegate). The calling session becomes the team leader (\"master\").",
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
                        name: tool.schema.string().min(1).max(32).regex(/^[a-z0-9-]+$/).optional(),
                        role: tool.schema.string().min(1).max(64).regex(/^[a-zA-Z]+$/, "a single English word, letters only, e.g. \"coder\""),
                        prompt: tool.schema.string().min(1).max(8192),
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
            // A member (child) session must not create its own team: indexing it
            // as master below would let it escalate to master of a new team while
            // it is still a member of its original team.
            if (isIndexedMember(context.sessionID)) {
                return "Error: a team member session cannot create a team"
            }

            // Validate explicitly-provided names; collect them so the pool picker
            // avoids collisions. Members may omit `name` — those are assigned a
            // random pool name below.
            const taken = new Set<string>()
            for (const m of args.members) {
                if (m.name === undefined) continue
                // "master" and "orchestrator" are reserved synthetic identities
                // (the leader pseudo-member and the orchestrator message sender);
                // a real member by either name would collide with them.
                if (m.name === "master" || m.name === "orchestrator") {
                    return `Error: "${m.name}" is a reserved name and cannot be a member name`
                }
                if (!(MEMBER_NAME_POOL as readonly string[]).includes(m.name)) {
                    return `Error: name "${m.name}" is not a preset pool name. Choose one of: ${MEMBER_NAME_POOL.join(", ")}`
                }
                if (taken.has(m.name)) return `Error: duplicate member name "${m.name}"`
                taken.add(m.name)
            }

            // Resolve names: explicit names are kept; omitted names are drawn from
            // MEMBER_NAME_POOL at random with no reuse within this team.
            const named = args.members.map(m => {
                const name = m.name ?? pickName(taken)
                taken.add(name)
                return { ...m, name }
            })

            // Session scoping: project-scope teams are stored under
            // <storageRoot>/<leadSessionId>/teams/<name>/; user-scope teams stay
            // flat (<userStorageRoot>/teams/<name>/). leadSessionId is undefined
            // for user scope.
            const leadSessionId = ctx.scope === "project" ? context.sessionID : undefined

            // Atomically claim the team directory. mkdir with recursive:false is
            // the OS-level atomic primitive: exactly one of N concurrent callers
            // wins, the rest get EEXIST. This closes the TOCTOU window that a
            // check-then-create sequence would leave open.
            await fs.mkdir(teamsDir(ctx.storageRoot, leadSessionId), { recursive: true })
            try {
                await fs.mkdir(teamDir(ctx.storageRoot, args.name, leadSessionId), { recursive: false })
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === "EEXIST") {
                    return `Error: team name "${args.name}" already exists in this ${ctx.scope} scope`
                }
                throw err
            }

            // Auto-assign agent + model for members that omitted them.
            const modelInfo = await resolveCreateModel(ctx, context.sessionID)
            const resolved: MemberSpec[] = named.map(m => {
                const role = normalizeRole(m.role)
                const agent = m.agent ?? roleAgent(role)
                const model = m.model ?? modelInfo.modelByAgent.get(agent) ?? modelInfo.defaultModel ?? modelInfo.sessionModel
                return { name: m.name, role, prompt: m.prompt, agent, model, worktree: m.worktree }
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

            const createdTeam = await initTeamState(ctx.storageRoot, {
                version: 1,
                teamRunId: crypto.randomUUID(),
                teamName: args.name,
                status: "live",
                leadSessionId: context.sessionID,
                members,
                bounds: defaultBounds(args.bounds),
                createdAt: now,
                // Per project rule: never auto-activate.
                activatedAt: undefined,
            }, leadSessionId)

            indexMasterTeam(context.sessionID, args.name, leadSessionId, ctx.storageRoot, createdTeam.directory)

            return `Team "${args.name}" created with ${members.length} member(s): ${members.map(m => m.name).join(", ")}. Status: live (inactive — call team_activate to activate it). Sessions will spawn on first workflow call.`
        },
    })
}

export function teamListTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "List all teams in the current scope with their status and member count.",
        args: {},
        async execute(_args, context) {
            const leadSessionId = ctx.scope === "project" ? context.sessionID : undefined
            const names = await listTeamNames(ctx.storageRoot, leadSessionId)
            if (names.length === 0) return "No teams found."
            const rows = await Promise.all(
                names.map(async name => {
                    const spec = await readTeamSpec(ctx.storageRoot, name, leadSessionId)
                    let status = "unknown"
                    let count = spec?.members.length ?? 0
                    let createdAt = 0
                    let active = false
                    try {
                        const team = await loadTeamState(ctx.storageRoot, name, leadSessionId)
                        status = team.status
                        count = team.members.length
                        createdAt = team.createdAt
                        active = team.activatedAt !== undefined
                    } catch {
                        // state unreadable
                    }
                    const desc = (spec?.description ?? "").trim() || "-"
                    const created = createdAt
                        ? new Date(createdAt).toISOString().replace("T", " ").slice(0, 16)
                        : "-"
                    return { name, desc, created, count, status, active }
                }),
            )
            const lines = [
                "| Name | Description | Created | Members | Status | Active |",
                "|------|-------------|---------|---------|--------|--------|",
            ]
            for (const r of rows) {
                const desc = r.desc.length > 50 ? r.desc.slice(0, 47) + "…" : r.desc
                lines.push(`| ${r.name} | ${desc} | ${r.created} | ${r.count} | ${r.status} | ${r.active ? "yes" : "no" } |`)
            }
            return lines.join("\n")
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
                    if (t.reducePolicy) pol.push(`reduce: ${t.reducePolicy}${t.reduceRubric ? ` (${t.reduceRubric})` : ""}`)
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

export function teamQueryTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "Query detailed information about a specific team member by name.",
        args: {
            team_id: tool.schema.string().min(1),
            member_name: tool.schema.string().min(1),
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

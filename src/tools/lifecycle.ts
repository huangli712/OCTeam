/**
 * Team lifecycle tools: team_create, team_delete, team_list, team_status.
 * (design §4.1, §4.10, §4.11)
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../context.js"
import { deleteTeamStorage, initTeamState, listTeamNames, loadTeamState, readTeamSpec, writeTeamSpec } from "../state/store.js"
import { indexMaster, unindexSession } from "../utils.js"
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
        messagePayloadMaxBytes: 32768,
        messageUnreadMaxBytes: 1048576,
        ...override,
    }
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
                    maxMembers: tool.schema.number().optional(),
                    maxParallelMembers: tool.schema.number().optional(),
                    maxMessagesPerRun: tool.schema.number().optional(),
                    maxWallClockMinutes: tool.schema.number().optional(),
                    maxMemberTurns: tool.schema.number().optional(),
                })
                .optional(),
        },
        async execute(args, context) {
            const names = new Set<string>()
            for (const m of args.members) {
                if (names.has(m.name)) return `Error: duplicate member name "${m.name}"`
                names.add(m.name)
            }

            // M4: refuse if this session already leads a non-terminal team. One
            // interactive session drives one active team at a time (§252); otherwise
            // indexMaster below would silently overwrite the prior team's master
            // index and orphan its result delivery.
            for (const other of await listTeamNames(ctx.storageRoot)) {
                if (other === args.name) continue
                try {
                    const t = await loadTeamState(ctx.storageRoot, other)
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

            const now = Date.now()
            const spec: TeamSpec = {
                version: 1,
                name: args.name,
                description: args.description,
                createdAt: now,
                members: args.members as TeamMemberSpec[],
            }
            await writeTeamSpec(ctx.storageRoot, spec)

            const members: RuntimeMember[] = args.members.map(m => ({
                name: m.name,
                status: "pending",
                initialized: false,
                pendingMessageCount: 0,
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
            })

            // Index the leader session as master so its mailbox (queued team
            // results) can be drained by the event handler / Transform hook.
            indexMaster(context.sessionID, args.name)

            return `Team "${args.name}" created with ${members.length} member(s): ${members.map(m => m.name).join(", ")}. Status: live. Sessions will spawn on first workflow call.`
        },
    })
}

export function teamListTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "List all teams in the current scope with their status and member count.",
        args: {},
        async execute() {
            const names = await listTeamNames(ctx.storageRoot)
            if (names.length === 0) return "No teams found."
            const rows = await Promise.all(
                names.map(async name => {
                    const spec = await readTeamSpec(ctx.storageRoot, name)
                    let status = "unknown"
                    let count = spec?.members.length ?? 0
                    try {
                        const team = await loadTeamState(ctx.storageRoot, name)
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
        async execute(args) {
            let team
            try {
                team = await loadTeamState(ctx.storageRoot, args.team_id)
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
                lines.push(
                    `  - ${m.name}: ${m.status}${m.model ? ` (${m.model})` : ""}${m.pendingMessageCount ? ` ${m.pendingMessageCount} unread` : ""}${m.turnCount ? ` ${m.turnCount} turns` : ""}`,
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
        async execute(args) {
            let team
            try {
                team = await loadTeamState(ctx.storageRoot, args.team_id)
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
            await deleteTeamStorage(ctx.storageRoot, args.team_id)
            const { invalidateTeam } = await import("../state/store.js")
            invalidateTeam(args.team_id)
            return `Team "${args.team_id}" deleted${force ? " (forced)" : ""}.`
        },
    })
}

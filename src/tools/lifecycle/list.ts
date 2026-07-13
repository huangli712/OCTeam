/**
 * team_list tool -- list all teams in the current scope with status + count.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { listTeamNames, loadTeamState, readTeamSpec } from "../../state/store.js"

/** List all teams in the current scope with status and member count. */
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

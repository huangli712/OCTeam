/**
 * team_list tool -- list all teams in the current scope with status + count.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { logSwallowed } from "../../core/log.js"
import {
    listTeamNames,
    loadTeamState,
    readTeamSpec
} from "../../state/store.js"
import { isIndexedMasterOf } from "../../state/resolve.js"
import { teamDir } from "../../state/paths.js"

/** List teams in the current scope with status and member count. Project
 *  scope lists every team; user scope filters to teams the caller masters. */
export function teamListTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description: "List all teams in the current scope with their status and member count.",
        args: {},
        async execute(_args, context) {
            const leadSessionId = ctx.scope === "project" ? context.sessionID : undefined
            let names = await listTeamNames(ctx.storageRoot, leadSessionId)
            if (names.length === 0) return "No teams found."
            // In user scope, list only teams owned by this leader session.
            if (ctx.scope !== "project") {
                names = names.filter(name => {
                    const dir = teamDir(ctx.storageRoot, name)
                    return isIndexedMasterOf(context.sessionID, dir)
                })
            }
            if (names.length === 0) return "No teams found."
            const rows = await Promise.all(
                names.map(async name => {
                    // Isolate each spec read so one corrupt config or I/O error
                    // does not reject Promise.all and hide every other team.
                    let spec = null
                    try {
                        spec = await readTeamSpec(ctx.storageRoot, name, leadSessionId)
                    } catch (err) {
                        logSwallowed(ctx, "team_list: config unreadable", err, { name }, "debug")
                    }
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
                    } catch (err) {
                        logSwallowed(ctx, "team_list: state unreadable", err, { name }, "debug")
                        status = "error: state unreadable"
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
                const desc = (r.desc.length > 50 ? r.desc.slice(0, 47) + "…" : r.desc)
                    .replace(/\r?\n/g, " ")
                    .replace(/\|/g, "\\|")
                const row = `| ${r.name} | ${desc} | ${r.created} | ${r.count} | ${r.status} `
                    + `| ${r.active ? "yes" : "no"} |`
                lines.push(row)
            }
            return lines.join("\n")
        },
    })
}

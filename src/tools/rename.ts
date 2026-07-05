/**
 * team_rename tool -- rename an existing team (live status only). Renames the
 * on-disk directory and updates all indexes.
 */

import fs from "node:fs/promises"

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { invalidateTeam, listTeamNames, loadTeamState, readTeamSpec, saveTeamState, writeTeamSpec } from "../state/store.js"
import { indexMasterTeam, setActiveTeam, unindexMasterTeam } from "../state/resolve.js"
import { teamDir } from "../state/paths.js"
import type { TeamSpec } from "../core/types.js"

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

            let staleState = false
            await team.mutex.runExclusive(async () => {
                // Revalidate inside the mutex: a concurrent
                // startOrchestration may have flipped status live→busy since
                // the outside-mutex check at line 42. Refuse rather than
                // renaming during an active run.
                if (team.status !== "live") {
                    staleState = true
                    return
                }
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

            if (staleState) {
                return `Error: team "${args.team_id}" status is "${team.status}", not "live". Teams can only be renamed before sessions are spawned.`
            }

            return `Team "${args.team_id}" renamed to "${args.new_name}".`
        },
    })
}

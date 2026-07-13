/**
 * team_deactivate tool -- deactivate the session's active team. A busy team
 * cannot be deactivated (finish or wait first).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { loadTeamState, saveTeamState, type Team } from "../../state/store.js"
import { logSwallowed } from "../../core/log.js"
import { clearActiveTeam } from "../../state/resolve.js"

/** Deactivate the currently active team for this session. */
export function teamDeactivateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Deactivate the session's active team. After this, no team is available in the " +
            "session — call team_activate to pick one. A team that is mid-orchestration (busy) " +
            "cannot be deactivated — finish or wait first. Idempotent: deactivating an already-" +
            "inactive team is a no-op. The master may only deactivate its own team.",
        args: {
            team_id: tool.schema.string().min(1),
        },
        async execute(args, context) {
            const pathLeadSessionId = ctx.scope === "project" ? context.sessionID : undefined
            let team: Team
            try {
                team = await loadTeamState(ctx.storageRoot, args.team_id, pathLeadSessionId)
            } catch {
                return `Error: team "${args.team_id}" not found`
            }
            if (team.leadSessionId !== context.sessionID) {
                return "Error: team_deactivate is master-only (only the team's leader session can deactivate it)"
            }
            if (team.status === "busy" || team.activeTask !== undefined) {
                return `Error: team "${args.team_id}" is busy with an active orchestration. `
                    + `Wait for it to finish before deactivating.`
            }

            let result = ""
            await team.mutex.runExclusive(async () => {
                if (team.activatedAt === undefined) {
                    result = `Team "${args.team_id}" is already inactive.`
                    return
                }
                team.activatedAt = undefined
                clearActiveTeam(context.sessionID)
                await saveTeamState(team).catch((err) =>
                    logSwallowed(ctx, "persist team state failed (deactivate)", err, { team: team.teamName })
                )
                result = `Team "${args.team_id}" deactivated. No team is active in this session — `
                    + `call team_activate to pick one.`
            })
            return result
        },
    })
}

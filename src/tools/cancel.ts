/**
 * team_cancel tool -- cancel the in-flight orchestration on a busy team.
 * Aborts running member turns, clears the active task, returns to idle
 * WITHOUT deleting the team.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { loadTeamState, saveTeamState, type Team } from "../state/store.js"
import { finishRun } from "../orchestration/runs/summary.js"
import { abortAndResetMembers } from "./support.js"

/** Cancel the active orchestration on a busy team, resetting it to idle. */
export function teamCancelTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Cancel the in-flight orchestration on a busy team. Aborts running " +
            "member turns, clears the active task, and returns the team to idle " +
            "WITHOUT deleting it (members, sessions, and worktrees are kept and " +
            "reusable). Master-only. No-op error if the team has no active " +
            "orchestration.",
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
                return "Error: team_cancel is master-only (only the team's leader session can cancel it)"
            }
            if (team.status !== "busy" || team.activeTask === undefined) {
                return `Error: team "${args.team_id}" has no active orchestration to cancel.`
            }

            let result = ""
            await team.mutex.runExclusive(async () => {
                if (team.status !== "busy" || team.activeTask === undefined) {
                    result = `Team "${args.team_id}" has no active orchestration to cancel.`
                    return
                }
                // a. Abort running member turns + reset to idle (shared helper).
                await abortAndResetMembers(ctx, team)
                // b. Notify master, clear active task, and transition to idle.
                await finishRun(ctx, team, "cancelled", "idle")
                // d. Persist.
                await saveTeamState(team)
                result = `Team "${args.team_id}" orchestration cancelled. Team is idle and reusable.`
            })
            return result
        },
    })
}

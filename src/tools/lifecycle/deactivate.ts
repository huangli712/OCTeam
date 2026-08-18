/**
 * team_deactivate tool -- deactivate the session's active team. A busy team
 * cannot be deactivated (finish or wait first).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { loadTeamState, saveTeamState, type Team } from "../../state/store.js"
import { logSwallowed } from "../../core/log.js"
import { isEnoent } from "../../core/utils.js"
import { clearActiveTeam, isIndexedMasterOf, setActiveTeam } from "../../state/resolve.js"
import { withLock } from "../../state/locks.js"
import { teamLifecycleLockPath } from "../../state/paths.js"

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
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
            }
            if (team.leadSessionId !== context.sessionID || !isIndexedMasterOf(context.sessionID, team.directory)) {
                return "Error: team_deactivate is master-only (only the team's leader session can deactivate it)"
            }
            if (team.status === "busy" || team.activeTask !== undefined) {
                return `Error: team "${args.team_id}" is busy with an active orchestration. `
                    + `Wait for it to finish before deactivating.`
            }

            let result = ""
            const prevActivatedAt = team.activatedAt
            await withLock(teamLifecycleLockPath(team.directory), async () => team.mutex.runExclusive(async () => {
                // Revalidate inside the mutex: a concurrent
                // startOrchestration may have flipped status to "busy" since
                // the outside-mutex check at line 40. Refuse rather than
                // deactivating during an active run. Also refuse during
                // spawning (Phase 2 member sessions are being created).
                if (team.status === "busy" || team.activeTask !== undefined || team.spawning) {
                    result = `Error: team "${args.team_id}" is busy with an active orchestration. `
                        + `Wait for it to finish before deactivating.`
                    return
                }
                if (team.activatedAt === undefined) {
                    result = `Team "${args.team_id}" is already inactive.`
                    return
                }
                team.activatedAt = undefined
                clearActiveTeam(context.sessionID)
                try {
                    await saveTeamState(team)
                } catch (err) {
                    // Restore in-memory state so it matches the disk.
                    team.activatedAt = prevActivatedAt
                    setActiveTeam(context.sessionID, team.directory)
                    logSwallowed(ctx, "persist team state failed (deactivate)", err, { team: team.teamName })
                    result = `Error: failed to persist deactivation for team "${args.team_id}" (state file write failed)`
                    return
                }
                result = `Team "${args.team_id}" deactivated. No team is active in this session — `
                    + `call team_activate to pick one.`
            }), team.directory)
            return result
        },
    })
}

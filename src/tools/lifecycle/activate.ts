/**
 * team_activate tool -- make a team the session's active team. Refuses if
 * another team is already active (auto-switching disabled).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { listTeamNames, loadTeamState, saveTeamState, type Team } from "../../state/store.js"
import { logSwallowed } from "../../core/log.js"
import { isEnoent } from "../../core/utils.js"
import { clearActiveTeam, setActiveTeam } from "../../state/resolve.js"
import { decideActivate, withOrderedLocks } from "../../state/activation.js"

/** Activate a team for the current session. Only one team may be active at a time. */
export function teamActivateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Make a team the session's active (available) team. At most one team is active per " +
            "session. Refuses if another team is already active — call team_deactivate on it first " +
            "(auto-switching is disabled). Idempotent: activating the already-active team is a " +
            "no-op. The master may only interact with the active team.",
        args: {
            team_id: tool.schema.string().min(1),
        },
        async execute(args, context) {
            const leadSessionId = ctx.scope === "project" ? context.sessionID : undefined
            let target: Team
            try {
                target = await loadTeamState(ctx.storageRoot, args.team_id, leadSessionId)
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
            }
            if (target.leadSessionId !== context.sessionID) {
                return "Error: team_activate is master-only (only the team's leader session can activate it)"
            }

            // Find the currently-active sibling (if any) — scan in parallel
            // since loadTeamState is I/O-bound.
            let activeSibling: Team | undefined
            const siblings = await listTeamNames(ctx.storageRoot, leadSessionId)
            const loaded = await Promise.all(
                siblings
                    .filter(name => name !== args.team_id)
                    .map(name =>
                        loadTeamState(ctx.storageRoot, name, leadSessionId)
                            .then(t => ({ t, ok: true as const }))
                            .catch(() => ({ ok: false as const })),
                    ),
            )
            for (const r of loaded) {
                if (
                    r.ok
                    && r.t.leadSessionId === context.sessionID
                    && r.t.activatedAt !== undefined
                    && r.t.directory !== target.directory
                ) {
                    activeSibling = r.t
                    break
                }
            }

            let result = ""
            await withOrderedLocks([target, activeSibling].filter((t): t is Team => t !== undefined), async () => {
                const decision = decideActivate({
                    targetIsAlreadyActive: target.activatedAt !== undefined,
                    outgoingExists: activeSibling !== undefined,
                    outgoingName: activeSibling?.teamName,
                })
                if (decision.kind === "noop") {
                    result = `Team "${args.team_id}" is already the active team.`
                    return
                }
                if (decision.kind === "error") {
                    result = decision.message
                    return
                }
                const now = Date.now()
                const prevSiblingActivatedAt = activeSibling?.activatedAt
                target.activatedAt = now
                setActiveTeam(context.sessionID, target.directory)
                // Deactivate the outgoing sibling so its state.json does not
                // retain a stale activatedAt that would be incorrectly recovered
                // as 'active' on restart.
                if (activeSibling) {
                    activeSibling.activatedAt = undefined
                }
                try {
                    await saveTeamState(target)
                } catch (err) {
                    // Restore in-memory state to match the un-persisted disk.
                    target.activatedAt = undefined
                    clearActiveTeam(context.sessionID)
                    if (activeSibling) activeSibling.activatedAt = prevSiblingActivatedAt
                    logSwallowed(ctx, "persist team state failed (activate)", err, { team: target.teamName })
                    result = `Error: failed to persist activation for team "${args.team_id}" (state file write failed)`
                    return
                }
                if (activeSibling) {
                    try {
                        await saveTeamState(activeSibling)
                    } catch (err) {
                        // Compensating write: undo target's activation on disk
                        // so restart does not see two active teams. Without
                        // this, target's state.json has activatedAt while
                        // sibling's still has its old activatedAt.
                        target.activatedAt = undefined
                        try {
                            await saveTeamState(target)
                        } catch (compensateErr) {
                            logSwallowed(ctx, "activate: compensating write failed after sibling deactivation failure", compensateErr, { team: target.teamName })
                        }
                        clearActiveTeam(context.sessionID)
                        activeSibling.activatedAt = prevSiblingActivatedAt
                        logSwallowed(ctx, "persist team state failed (deactivate sibling)", err, { team: activeSibling!.teamName })
                        result = `Error: failed to persist deactivation of sibling "${activeSibling!.teamName}". Activation of "${args.team_id}" was rolled back.`
                        return
                    }
                }
                result = `Team "${args.team_id}" activated.`
            })
            return result
        },
    })
}

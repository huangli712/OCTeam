/**
 * team_activate tool -- make a team the session's active team. Refuses if
 * another team is already active (auto-switching disabled).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { listTeamNames, loadTeamState, saveTeamState, type Team } from "../state/store.js"
import { logSwallowed } from "../core/log.js"
import { setActiveTeam } from "../state/resolve.js"
import { decideActivate, withOrderedLocks } from "./lifecycle-shared.js"

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
            let X: Team
            try {
                X = await loadTeamState(ctx.storageRoot, args.team_id, leadSessionId)
            } catch {
                return `Error: team "${args.team_id}" not found`
            }
            if (X.leadSessionId !== context.sessionID) {
                return "Error: team_activate is master-only (only the team's leader session can activate it)"
            }

            // Find the currently-active sibling Y (if any).
            let Y: Team | undefined
            for (const other of await listTeamNames(ctx.storageRoot, leadSessionId)) {
                try {
                    const t = await loadTeamState(ctx.storageRoot, other, leadSessionId)
                    if (
                        t.leadSessionId === context.sessionID
                        && t.activatedAt !== undefined
                        && t.directory !== X.directory
                    ) {
                        Y = t
                        break
                    }
                } catch {
                    // unreadable team state — ignore
                }
            }

            let result = ""
            await withOrderedLocks([X, Y].filter((t): t is Team => t !== undefined), async () => {
                const decision = decideActivate({
                    targetIsAlreadyActive: X.activatedAt !== undefined && Y === undefined,
                    outgoingExists: Y !== undefined,
                    outgoingName: Y?.teamName,
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
                X.activatedAt = now
                setActiveTeam(context.sessionID, X.directory)
                await saveTeamState(X).catch((err) =>
                    logSwallowed(ctx, "persist team state failed (activate)", err, { team: X.teamName })
                )
                result = `Team "${args.team_id}" activated.`
            })
            return result
        },
    })
}

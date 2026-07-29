/**
 * team_activate tool -- make a team the session's active team. Refuses if
 * another team is already active (auto-switching disabled).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { listTeamNames, loadTeamState, saveTeamState, type Team } from "../../state/store.js"
import { logSwallowed } from "../../core/log.js"
import { isEnoent } from "../../core/utils.js"
import { clearActiveTeam, isIndexedMasterOf, setActiveTeam } from "../../state/resolve.js"
import { decideActivate, withOrderedLocks } from "../../state/activation.js"

// H-22: process-level activation mutex keyed by sessionID. Prevents two
// concurrent team_activate calls from the same session from both scanning
// "no active sibling" outside the lock and then activating different targets
// simultaneously (which would leave two teams active).
const activationMutex = new Map<string, Promise<void>>()

/** Serialize a callback per sessionID key. */
async function withSessionMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = activationMutex.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const next = prev.then(() => gate)
    activationMutex.set(key, next)
    try {
        await prev
        return await fn()
    } finally {
        release()
        // LOW: evict the Map entry once the chain settles so long-lived hosts
        // don't accumulate stale session keys. If another caller queued behind
        // us, they've already replaced the value; our delete is a no-op.
        if (activationMutex.get(key) === next) {
            activationMutex.delete(key)
        }
    }
}

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
            if (target.leadSessionId !== context.sessionID || !isIndexedMasterOf(context.sessionID, target.directory)) {
                return "Error: team_activate is master-only (only the team's leader session can activate it)"
            }

            // H-22: serialize sibling scan + activation per session so two
            // concurrent team_activate calls cannot both see "no active
            // sibling" and proceed to activate different targets.
            return await withSessionMutex(context.sessionID, async () => {
            // Find the currently-active sibling (if any) — re-scan INSIDE the
            // mutex so a concurrent activate that just landed is visible.
            let activeSibling: Team | undefined
            const siblings = await listTeamNames(ctx.storageRoot, leadSessionId)
            const loaded = await Promise.all(
                siblings
                    .filter(name => name !== args.team_id)
                    .map(name =>
                        loadTeamState(ctx.storageRoot, name, leadSessionId)
                            .then(t => ({ t, ok: true as const }))
                            .catch(err => {
                                // HIGH-B: surface sibling-load failures so an
                                // operator can diagnose a transient IO/permission
                                // error. Pre-fix code silently treated the
                                // sibling as non-existent, which could let two
                                // teams activate concurrently if the active
                                // sibling's state was momentarily unreadable.
                                logSwallowed(ctx, "team_activate: sibling load failed (treating as inactive)", err, {
                                    siblingTeam: name,
                                    leadSessionId,
                                })
                                return { ok: false as const }
                            }),
                    ),
            )
            // H-T7: fail-closed when a sibling's state is unreadable. Pre-fix
            // code treated unreadable siblings as inactive, which could let
            // two teams activate concurrently if the active sibling's state
            // was momentarily unreadable (EACCES, EIO). Now refuse the
            // activation so the operator can diagnose the IO issue first.
            const failedSiblings = loaded.filter(r => !r.ok)
            if (failedSiblings.length > 0) {
                return `Error: cannot verify sibling team states (unreadable: ${failedSiblings.length}). Refusing to activate to prevent concurrent activation. Check .octeam/ permissions and retry.`
            }
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
            }) // withSessionMutex
        },
    })
}

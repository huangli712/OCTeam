/**
 * Team lifecycle tools: state transitions + teardown.
 * team_delete, team_activate, team_deactivate, team_cancel.
 * Extracted from the original lifecycle.ts.
 *
 * team_delete sets the runtime tombstone (team.deleted) FIRST inside its mutex
 * so a racing event handler cannot resurrect the just-removed directory — see
 * the C1 fix in handlers.ts (processIdle early-return) and store.ts
 * (saveTeamState guard).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { clearActiveTask, deleteTeamStorage, invalidateTeam, listTeamNames, loadTeamState, saveTeamState, type Team } from "../state/store.js"
import { logSwallowed } from "../core/log.js"
import { clearActiveTeam, setActiveTeam, unindexMasterTeam, unindexSession } from "../state/resolve.js"
import { clearWakeHint } from "../messaging/wake-hint.js"
import { cleanWorktree, hasUncommittedChanges } from "../state/worktrees.js"
import { deliverSummaryToLeader } from "../orchestration/summary.js"
import { decideActivate, withOrderedLocks } from "./lifecycle-shared.js"

export function teamDeleteTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Delete a team. Without force, refuses while the team is busy with an active orchestration, or if any member worktree has uncommitted changes. With force, removes on-disk state immediately (member worktrees are cleaned up; sessions stay in OpenCode history; running agents finish their current turn but receive no further dispatch).",
        args: {
            team_id: tool.schema.string().min(1),
            force: tool.schema.boolean().optional(),
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
                return "Error: team_delete is master-only (only the team's leader session can delete it)"
            }
            const force = args.force ?? false
            if (!force && team.status === "busy") {
                return `Error: team "${args.team_id}" is busy with an active orchestration. Wait for it to finish, or re-run with force: true.`
            }
            // Protect uncommitted work: if any member's worktree is dirty, refuse
            // unless force: true — regardless of team status.
            if (!force) {
                const dirty: string[] = []
                for (const m of team.members) {
                    if (m.worktreePath && await hasUncommittedChanges(m.worktreePath)) {
                        dirty.push(m.name)
                    }
                }
                if (dirty.length > 0) {
                    return `Error: member(s) ${dirty.join(", ")} have uncommitted changes in their worktrees. Commit or stash them first, or re-run with force: true.`
                }
            }
            // Hold the team mutex for the entire teardown. team.deleted is set FIRST
            // inside the lock so any handler that registered the Team before us (and
            // therefore holds a reference to this same in-memory object via the registry
            // cache) and acquires the mutex after us sees the tombstone and no-ops:
            // processIdle early-returns and saveTeamState skips persistence, preventing
            // the handler from recreating the just-deleted directory via atomicWrite's
            // mkdir({recursive:true}).
            await team.mutex.runExclusive(async () => {
                team.deleted = true  // tombstone: prevent any racing handler from resurrecting this dir
                // Force-deleting a busy team: abort running members and clear the
                // active task in memory FIRST (mirrors team_cancel) so any handler
                // that acquires the mutex after us sees a consistent, finished state
                // and does not write. This idle state is intentionally NOT persisted —
                // the storage is removed below instead.
                if (team.status === "busy") {
                    for (const m of team.members) {
                        if (!m.isMaster && m.sessionId && m.status === "running") {
                            await ctx.client.session
                                .abort({
                                    path: { id: m.sessionId },
                                    query: { directory: m.worktreePath ?? ctx.directory },
                                })
                                .catch(() => {
                                    // best-effort: a failed abort must not block delete
                                })
                        }
                    }
                    clearActiveTask(team)
                    team.status = "idle"
                    for (const m of team.members) {
                        if (m.isMaster) continue
                        m.status = "idle"
                        m.declaredDone = false
                        m.retryingSince = undefined
                    }
                }
                // Clean up worktrees, then unindex the team. Worktree teardown must
                // precede deleteTeamStorage so git can remove the still-present
                // worktree files. Member sessions are 1:1 (full unindex); the master
                // owns this team in a 1:many index, so remove ONLY this team from the
                // master's map (unindexSession on the leader would wipe the session's
                // OTHER teams).
                for (const m of team.members) {
                    await cleanWorktree(ctx.directory, m.worktreePath)
                    if (m.sessionId) {
                        unindexSession(m.sessionId)
                        clearWakeHint(m.sessionId)
                    }
                }
                unindexMasterTeam(team.leadSessionId, team.directory)
                clearWakeHint(team.leadSessionId)
                await deleteTeamStorage(ctx.storageRoot, args.team_id, pathLeadSessionId)
                invalidateTeam(team.directory)
            })
            return `Team "${args.team_id}" deleted${force ? " (forced)" : ""}.`
        },
    })
}

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
                return `Error: team "${args.team_id}" is busy with an active orchestration. Wait for it to finish before deactivating.`
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
                result = `Team "${args.team_id}" deactivated. No team is active in this session — call team_activate to pick one.`
            })
            return result
        },
    })
}

// --- team_cancel ---

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
                // a. Abort running member turns (best-effort).
                for (const m of team.members) {
                    if (!m.isMaster && m.sessionId && m.status === "running") {
                        await ctx.client.session
                            .abort({
                                path: { id: m.sessionId },
                                query: { directory: m.worktreePath ?? ctx.directory },
                            })
                            .catch(() => {
                                // best-effort: a failed abort must not block cancel
                            })
                    }
                }
                // b. Notify master BEFORE clearing (summary reads activeTask).
                await deliverSummaryToLeader(ctx, team, "cancelled")
                // c. Clear + transition to idle (NOT failed).
                clearActiveTask(team)
                team.status = "idle"
                for (const m of team.members) {
                    if (m.isMaster) continue
                    m.status = "idle"
                    m.declaredDone = false
                    m.retryingSince = undefined
                }
                // d. Persist.
                await saveTeamState(team)
                result = `Team "${args.team_id}" orchestration cancelled. Team is idle and reusable.`
            })
            return result
        },
    })
}

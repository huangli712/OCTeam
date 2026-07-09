/**
 * team_delete tool -- team teardown. Sets the runtime tombstone (team.deleted)
 * FIRST inside its mutex so a racing event handler cannot resurrect the
 * just-removed directory (C1 fix).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { clearActiveTask, deleteTeamStorage, invalidateTeam, loadTeamState, type Team } from "../state/store.js"
import { unindexMasterTeam, unindexSession } from "../state/resolve.js"
import { clearWakeHint } from "../messaging/wake-hint.js"
import { abortAndResetMembers } from "../orchestration/shared.js"
import { cleanWorktree, hasUncommittedChanges } from "../state/worktrees.js"
import { worktreesDir } from "../state/paths.js"

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
            // unless force: true -- regardless of team status.
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
            try {
                await team.mutex.runExclusive(async () => {
                team.deleted = true  // tombstone: prevent any racing handler from resurrecting this dir
                // Force-deleting a busy team: abort running members and clear the
                // active task in memory FIRST (mirrors team_cancel) so any handler
                // that acquires the mutex after us sees a consistent, finished state
                // and does not write. This idle state is intentionally NOT persisted --
                // the storage is removed below instead.
                if (team.status === "busy") {
                    // Abort running members + reset to idle (shared helper,
                    // mirrors team_cancel). This idle state is intentionally
                    // NOT persisted — the storage is removed below instead.
                    await abortAndResetMembers(ctx, team)
                    clearActiveTask(team)
                    team.status = "idle"
                }
                // Clean up worktrees, then unindex the team. Worktree teardown must
                // precede deleteTeamStorage so git can remove the still-present
                // worktree files. Member sessions are 1:1 (full unindex); the master
                // owns this team in a 1:many index, so remove ONLY this team from the
                // master's map (unindexSession on the leader would wipe the session's
                // OTHER teams).
                for (const m of team.members) {
                    await cleanWorktree(ctx.directory, m.worktreePath, worktreesDir(team.directory))
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
            } catch (err: unknown) {
                // deleteTeamStorage failed (non-ENOENT fs.rm error). The on-disk
                // state still exists — surface the failure so the caller knows
                // the deletion was incomplete and the orphaned state may
                // resurrect on restart.
                const msg = err instanceof Error ? err.message : String(err)
                return `Error: failed to fully delete team "${args.team_id}" storage: ${msg}. The team directory may still exist on disk; manual cleanup may be required.`
            }
        },
    })
}

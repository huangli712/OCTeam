/**
 * team_delete tool -- team teardown. Sets the runtime tombstone (team.deleted)
 * FIRST inside its mutex so a racing event handler cannot resurrect the
 * just-removed directory.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"

import type { PluginContext } from "../../core/context.js"
import { clearActiveTask, deleteTeamStorage, invalidateTeam, loadTeamState, type Team } from "../../state/store.js"
import { unindexMasterTeam, unindexSession, isIndexedMasterOf } from "../../state/resolve.js"
import { clearWakeHint } from "../../messaging/wake-hint.js"
import { abortAndResetMembers } from "../support.js"
import { hasUncommittedChanges, destroyWorktree } from "../../state/worktrees.js"
import { worktreesDir } from "../../state/paths.js"

/** Delete a team, with optional force mode to skip safety checks. */
export function teamDeleteTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Delete a team. Without force, refuses while the team is busy with an active orchestration, or if any "
            + "member worktree has uncommitted changes. With force, removes on-disk state "
            + "immediately (member worktrees are cleaned up; sessions stay in OpenCode history; "
            + "running agents finish their current turn but receive no further dispatch).",
        args: {
            team_id: tool.schema.string().min(1),
            force: tool.schema.boolean().optional(),
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
                return "Error: team_delete is master-only (only the team's leader session can delete it)"
            }
            const force = args.force ?? false
            if (!force && team.status === "busy") {
                return `Error: team "${args.team_id}" is busy with an active orchestration. `
                    + `Wait for it to finish, or re-run with force: true.`
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
                    return `Error: member(s) ${dirty.join(", ")} have uncommitted changes in their worktrees. `
                        + `Commit or stash them first, or re-run with force: true.`
                }
            }
            // Hold the team mutex for the entire teardown. team.deleted is set FIRST
            // inside the lock so any handler that registered the Team before us (and
            // therefore holds a reference to this same in-memory object via the registry
            // cache) and acquires the mutex after us sees the tombstone and no-ops:
            // processIdle early-returns and saveTeamState skips persistence, preventing
            // the handler from recreating the just-deleted directory via atomicWrite's
            // mkdir({recursive:true}).
            const worktreeErrors: string[] = []
            let staleBusy = false
            try {
                await team.mutex.runExclusive(async () => {
                // Revalidate inside the mutex: a concurrent
                // startOrchestration may have flipped status to "busy" since
                // the outside-mutex check at line 45. For non-force, refuse
                // rather than aborting an active run the user did not authorize.
                if (!force && team.status === "busy") {
                    staleBusy = true
                    return
                }
                team.deleted = true  // tombstone: prevent any racing handler from resurrecting this dir
                // Force-deleting a busy team: abort running members and clear the
                // active task in memory FIRST (mirrors team_cancel) so any handler
                // that acquires the mutex after us sees a consistent, finished state
                // and does not write. This idle state is intentionally NOT persisted --
                // the storage is removed below instead.
                if (team.status === "busy" || team.spawning) {
                    if (team.spawning) {
                        return `Error: team "${args.team_id}" is initializing (session/worktree creation in progress). Retry in a few seconds.`
                    }
                    // Abort running members + reset to idle (shared helper,
                    // mirrors team_cancel). This idle state is intentionally
                    // NOT persisted — the storage is removed below instead.
                    await abortAndResetMembers(ctx, team)
                    clearActiveTask(team)
                    team.status = "idle"
                }
                // Clean up worktrees BEFORE deleteTeamStorage (git needs the
                // files present). Member sessions are un-indexed ONLY after
                // deleteTeamStorage succeeds (H58: pre-fix code ran unindex
                // before the storage delete, so a failure left members
                // un-indexed but the team still on disk — "restored to usable
                // state" was a lie since sessions were gone).
                for (const m of team.members) {
                    try {
                        await destroyWorktree(
                            ctx.directory,
                            m.worktreePath,
                            worktreesDir(team.directory),
                            team.teamName,
                            m.name,
                        )
                    } catch (err) {
                        worktreeErrors.push(`${m.name}: ${err instanceof Error ? err.message : String(err)}`)
                    }
                }
                // HIGH-A: order cleanup so an fs.rm failure leaves indexes intact.
                // Pre-fix code ran unindexMasterTeam + clearWakeHint BEFORE
                // deleteTeamStorage, so a storage-delete failure left the
                // team un-indexed in memory but still present on disk. On
                // restart rebuildSessionIndex would reindex from disk, but in
                // the live process the master could not see this team until
                // restart. The fix moves deleteTeamStorage first; only on
                // successful removal do we unindex.
                try {
                    await deleteTeamStorage(ctx.storageRoot, args.team_id, pathLeadSessionId)
                } catch (err) {
                    // Re-raise to the outer catch (H-24 tombstone restore).
                    throw err
                }
                    // H58: unindex member sessions + master team ONLY after
                    // deleteTeamStorage succeeds. Worktree destruction above
                    // is best-effort (errors collected); if it fails the team
                    // is still deleted but worktree branches may linger.
                    for (const m of team.members) {
                        if (m.sessionId) {
                            unindexSession(m.sessionId)
                            clearWakeHint(m.sessionId)
                        }
                    }
                    unindexMasterTeam(team.leadSessionId, team.directory)
                    clearWakeHint(team.leadSessionId)
                    invalidateTeam(team.directory)
                })
                if (staleBusy) {
                    return `Error: team "${args.team_id}" is busy with an active orchestration. `
                        + `Wait for it to finish, or re-run with force: true.`
                }
                const wtWarning = worktreeErrors.length > 0
                    ? ` (worktree cleanup failed for: ${worktreeErrors.join("; ")})`
                    : ""
                return `Team "${args.team_id}" deleted${force ? " (forced)" : ""}.${wtWarning}`
            } catch (err: unknown) {
                // deleteTeamStorage failed (non-ENOENT fs.rm error). The on-disk
                // state still exists — surface the failure so the caller knows
                // the deletion was incomplete and the orphaned state may
                // resurrect on restart.
                //
                // H-24: restore the tombstone so the in-memory team object is
                // still usable. Pre-fix code left team.deleted=true, which made
                // the team permanently invisible to all handlers (processIdle,
                // saveTeamState, etc.) even though the directory still existed
                // on disk. With the tombstone cleared, the team can be retried
                // on the next team_delete call, and on plugin restart
                // rebuildSessionIndex re-indexes it from the surviving disk state.
                team.deleted = false
                const msg = err instanceof Error ? err.message : String(err)
                invalidateTeam(team.directory)
return `Error: failed to fully delete team "${args.team_id}" storage: ${msg}. `
+ `The team directory may still exist on disk; manual cleanup may be required. `
+ `The team has been restored to a usable state.`
            }
        },
    })
}

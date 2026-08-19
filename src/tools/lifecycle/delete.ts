/**
 * team_delete tool -- team teardown. Sets the runtime tombstone (team.deleted)
 * FIRST inside its mutex so a racing event handler cannot resurrect the
 * just-removed directory.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"
import {
    clearActiveTask,
    deleteQuarantinedTeamStorage,
    invalidateTeam,
    loadTeamState,
    quarantineTeamStorage,
    type Team,
} from "../../state/store.js"
import {
    unindexMasterTeam,
    unindexSession,
    isIndexedMasterOf
} from "../../state/resolve.js"
import {
    hasUncommittedChanges,
    destroyWorktree
} from "../../state/worktrees.js"
import {
    worktreesDir,
    teamLifecycleLockPath,
    teamNamespaceLockPath
} from "../../state/paths.js"
import { withLock } from "../../state/locks.js"
import { clearWakeHint } from "../../messaging/wake-hint.js"
//
import { abortAndResetMembers } from "../support.js"

/** Delete a team, with optional force mode to skip safety checks. */
export function teamDeleteTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Delete a team. Without force, refuses while the team is busy with an active orchestration, or if any "
            + "member worktree has uncommitted changes. With force, removes on-disk state "
            + "immediately (member worktrees are cleaned up; sessions stay in OpenCode history; "
            + "running agents are best-effort aborted and receive no further dispatch).",
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
            let staleSpawning = false
            let quarantineDirectory: string | undefined
            const unindexDeletedTeam = () => {
                for (const member of team.members) {
                    if (member.sessionId) {
                        unindexSession(member.sessionId)
                        clearWakeHint(member.sessionId)
                    }
                }
                unindexMasterTeam(team.leadSessionId, team.directory)
                clearWakeHint(team.leadSessionId)
                invalidateTeam(team.directory)
            }
            try {
                await withLock(teamNamespaceLockPath(ctx.storageRoot), async () =>
                    withLock(teamLifecycleLockPath(team.directory), async () =>
                        team.mutex.runExclusive(async () => {
                // Revalidate inside the mutex: a concurrent
                // startOrchestration may have flipped status to "busy" since
                // the outside-mutex check at line 53. For non-force, refuse
                // rather than aborting an active run the user did not authorize.
                if (!force && team.status === "busy") {
                    staleBusy = true
                    return
                }
                // Refuse deletion of spawning teams before setting the tombstone
                // so the error path does not mutate team.deleted.
                if (team.spawning) {
                    // Flag the spawning state because team.mutex.runExclusive
                    // discards the callback return value. The outer code uses
                    // the flag to report the error.
                    staleSpawning = true
                    return
                }
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
                // Destroy worktrees before quarantining the team directory because
                // their paths must remain valid until cleanup completes.
                for (const m of team.members) {
                    try {
                        // Check the boolean return because false means the
                        // worktree was rejected (out-of-bounds/symlink) but
                        // no exception was thrown.
                        const destroyed = await destroyWorktree(
                            ctx.directory,
                            m.worktreePath,
                            worktreesDir(team.directory),
                            team.teamName,
                            m.name,
                        )
                        if (!destroyed) {
                            worktreeErrors.push(`${m.name}: worktree cleanup rejected (out-of-bounds or symlink)`)
                        }
                    } catch (err) {
                        worktreeErrors.push(`${m.name}: ${err instanceof Error ? err.message : String(err)}`)
                    }
                }
                let quarantineErr: Error | undefined
                let quarantined: string
                try {
                    quarantined = await quarantineTeamStorage(
                        ctx.storageRoot,
                        args.team_id,
                        pathLeadSessionId,
                        team.directory,
                        team.teamRunId,
                    )
                } catch (err) {
                    // If quarantine fails after worktree cleanup, the tombstoned team
                    // cannot restore those worktrees. Surface
                    // the worktree errors alongside the quarantine failure so the
                    // user knows the full extent of what was cleaned up.
                    quarantineErr = err instanceof Error ? err : new Error(String(err))
                    quarantined = ""
                }
                quarantineDirectory = quarantined
                if (!quarantineErr && quarantined) {
                    await deleteQuarantinedTeamStorage(ctx.storageRoot, quarantined)
                }
                unindexDeletedTeam()
                if (quarantineErr) {
                    const wtMsg = worktreeErrors.length > 0
                        ? ` Worktree cleanup completed: ${worktreeErrors.join("; ")}`
                        : " Worktrees were destroyed before quarantine failure."
                    throw new Error(`team_delete: quarantine failed for team "${args.team_id}" `
                        + `after worktree cleanup: ${quarantineErr.message}.${wtMsg}`)
                }
                }), team.directory), ctx.storageRoot)
                if (staleSpawning) {
                    return `Error: team "${args.team_id}" is initializing (session/worktree creation in progress). `
                        + `Retry in a few seconds.`
                }
                if (staleBusy) {
                    return `Error: team "${args.team_id}" is busy with an active orchestration. `
                        + `Wait for it to finish, or re-run with force: true.`
                }
                const wtWarning = worktreeErrors.length > 0
                    ? ` (worktree cleanup failed for: ${worktreeErrors.join("; ")})`
                    : ""
                return `Team "${args.team_id}" deleted${force ? " (forced)" : ""}.${wtWarning}`
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err)
                if (!quarantineDirectory) {
                    return `Error: failed to quarantine team "${args.team_id}": ${msg}. `
                        + `No worktrees or branches were modified; the team remains tombstoned and can be retried.`
                }
                unindexDeletedTeam()
                return `Error: team "${args.team_id}" was quarantined but cleanup failed: ${msg}. `
                    + `The canonical team directory is gone; manual quarantine cleanup may be required.`
            }
        },
    })
}

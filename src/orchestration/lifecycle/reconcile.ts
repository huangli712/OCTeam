/**
 * Crash recovery and session-lifecycle cleanup. Hook factories own adapter
 * logic, while state-consistency recovery lives here. Called from server() init
 * (reconcileActivation + reconcileCrashedTeams)
 * and from the event handler (handleSessionDeleted on session.deleted).
 *
 * reconcileOne releases stale resources for teams left in a non-terminal state:
 *   - busy: release stale mailbox reservations and snapshot the active task onto
 *     lastInterruptedTask for a later team_resume. PID-based fencing: when the
 *     recorded runner PID is confirmed dead (ESRCH), the team is marked failed
 *     and activeTask cleared; a live or unknown PID keeps the team busy on disk
 *     (concurrent-instance safety — listAllTeams traverses ALL session
 *     directories, so a live sibling process's busy team must not be touched).
 *     The user resolves a leftover busy team via team_cancel or team_resume.
 *   - idle: release stale reservations (members reusable as-is).
 * live / failed are terminal-or-pristine → skipped.
 * Runs once in server() init, AFTER rebuildSessionIndex, BEFORE startSweepTimer.
 * Safe to use the mutex here: hooks are not yet registered, so no event handler
 * runs concurrently. Iterates BOTH scopes: project (session-segmented) + user
 * (flat).
 *
 * Layer note: lives in orchestration/lifecycle/ (not state/) for historical
 * reasons — the original implementation persisted terminated run records here.
 * That persistence was removed; the module stays put to avoid wide import
 * churn.
 */

import fs from "node:fs/promises"
import path from "node:path"

import type { PluginContext } from "../../core/context.js"
import { invalidateTeam, listAllTeams, loadTeamState, saveTeamState } from "../../state/store.js"
import { unindexSession } from "../../state/resolve.js"
import { assertSafeSegment, deletedMarkerPath, teamDir, worktreesDir } from "../../state/paths.js"
import { atomicWrite, LOCK_TTL_MS } from "../../state/locks.js"
import { destroyWorktree, hasUncommittedChanges } from "../../state/worktrees.js"
import { releaseStaleReservations } from "../../messaging/mailbox.js"
import { logSwallowed } from "../../core/log.js"

/**
 * Release stale resources for one team and snapshot a busy team's active
 * task onto lastInterruptedTask (see module header). Runs under the team
 * mutex; returns collected per-team failures for the caller to aggregate.
 */
async function reconcileOne(team: Awaited<ReturnType<typeof loadTeamState>>, ctx: PluginContext): Promise<unknown[]> {
    const failures: unknown[] = []
    if (team.status !== "busy" && team.status !== "idle") return failures
    // Check whether a busy team's runner is alive before releasing reservations;
    // re-queuing deliveries owned by a live sibling process could execute them twice.
    let processAlive = false
    if (team.status === "busy" && team.runnerPid !== undefined) {
        try {
            process.kill(team.runnerPid, 0)
            processAlive = true
        } catch (err) {
            // ESRCH means dead; other errors (EPERM) mean alive but different user
            processAlive = (err as NodeJS.ErrnoException).code !== "ESRCH"
        }
    }
    await team.mutex.runExclusive(async () => {
        // Skip reservation release for busy teams with a live process.
        if (team.status === "busy" && processAlive) return
        try {
            await releaseStaleReservations(team.directory, "master")
        } catch (err) {
            logSwallowed(ctx, "release stale reservations failed (master)", err, { team: team.teamName })
            failures.push(err)
        }
        for (const m of team.members) {
            // Skip running members. This
            // team may belong to a live sibling process (see comment below);
            // reclaiming a running member's reservations mid-processing would
            // cause duplicate delivery on the next poll. If the process truly
            // crashed, the member's status will be stale and the next sweep
            // tick's missed-idle reconciliation will handle it.
            if (m.status === "running") continue
            try {
                await releaseStaleReservations(team.directory, m.name)
            } catch (err) {
                logSwallowed(ctx, "release stale reservations failed", err, { team: team.teamName, member: m.name })
                failures.push(err)
            }
        }
        let didBranchSave = false
        // If spawning=true but the runner PID is dead, the
        // previous process crashed during spawn. Clear the stale flag.
        // Only clear if we can confirm the owner is dead (PID check).
        if (team.spawning && team.runnerPid !== undefined) {
            try {
                process.kill(team.runnerPid, 0)
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === "ESRCH") {
                    team.spawning = false
                    team.spawningOwner = undefined
                }
            }
        } else if (team.spawning && team.runnerPid === undefined) {
            // Spawning without runnerPid is the normal Phase 2 state. A state
            // file unchanged for more than 2× LOCK_TTL_MS indicates that the
            // spawning process died, with _diskMtime as the last-write timestamp.
            if (team._diskMtime !== undefined) {
                const age = Date.now() - team._diskMtime
                if (age > LOCK_TTL_MS * 2) {
                    team.spawning = false
                    team.spawningOwner = undefined
                }
            } else {
                // No mtime info — can't determine age. Leave as-is to
                // avoid stealing a live lease.
            }
        }
        if (team.status === "busy") {
            // PID-based fencing marks a busy team failed only when its recorded
            // runner is confirmed dead, which keeps live sibling processes safe.
            let isCrashed = false
            if (team.runnerPid !== undefined) {
                try {
                    process.kill(team.runnerPid, 0)  // signal 0 checks liveness only
                } catch (err) {
                    // Only ESRCH means "process dead"; EPERM indicates a live
                    // process owned by another user.
                    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
                        isCrashed = true
                    }
                }
            }
            if (isCrashed) {
                team.status = "failed"
                if (team.activeTask) team.lastInterruptedTask = team.activeTask
                // Clear activeTask so the team has a consistent `failed` state.
                // team_resume and team_cancel reject `failed + activeTask`, and
                // activeTeams() would otherwise keep it in the sweep loop.
                team.activeTask = undefined
                try {
                    await saveTeamState(team)
                    didBranchSave = true
                } catch (err) {
                    logSwallowed(ctx, "persist crashed team state failed (reconcile)", err, { team: team.teamName })
                    failures.push(err)
                }
            } else if (team.activeTask) {
                // No PID or process is alive: preserve state for eventual
                // team_resume but keep status=busy (concurrent-instance safety).
                team.lastInterruptedTask = team.activeTask
                try {
                    await saveTeamState(team)
                    didBranchSave = true
                } catch (err) {
                    logSwallowed(ctx, "persist interrupted team state failed (reconcile)", err, { team: team.teamName })
                    failures.push(err)
                }
            }
        }
        // The crash and interrupt branches above already saved when
        // applicable. Only save here if no branch saved (e.g. team was idle
        // but we still released reservations and want to persist that).
        if (!didBranchSave) {
            try {
                await saveTeamState(team)
            } catch (err) {
                logSwallowed(ctx, "persist team state failed (reconcile)", err, { team: team.teamName })
                failures.push(err)
            }
        }
    })
    return failures
}

/** Release stale resources for every team left in a non-terminal state after a crash. */
export async function reconcileCrashedTeams(ctx: PluginContext): Promise<void> {
    const failures: unknown[] = []
    for (const scope of [
        { root: ctx.projectStorageRoot, segmented: true },
        { root: ctx.userStorageRoot, segmented: false },
    ]) {
        let teams: Awaited<ReturnType<typeof listAllTeams>>
        try {
            teams = await listAllTeams(scope.root, scope.segmented)
        } catch (err) {
            logSwallowed(ctx, "failed to list teams (reconcile)", err, { root: scope.root })
            failures.push(err)
            continue
        }
        for (const { leadSessionId, teamName } of teams) {
            try {
                const team = await loadTeamState(scope.root, teamName, leadSessionId)
                failures.push(...await reconcileOne(team, ctx))
            } catch (err) {
                logSwallowed(ctx, "skipped unreadable state (reconcile)", err, { dir: teamName })
                failures.push(err)
            }
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, `reconcileCrashedTeams failed for ${failures.length} team or scope operation(s)`)
    }
}

/**
 * Restart invariant: never auto-activate. Clears every team's persisted
 * activatedAt on plugin startup so that, after an OpenCode restart, ALL teams
 * are inactive regardless of their prior state. The in-memory active pointer is
 * likewise empty — indexScope no longer restores it from activatedAt. The user
 * must call team_activate explicitly to make a team available. Runs once in
 * server() init, AFTER rebuildSessionIndex.
 */
export async function reconcileActivation(ctx: PluginContext): Promise<void> {
    const failures: unknown[] = []
    for (const scope of [
        { root: ctx.projectStorageRoot, seg: true },
        { root: ctx.userStorageRoot, seg: false },
    ]) {
        let teams: Awaited<ReturnType<typeof listAllTeams>>
        try {
            teams = await listAllTeams(scope.root, scope.seg)
        } catch (err) {
            logSwallowed(ctx, "failed to list teams (reconcileActivation)", err, { root: scope.root })
            failures.push(err)
            continue
        }
        for (const { leadSessionId, teamName } of teams) {
            try {
                const team = await loadTeamState(scope.root, teamName, leadSessionId)
                if (team.activatedAt === undefined) continue
                // Only clear activatedAt for teams in the CURRENT
                // project scope. User-scope teams may be active in sibling
                // processes — clearing them would deactivate a live team.
                // In project scope, clearing is safe because only the current
                // process owns this project.
                if (!scope.seg) continue  // skip user-scope teams
                await team.mutex.runExclusive(async () => {
                    team.activatedAt = undefined
                    await saveTeamState(team)
                })
            } catch (err) {
                logSwallowed(ctx, "skipped unreadable team state (reconcileActivation)", err, { dir: teamName })
                failures.push(err)
            }
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, `reconcileActivation failed for ${failures.length} team or scope operation(s)`)
    }
}

/**
 * Session-scoping cleanup on session.deleted. Removes any project-scope teams
 * owned by the deleted session (the whole <projectStorageRoot>/<sid>/ dir) and
 * drops its index entry (both member and master maps). For a deleted MEMBER
 * session (no owned dir), only the unindex applies. User-scope is flat —
 * nothing to remove there.
 */
export async function handleSessionDeleted(ctx: PluginContext, sessionID: string): Promise<void> {
    try {
        // Defense-in-depth: validate sessionID as a safe path segment before
        // the recursive fs.rm below. sessionID is host-assigned (trusted within
        // the threat model), but teamsDir applies the same check to
        // leadSessionId "so a malformed value can never escape the storage root
        // via path traversal" — this mirrors that posture for consistency.
        assertSafeSegment(sessionID, "handleSessionDeleted", "sessionID")
        const teams = await listAllTeams(ctx.projectStorageRoot, true)
        const ownedTeams: Array<Awaited<ReturnType<typeof loadTeamState>>> = []
        const unverifiableWorktrees: string[] = []
        for (const { leadSessionId, teamName } of teams) {
            if (leadSessionId !== sessionID) continue
            try {
                ownedTeams.push(await loadTeamState(ctx.projectStorageRoot, teamName, leadSessionId))
            } catch (err) {
                logSwallowed(ctx, "team state unreadable during session deletion", err, { team: teamName })
                try {
                    const entries = await fs.readdir(worktreesDir(teamDir(ctx.projectStorageRoot, teamName, leadSessionId)))
                    if (entries.length > 0) unverifiableWorktrees.push(teamName)
                } catch (scanError) {
                    if ((scanError as NodeJS.ErrnoException).code !== "ENOENT") {
                        unverifiableWorktrees.push(teamName)
                    }
                }
            }
        }

        if (unverifiableWorktrees.length > 0) {
            throw new Error(`refusing session deletion: worktrees cannot be verified for: ${unverifiableWorktrees.join(", ")}`)
        }

        const dirtyWorktrees: string[] = []
        for (const team of ownedTeams) {
            for (const member of team.members) {
                if (member.worktreePath && await hasUncommittedChanges(member.worktreePath)) {
                    dirtyWorktrees.push(`${team.teamName}/${member.name}`)
                }
            }
        }
        if (dirtyWorktrees.length > 0) {
            throw new Error(`refusing session deletion: uncommitted worktrees: ${dirtyWorktrees.join(", ")}`)
        }

        for (const team of ownedTeams) {
            for (const member of team.members) {
                const destroyed = await destroyWorktree(
                    ctx.directory,
                    member.worktreePath,
                    worktreesDir(team.directory),
                    team.teamName,
                    member.name,
                )
                if (!destroyed) {
                    throw new Error(`refusing session deletion: worktree cleanup failed for ${team.teamName}/${member.name}`)
                }
            }
        }

        // Collect directories to invalidate AFTER fs.rm so that during the
        // deletion window, cache hits return the tombstoned team object
        // (deleted=true) and racing handlers no-op instead of recreating
        // the directory via saveTeamState.
        const dirsToInvalidate: string[] = []
        for (const team of ownedTeams) {
            team.deleted = true  // tombstone: prevent racing handlers from resurrecting
            // Write a durable deletion marker before fs.rm.
            // saveTeamState skips deleted teams, so the in-memory tombstone
            // alone is not crash-safe. Write a marker file so the next
            // startup detects the deletion.
            try {
                const marker = deletedMarkerPath(team.directory)
                await atomicWrite(marker, team.teamRunId, path.dirname(team.directory))
            } catch (markerErr) {
                logSwallowed(ctx, "failed to write deletion marker", markerErr, { team: team.teamName })
            }
            dirsToInvalidate.push(team.directory)
        }
        const sessionDir = path.join(ctx.projectStorageRoot, sessionID)
        await fs.rm(sessionDir, { recursive: true, force: true })
        for (const dir of dirsToInvalidate) {
            invalidateTeam(dir)
        }
    } catch (err) {
        // Cleanup is best-effort so it never blocks the event handler, but
        // failures are logged so orphaned session directories remain diagnosable.
        // Evict cached tombstones after an fs.rm failure so the next access
        // reloads the still-present team state from disk.
        logSwallowed(ctx, "session deletion cleanup failed", err, { sessionID })
        // Clear tombstones by evicting from cache — the next access reloads
        // from disk, which still has the non-deleted state.
        for (const { leadSessionId, teamName } of await listAllTeams(ctx.projectStorageRoot, true).catch(() => [])) {
            if (leadSessionId !== sessionID) continue
            try {
                const dir = teamDir(ctx.projectStorageRoot, teamName, leadSessionId)
                invalidateTeam(dir)
            } catch { /* best-effort */ }
        }
    }
    // Always unindex (covers lead sessions with teams AND bare member sessions).
    unindexSession(sessionID)
}

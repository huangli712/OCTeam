/**
 * Crash recovery + session-lifecycle cleanup. Extracted from hooks.ts so the
 * hook factories file owns only adapter logic; state-consistency recovery lives
 * here. Called from server() init (reconcileActivation + reconcileCrashedTeams)
 * and from the event handler (handleSessionDeleted on session.deleted).
 *
 * reconcileOne releases stale resources for teams left in a non-terminal state:
 *   - busy: release stale mailbox reservations and snapshot the active task onto
 *     lastInterruptedTask for a later team_resume. The team is NOT auto-failed,
 *     because listAllTeams traverses ALL session directories and a concurrent
 *     OpenCode instance must not mark another live process's busy team as failed.
 *     A genuinely crashed process's busy team stays busy on disk; the user
 *     resolves it via team_cancel or team_resume.
 *   - idle: release stale reservations (members reusable as-is).
 * live / failed are terminal-or-pristine → skipped.
 * Runs once in server() init, AFTER rebuildSessionIndex, BEFORE startSweepTimer.
 * Safe to use the mutex here: hooks are not yet registered, so no event handler
 * runs concurrently. Iterates BOTH scopes: project (session-segmented) + user
 * (flat).
 *
 * Layer note: lives in orchestration/lifecycle/ (not state/) for historical reasons —
 * the original implementation persisted terminated run records here, which a
 * state/ placement would have inverted the layer dependency. That run-record
 * persistence was removed (see reconcileOne), but the module stays in
 * orchestration/lifecycle/ to avoid a wide import churn.
 */

import fs from "node:fs/promises"
import path from "node:path"

import type { PluginContext } from "../../core/context.js"
import { invalidateTeam, listAllTeams, loadTeamState, saveTeamState } from "../../state/store.js"
import { unindexSession } from "../../state/resolve.js"
import { assertSafeSegment, teamDir } from "../../state/paths.js"
import { releaseStaleReservations } from "../../messaging/mailbox.js"
import { logSwallowed } from "../../core/log.js"

async function reconcileOne(team: Awaited<ReturnType<typeof loadTeamState>>, ctx: PluginContext): Promise<void> {
    if (team.status !== "busy" && team.status !== "idle") return
    await team.mutex.runExclusive(async () => {
        await releaseStaleReservations(team.directory, "master").catch(err =>
            logSwallowed(ctx, "release stale reservations failed (master)", err, { team: team.teamName })
        )
        for (const m of team.members) {
            // H-L8: skip running members, matching H13 in sweepTeamOnce. This
            // team may belong to a live sibling process (see comment below);
            // reclaiming a running member's reservations mid-processing would
            // cause duplicate delivery on the next poll. If the process truly
            // crashed, the member's status will be stale and the next sweep
            // tick's missed-idle reconciliation will handle it.
            if (m.status === "running") continue
            await releaseStaleReservations(team.directory, m.name).catch(err =>
                logSwallowed(ctx, "release stale reservations failed", err, { team: team.teamName, member: m.name })
            )
        }
        if (team.status === "busy") {
            // H38: PID-based fencing. If runnerPid is set and the process is
            // dead, the team IS crashed → safe to fail (enables team_resume).
            // Pre-fix code never auto-failed busy teams because without PID
            // tracking there was no safe way to tell crashed from live sibling.
            let isCrashed = false
            if (team.runnerPid !== undefined) {
                try {
                    process.kill(team.runnerPid, 0)  // signal 0 checks liveness only
                } catch (err) {
                    // M#2: only treat ESRCH as "process dead". Pre-fix code
                    // considered ANY error (including EPERM) as crashed, so a
                    // process owned by another user would be falsely failed.
                    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
                        isCrashed = true
                    }
                }
            }
            if (isCrashed) {
                team.status = "failed"
                if (team.activeTask) team.lastInterruptedTask = team.activeTask
                await saveTeamState(team)
            } else if (team.activeTask) {
                // No PID or process is alive: preserve state for eventual
                // team_resume but keep status=busy (concurrent-instance safety).
                team.lastInterruptedTask = team.activeTask
                await saveTeamState(team)
            }
        }
        await saveTeamState(team).catch((err) =>
            logSwallowed(ctx, "persist team state failed (reconcile)", err, { team: team.teamName })
        )
    })
}

/** Release stale resources for every team left in a non-terminal state after a crash. */
export async function reconcileCrashedTeams(ctx: PluginContext): Promise<void> {
    // Project scope: teams live under <projectStorageRoot>/<leadSessionId>/teams/.
    for (const { leadSessionId, teamName } of await listAllTeams(ctx.projectStorageRoot, true)) {
        try {
            const team = await loadTeamState(ctx.projectStorageRoot, teamName, leadSessionId)
            await reconcileOne(team, ctx)
        } catch (err) {
            logSwallowed(ctx, "skipped unreadable state (reconcile)", err, { dir: teamName })
            continue
        }
    }
    // User scope: flat layout (<userStorageRoot>/teams/<name>/), no session segment.
    for (const { teamName } of await listAllTeams(ctx.userStorageRoot, false)) {
        try {
            const team = await loadTeamState(ctx.userStorageRoot, teamName)
            await reconcileOne(team, ctx)
        } catch (err) {
            logSwallowed(ctx, "skipped unreadable state (reconcile)", err, { dir: teamName })
            continue
        }
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
    for (const scope of [
        { root: ctx.projectStorageRoot, seg: true },
        { root: ctx.userStorageRoot, seg: false },
    ]) {
        for (const { leadSessionId, teamName } of await listAllTeams(scope.root, scope.seg)) {
            try {
                const team = await loadTeamState(scope.root, teamName, leadSessionId)
                if (team.activatedAt === undefined) continue
                await team.mutex.runExclusive(async () => {
                    team.activatedAt = undefined
                    await saveTeamState(team)
                })
            } catch (err) {
                logSwallowed(ctx, "skipped unreadable team state (reconcileActivation)", err, { dir: teamName })
            }
        }
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
        // Collect directories to invalidate AFTER fs.rm so that during the
        // deletion window, cache hits return the tombstoned team object
        // (deleted=true) and racing handlers no-op instead of recreating
        // the directory via saveTeamState.
        const dirsToInvalidate: string[] = []
        for (const { leadSessionId, teamName } of teams) {
            if (leadSessionId !== sessionID) continue
            try {
                const team = await loadTeamState(ctx.projectStorageRoot, teamName, leadSessionId)
                team.deleted = true  // tombstone: prevent racing handlers from resurrecting
                // H-L12: persist the tombstone BEFORE removing the directory.
                // Pre-fix code only set deleted in memory and invalidated the
                // cache — a process crash between here and fs.rm would leave
                // the state.json on disk without the tombstone, and the next
                // startup would see the team as alive with stale sessionIds.
                try { await saveTeamState(team) } catch (e) {
                    logSwallowed(ctx, "saveTeamState failed during session deletion", e, { team: teamName })
                }
                dirsToInvalidate.push(team.directory)
            } catch (err) {
                logSwallowed(ctx, "team state unreadable during session deletion", err, { team: teamName })
            }
        }
        const sessionDir = path.join(ctx.projectStorageRoot, sessionID)
        await fs.rm(sessionDir, { recursive: true, force: true })
        for (const dir of dirsToInvalidate) {
            invalidateTeam(dir)
        }
    } catch (err) {
        // M-7: best-effort — never block the event handler on cleanup, but log
        // so orphaned session directories are diagnosable. Pre-fix code set
        // team.deleted=true (tombstone) BEFORE fs.rm, then invalidated the
        // cache AFTER fs.rm. On fs.rm failure, the tombstoned teams stayed
        // deleted=true in the cache (invisible to all handlers) even though
        // the directory still existed on disk. The fix reverts the tombstone
        // on fs.rm failure so the team remains usable until the next retry.
        // We cannot easily revert tombstones here because the team objects
        // were already captured; instead, reload and clear.
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

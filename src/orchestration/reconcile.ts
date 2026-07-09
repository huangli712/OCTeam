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
 * Layer note: lives in orchestration/ (not state/) for historical reasons —
 * the original implementation persisted terminated run records here, which a
 * state/ placement would have inverted the layer dependency. That run-record
 * persistence was removed (see reconcileOne), but the module stays in
 * orchestration/ to avoid a wide import churn.
 */

import fs from "node:fs/promises"
import path from "node:path"

import type { PluginContext } from "../core/context.js"
import { invalidateTeam, listAllTeams, loadTeamState, saveTeamState } from "../state/store.js"
import { unindexSession } from "../state/resolve.js"
import { assertSafeSegment } from "../state/paths.js"
import { releaseStaleReservations } from "../messaging/mailbox.js"
import { logSwallowed } from "../core/log.js"

async function reconcileOne(team: Awaited<ReturnType<typeof loadTeamState>>, ctx: PluginContext): Promise<void> {
    if (team.status !== "busy" && team.status !== "idle") return
    await team.mutex.runExclusive(async () => {
        await releaseStaleReservations(team.directory, "master").catch(() => {})
        for (const m of team.members) {
            await releaseStaleReservations(team.directory, m.name).catch(() => {})
        }
        if (team.status === "busy") {
            // Do NOT auto-fail a busy team here. The original logic assumed the
            // current process always owns every team it can see, but project-scope
            // teams are leadSessionId-segmented and listAllTeams traverses ALL
            // session directories — a concurrent OpenCode instance (e.g. spawned
            // for config probing or a sibling session) running server() init will
            // see another live process's busy team and incorrectly mark it failed,
            // writing a spurious terminated:interrupted event that fools the leader
            // into cancelling a healthy in-flight orchestration.
            //
            // Instead, only preserve the active task snapshot for an explicit
            // team_resume. A genuinely crashed process's busy team stays busy on
            // disk; the user resolves it via team_cancel or team_resume. Releasing
            // stale reservations above is safe and reversible.
            if (team.activeTask) {
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
        for (const { leadSessionId, teamName } of teams) {
            if (leadSessionId !== sessionID) continue
            try {
                const team = await loadTeamState(ctx.projectStorageRoot, teamName, leadSessionId)
                invalidateTeam(team.directory)
            } catch {
                // already gone — skip
            }
        }
        const sessionDir = path.join(ctx.projectStorageRoot, sessionID)
        await fs.rm(sessionDir, { recursive: true, force: true })
    } catch {
        // best-effort — never block the event handler on cleanup
    }
    // Always unindex (covers lead sessions with teams AND bare member sessions).
    unindexSession(sessionID)
}

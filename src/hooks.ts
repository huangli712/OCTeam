/**
 * Hook factories + sweep timer. These adapt the orchestration core
 * (processIdle, handleStatusEvent) and the mailbox drain (Transform hook) into
 * the OpenCode Hooks.event / experimental.chat.messages.transform signatures,
 * and run a periodic sweep timer that babysits busy teams (crash recovery,
 * missed-idle reconciliation, termination enforcement).
 */

import fs from "node:fs/promises"
import path from "node:path"

import type { Hooks } from "@opencode-ai/plugin"

import type { PluginContext } from "./core/context.js"
import { activeTeams, clearActiveTask, invalidateTeam, listAllTeams, loadTeamState, saveTeamState } from './state/store.js';
import { resolveMasterTeams, resolveTeamMember, isMasterSession, unindexSession } from "./core/utils.js"
import { ackMessages, formatMailboxInjection, pollMailbox, releaseStaleReservations } from "./messaging/mailbox.js"
import { reapStaleClaims } from "./state/tasks.js"
import { handleStatusEvent, processIdle } from "./orchestration/handlers.js"
import { checkTermination } from "./orchestration/termination.js"
import type { MemberState } from "./core/types.js"
import { logEvent, logSwallowed } from "./core/log.js"

const SWEEP_INTERVAL_MS = 15_000

/**
 * Compaction-context suppression (Q2 guard). The `experimental.chat.messages.transform`
 * hook fires both on live prompt turns AND during session compaction (where it
 * receives a structuredClone of the head messages — see decompiled trigger site).
 * Injecting into the clone is lost, but pollMailbox+ackMessages have REAL side
 * effects → silent message loss. We can't distinguish the two from input (`{}`),
 * so we mark a session as "compacting" via the experimental.session.compacting
 * hook and consume-once-skip the very next transform for it. TTL bounds a stuck
 * flag (if compaction aborts before transform) to a single delayed turn.
 */
const compacting = new Map<string, number>() // sessionID -> expiresAt
const COMPACTING_FLAG_TTL_MS = 15_000

/**
 * Marks a session as currently compacting (Q2 guard). Registered under
 * experimental.session.compacting in server init. The transform hook consumes
 * this flag once to skip the compaction-clone turn.
 */
export function createCompactingHook(): NonNullable<Hooks["experimental.session.compacting"]> {
    return async input => {
        const sid = (input as { sessionID?: string }).sessionID
        if (sid) compacting.set(sid, Date.now() + COMPACTING_FLAG_TTL_MS)
    }
}

/**
 * The single event handler. Filters by event.type, resolves the
 * session to a team member, and runs processIdle under the team mutex. Master
 * sessions are resolved as synthetic members so their queued results drain.
 */
export function createEventHandler(ctx: PluginContext): NonNullable<Hooks["event"]> {
    return async ({ event }) => {
        const type = (event as { type?: string }).type
        const props = (event as { properties?: Record<string, unknown> }).properties

        // session.status carries retry/error signals that session.idle does not.
        if (type === "session.status") {
            await handleStatusEvent(ctx, event as { properties?: Record<string, unknown>; type?: string })
            return
        }

        // Session-scoping cleanup: when a session is deleted, remove any
        // project-scope teams it owned and drop its index entry. User-scope is
        // flat (no session segment) so only unindex applies there.
        if (type === "session.deleted") {
            const sid = (props as { sessionID?: string } | undefined)?.sessionID
                ?? (event as { id?: string }).id
            if (sid) await handleSessionDeleted(ctx, sid)
            return
        }

        if (type !== "session.idle") return

        const sessionID = (props as { sessionID?: string } | undefined)?.sessionID
        if (!sessionID) return

        // Master drain-all: a master session may own MULTIPLE teams. Drain each
        // owned team's master mailbox under that team's own mutex, independent of
        // which team is "active" — activation governs interaction, not delivery.
        // processIdle's master branch (Step 0) drains queued results; no dispatch.
        if (isMasterSession(sessionID)) {
            for (const e of resolveMasterTeams(sessionID)) {
                try {
                    const team = await loadTeamState(e.storageRoot, e.teamName, e.leadSessionId)
                    await team.mutex.runExclusive(async () => {
                        await processIdle(ctx, team, masterPseudoMember(), sessionID)
                        await saveTeamState(team).catch((err) =>
                            logSwallowed(ctx, "persist team state failed (master idle)", err, { team: team.teamName })
                        )
                    })
                } catch (err) {
                    logSwallowed(ctx, "skipped unreadable team state", err, { dir: e.directory })
                }
            }
            return
        }

        // Member path — single team (1:1). Unchanged behavior.
        const member = await resolveTeamMember(ctx.storageRoot, sessionID)
        if (!member) return // not a team member (the common case)
        const team = await loadTeamState(member.storageRoot, member.teamName, member.leadSessionId)
        await team.mutex.runExclusive(async () => {
            // operate on the LIVE member object so mutations persist
            const live = team.members.find(m => m.name === member.name)
            if (!live) return
            await processIdle(ctx, team, live, sessionID)
            // Flush any terminal transition (busy→idle/failed) the handlers made
            // under the mutex. processIdle's internal save runs before dispatch while
            // status is still "busy"; without this the idle/failed status never reaches
            // disk and the sidebar (which reads state.json directly) stays stale.
            await saveTeamState(team).catch((err) =>
                logSwallowed(ctx, "persist team state failed (member idle)", err, { team: team.teamName, member: live.name })
            )
        })
    }
}

/** Build the synthetic master pseudo-member for a team's drain-all pass. */
function masterPseudoMember(): MemberState & { isMaster: true } {
    return {
        name: "master",
        isMaster: true,
        status: "idle",
        initialized: true,
        turnCount: 0,
    }
}

/**
 * Transform hook (Layer 3 of the three-layer communication model). On each chat turn for a team member,
 * atomically poll-and-reserve its mailbox and inject unread messages as a
 * synthetic text part on the last user message. Uses the same reservation
 * protocol as the master drain path → exactly-once delivery.
 *
 * sessionID source (Q1 fix): the SDK types this hook's `input` as `{}` and the
 * runtime passes `{}` at BOTH trigger sites (main loop + compaction), so the old
 * `input.sessionID` read was always undefined → the hook early-returned every
 * time and the mailbox was never drained. Each Message (UserMessage |
 * AssistantMessage) carries a required `info.sessionID`, so we read it from
 * `output.messages` instead — all messages in one transform call belong to the
 * same session.
 */
export function createTransformHook(
    ctx: PluginContext,
): NonNullable<Hooks["experimental.chat.messages.transform"]> {
    return async (_input, output) => {
        // Q1: read sessionID from the messages (input is `{}`). All messages in a
        // single transform call share one sessionID.
        const messages = output.messages as Array<{
            info?: { sessionID?: string; role?: string }
            parts?: any[]
        }>
        const sessionID = messages.find(m => m.info?.sessionID)?.info?.sessionID
        if (!sessionID) return

        const member = await resolveTeamMember(ctx.storageRoot, sessionID)
        if (!member) return

        // Q3: the master (leader) mailbox is drained by the event handler's
        // deliverQueuedResultsToMaster (promptAsync, distinct turn). Skip it here
        // to avoid inline-injecting team results into the user's interactive turn.
        if (member.isMaster) return

        // Q2: compaction guard. This hook also fires on a structuredClone of the
        // head during compaction — injecting there is lost, but pollMailbox +
        // ackMessages have real side effects → silent message loss. Consume the
        // compacting flag once and skip the clone turn (TTL bounds a stuck flag).
        const deadline = compacting.get(sessionID)
        if (deadline !== undefined) {
            compacting.delete(sessionID) // consume-once: next live transform proceeds
            if (Date.now() < deadline) return
        }

        const unread = await pollMailbox(member.directory, member.name)
        if (unread.length === 0) return

        const injection = formatMailboxInjection(unread)

        // Append the injection as a synthetic text part to an existing message
        // (prefer the last user message) rather than fabricating a partial Message
        // object. A hand-rolled { info: { role } } is missing required Message fields
        // and risks crashing the host renderer / token accounting.
        let targetIdx = -1
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]?.info?.role === "user") {
                targetIdx = i
                break
            }
        }
        if (targetIdx === -1) targetIdx = messages.length - 1
        if (targetIdx < 0) return // nothing to attach to; leave reserved for retry (do NOT ack)
        const target = messages[targetIdx]
        const parts = (target.parts = target.parts ?? [])
        parts.push({ type: "text", text: injection, synthetic: true })

        await ackMessages(member.directory, member.name, unread)
    }
}

/**
 * Crash recovery. On plugin startup, reconcile teams left in a
 * non-terminal state by a previous process that crashed mid-orchestration:
 *   - busy: the in-flight orchestration cannot resume deterministically — release
 *     stale mailbox reservations, mark running members errored, and transition the
 *     team to "failed". Its sessions persist and are reusable by a fresh workflow
 *     call (ensureMembersReady reuses members that already have a sessionId).
 *   - idle: release stale reservations (members reusable as-is).
 * live / failed are terminal-or-pristine → skipped.
 * Runs once in server() init, AFTER rebuildSessionIndex, BEFORE startSweepTimer.
 * Safe to use the mutex here: hooks are not yet registered, so no event handler
 * runs concurrently. Iterates BOTH scopes: project (session-segmented) + user
 * (flat).
 */
async function reconcileOne(team: Awaited<ReturnType<typeof loadTeamState>>, ctx: PluginContext): Promise<void> {
    if (team.status !== "busy" && team.status !== "idle") return
    await team.mutex.runExclusive(async () => {
        await releaseStaleReservations(team.directory, "master").catch(() => {})
        for (const m of team.members) {
            await releaseStaleReservations(team.directory, m.name).catch(() => {})
        }
        if (team.status === "busy") {
            // Interrupted orchestration is unrecoverable — fail it cleanly.
            clearActiveTask(team)
            team.status = "failed"
            for (const m of team.members) {
                if (m.status === "running") {
                    m.status = "errored"
                    m.error = "interrupted by plugin/host restart"
                }
            }
        }
        await saveTeamState(team).catch((err) =>
            logSwallowed(ctx, "persist team state failed (reconcile)", err, { team: team.teamName })
        )
    })
}

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
async function handleSessionDeleted(ctx: PluginContext, sessionID: string): Promise<void> {
    try {
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

export function startSweepTimer(ctx: PluginContext): NodeJS.Timeout {
    return setInterval(async () => {
        try {
            // No directory filter — include sessions in member worktrees too.
            const statusResult = await ctx.client.session.status({})
            const statusMap = (statusResult.data ?? {}) as Record<string, { type: string }>

            for (const team of activeTeams()) {
                await team.mutex.runExclusive(async () => {
                    // 1. Reclaim stale resources.
                    await releaseStaleReservations(team.directory, "master")
                    for (const m of team.members) {
                        await releaseStaleReservations(team.directory, m.name)
                    }
                    if (team.activeTask?.type === "delegate") {
                        await reapStaleClaims(team.directory)
                    }
                    // 2. Termination checks run even if no idle arrives.
                    await checkTermination(ctx, team)
                    if (!team.activeTask) return
                    // 3. Missed-idle reconciliation.
                    for (const member of team.members) {
                        if (!member.sessionId || member.status !== "running") continue
                        if (statusMap[member.sessionId]?.type === "idle") {
                            await processIdle(ctx, team, member, member.sessionId)
                        }
                    }
                    await saveTeamState(team).catch((err) =>
                        logSwallowed(ctx, "persist team state failed (sweep)", err, { team: team.teamName })
                    )
                })
            }
        } catch (err) {
            logEvent(ctx, "error", "sweep iteration failed", { error: err instanceof Error ? err.message : String(err) })
        }
    }, SWEEP_INTERVAL_MS)
}

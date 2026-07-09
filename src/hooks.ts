/**
 * Hook factories + sweep timer. These adapt the orchestration core
 * (processIdle, handleStatusEvent) and the mailbox drain (Transform hook) into
 * the OpenCode Hooks.event / experimental.chat.messages.transform signatures,
 * and run a periodic sweep timer that babysits busy teams (missed-idle
 * reconciliation, termination enforcement). Crash recovery on startup lives in
 * orchestration/reconcile.ts.
 */

import type { Hooks } from "@opencode-ai/plugin"

import type { PluginContext } from "./core/context.js"
import { activeTeams, loadTeamState, saveTeamState } from './state/store.js';
import { resolveMasterTeams, resolveTeamMember, isMasterSession } from "./state/resolve.js"
import { ackMessages, formatMailboxInjection, pollMailbox, releaseStaleReservations } from "./messaging/mailbox.js"
import { reapStaleClaims } from "./state/tasks.js"
import { handleStatusEvent } from "./orchestration/status.js"
import { processIdle } from "./orchestration/idle.js"
import { checkTermination } from "./orchestration/termination.js"
import type { MemberState } from "./core/types.js"
import { logEvent, logSwallowed } from "./core/log.js"
import { handleSessionDeleted } from "./orchestration/reconcile.js"

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
            try {
                await handleStatusEvent(ctx, event as { properties?: Record<string, unknown>; type?: string })
            } catch (err) {
                logSwallowed(ctx, "session.status handler failed", err, { type })
            }
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
        // resolveTeamMember returns null for the common "not a team member"
        // case (index miss) — `if (!member) return` stays silent. But it can
        // ALSO throw: when the index hits but the team state is unreadable
        // (deleted team, corrupt state), resolveMemberFromIndex's internal
        // loadTeamState propagates the throw. The whole block is wrapped so any
        // throw is swallowed + logged, mirroring the master path's guarantee
        // that the host is never poisoned by an unhandled rejection.
        try {
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
        } catch (err) {
            logSwallowed(ctx, "member-idle handler failed", err, { sessionID })
        }
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

        // T5: runId-scoped directive filtering. A directive carrying a runId
        // belongs to one specific orchestration run; once that run ends the
        // directive is stale and must be dropped (not injected). Only consult
        // team state when at least one runId-scoped directive is present — this
        // guards against an unconditional team load on every turn.
        let toInject = unread
        const hasScopedDirective = unread.some(
            m => m.kind === "directive" && m.runId !== undefined,
        )
        if (hasScopedDirective) {
            let activeRunId: string | undefined
            let injectAllScoped = false
            try {
                const team = await loadTeamState(member.storageRoot, member.teamName, member.leadSessionId)
                activeRunId = team.activeTask?.runId
            } catch {
                // Team state unreadable — fall back to injecting all. The
                // ack-full-set below still prevents a reservation loop.
                injectAllScoped = true
            }
            toInject = unread.filter(m => {
                // Non-directives, and directives without a runId, always pass
                // (backward-compat with pre-T5 messages).
                if (m.kind !== "directive" || m.runId === undefined) return true
                // Scoped directive: inject only when it matches the active run;
                // a mismatch is a stale directive from an ended run → skip.
                // On unreadable team state, honor the "fall back to injecting
                // all" contract above instead of silently dropping them.
                if (injectAllScoped) return true
                return m.runId === activeRunId
            })
        }

        // Empty-injection guard: when every polled message was filtered out
        // (e.g. all stale directives), inject no text part — but still ack the
        // FULL reserved set below so the stale directives are dropped.
        if (toInject.length > 0) {
            const injection = formatMailboxInjection(toInject)

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
        }

        // ACK the FULL reserved set (T5 Part C), inject-or-not. Acking only the
        // injected subset would strand skipped stale directives in `reserved` →
        // releaseStaleReservations returns them after the TTL → pollMailbox
        // re-reserves → infinite loop. Ack-all drops stale directives exactly once.
        await ackMessages(member.directory, member.name, unread)
    }
}

/**
 * Per-team sweep body. Extracted from startSweepTimer so the tombstone guard
 * and per-team reclaim/termination/reconcile logic are unit-testable without
 * waiting on a real setInterval tick. Called once per active team per sweep.
 *
 * Runs the callback under team.mutex. The caller (startSweepTimer) snapshots
 * activeTeams() BEFORE acquiring each team's mutex — a team_delete can complete
 * between the snapshot and us acquiring the lock, so the tombstone guard at
 * the top is load-bearing (see processIdle handlers.ts:117 for the same
 * pattern). `statusMap` is the already-fetched session.status snapshot shared
 * across all teams in this sweep tick.
 */
export async function sweepTeamOnce(
    ctx: PluginContext,
    team: { directory: string; members: MemberState[]; deleted?: boolean; mutex: { runExclusive<T>(fn: () => Promise<T>): Promise<T> } },
    statusMap: Record<string, { type: string }>,
): Promise<void> {
    await team.mutex.runExclusive(async () => {
        // Tombstone guard: a team_delete may have completed (set
        // team.deleted + removed the on-disk directory) between
        // activeTeams() snapshotted this reference and us acquiring
        // its mutex. Bail before any state mutation or release*()
        // call — those funnel through withLock -> acquireLock ->
        // fs.mkdir({recursive:true}), which would otherwise
        // recreate the just-removed <teamDir>/mailbox/ directory.
        // Mirrors processIdle (handlers.ts:117) and
        // handleStatusEvent (handlers.ts:346) guards.
        if (team.deleted) return
        // 1. Reclaim stale resources.
        await releaseStaleReservations(team.directory, "master")
        for (const m of team.members) {
            await releaseStaleReservations(team.directory, m.name)
        }
        if ((team as { activeTask?: { type?: string } }).activeTask?.type === "delegate") {
            await reapStaleClaims(team.directory)
        }
        // 2. Termination checks run even if no idle arrives.
        await checkTermination(ctx, team as Parameters<typeof checkTermination>[1])
        if (!(team as { activeTask?: unknown }).activeTask) return
        // 3. Missed-idle reconciliation.
        for (const member of team.members) {
            if (!member.sessionId || member.status !== "running") continue
            if (statusMap[member.sessionId]?.type === "idle") {
                await processIdle(ctx, team as Parameters<typeof processIdle>[1], member, member.sessionId)
            }
        }
        await saveTeamState(team as Parameters<typeof saveTeamState>[0]).catch((err) =>
            logSwallowed(ctx, "persist team state failed (sweep)", err, { team: (team as { teamName?: string }).teamName ?? "(unknown)" })
        )
    })
}

export function startSweepTimer(ctx: PluginContext): NodeJS.Timeout {
    const handle = setInterval(async () => {
        try {
            // No directory filter — include sessions in member worktrees too.
            const statusResult = await ctx.client.session.status({})
            const statusMap = (statusResult.data ?? {}) as Record<string, { type: string }>
            for (const team of activeTeams()) {
                await sweepTeamOnce(ctx, team, statusMap)
            }
        } catch (err) {
            logEvent(ctx, "error", "sweep iteration failed", { error: err instanceof Error ? err.message : String(err) })
        }
    }, SWEEP_INTERVAL_MS)
    // .unref() so the sweep timer does not keep the host event loop alive on
    // graceful shutdown — mirrors the lock heartbeat (locks.ts:110). Retained
    // via `handle` so a future teardown could clearInterval(handle) if the
    // plugin lifecycle ever grows a reload path.
    handle.unref()
    return handle
}

/**
 * Hook factories + sweep timer. These adapt the orchestration core
 * (processIdle, handleStatusEvent) and the mailbox drain (Transform hook) into
 * the OpenCode Hooks.event / experimental.chat.messages.transform signatures,
 * and run a periodic sweep timer that babysits busy teams (missed-idle
 * reconciliation, termination enforcement). Crash recovery on startup lives in
 * orchestration/lifecycle/reconcile.ts.
 */

import type { Hooks } from "@opencode-ai/plugin"

import type { PluginContext } from "./core/context.js"
import type { Team } from "./state/store.js"
import { activeTeams, loadTeamState, saveTeamState } from "./state/store.js"
import { resolveMasterTeams, resolveTeamMember, isMasterSession } from "./state/resolve.js"
import { AckMessagesError, ackMessages, pollMailbox, releaseStaleReservations } from "./messaging/mailbox.js"
import { formatMailboxInjection } from "./messaging/format.js"
import { reapStaleClaims } from "./state/tasks.js"
import { handleStatusEvent, maybeEscalateRetry } from "./orchestration/lifecycle/status.js"
import { processErrorRecovery, processIdle } from "./orchestration/lifecycle/idle.js"
import { checkTermination } from "./orchestration/lifecycle/termination.js"
import { finishRun } from "./orchestration/control/completion.js"
import { handleSignoffIdle } from "./orchestration/control/signoff.js"
import { recordEvent } from "./orchestration/records/events.js"
import type { MemberState } from "./core/types.js"
import { asSdkMessages, extractSessionStatusEntry } from "./orchestration/protocol/output.js"
import { logEvent, logSwallowed } from "./core/log.js"
import { handleSessionDeleted } from "./orchestration/lifecycle/reconcile.js"

/** Narrow an unknown SDK event into a type+properties shape, or null. */
function narrowSdkEvent(event: unknown): { type?: string; properties?: Record<string, unknown> } | null {
    if (typeof event !== "object" || event === null) return null
    const e = event as Record<string, unknown>
    return {
        type: typeof e.type === "string" ? e.type : undefined,
        properties: typeof e.properties === "object" && e.properties !== null
            ? e.properties as Record<string, unknown>
            : undefined,
    }
}

/** Safely extract a string sessionID from an SDK event's properties or top-level id.
 * HIGH-G: SDK events come in multiple shapes across versions:
 *   - v1 / common: properties.sessionID
 *   - session.deleted (current SDK): properties.info.id
 *   - top-level id (fallback)
 * Read each in order so a session deletion does not silently leak the team
 * directory and master authorization index. */
function sdkEventSessionID(event: unknown): string | undefined {
    const narrowed = narrowSdkEvent(event)
    if (!narrowed) return undefined
    const fromProps = narrowed.properties?.sessionID
    if (typeof fromProps === "string" && fromProps) return fromProps
    // HIGH-G: current SDK's session.deleted event places the id at
    // properties.info.id (not properties.sessionID). Without this branch the
    // deletion handler never fires and team directories + master authorization
    // leak across plugin restarts.
    const fromInfo = narrowed.properties?.info
    if (typeof fromInfo === "object" && fromInfo !== null) {
        const infoId = (fromInfo as Record<string, unknown>).id
        if (typeof infoId === "string" && infoId) return infoId
    }
    if (typeof event === "object" && event !== null) {
        const id = (event as Record<string, unknown>).id
        if (typeof id === "string" && id) return id
    }
    return undefined
}

// Period between sweep-timer ticks (missed-idle reconciliation, termination enforcement).
const SWEEP_INTERVAL_MS = 15_000

// Max retry attempts for persistTeamState on transient disk failures.
const SAVE_MAX_ATTEMPTS = 3

// Backoff between persistTeamState retry attempts.
const SAVE_BACKOFF_MS = 100

/**
 * Compaction-context suppression. The `experimental.chat.messages.transform`
 * hook fires both on live prompt turns AND during session compaction (where it
 * receives a structuredClone of the head messages — see decompiled trigger site).
 * Injecting into the clone is lost, but pollMailbox+ackMessages have REAL side
 * effects → silent message loss. We can't distinguish the two from input (`{}`),
 * so we mark a session as "compacting" via the experimental.session.compacting
 * hook and consume-once-skip the very next transform for it. TTL bounds a stuck
 * flag (if compaction aborts before transform) to a single delayed turn.
 */
const compacting = new Map<string, number>() // sessionID -> expiresAt

// TTL for compacting flags; bounds a stuck flag if compaction aborts before transform.
const COMPACTING_FLAG_TTL_MS = 15_000
const COMPACTING_MAP_CAP = 64

/**
 * Save team state with bounded retry. Transient disk failures (EIO, ENOSPC)
 * are retried up to SAVE_MAX_ATTEMPTS times before giving up. On final failure
 * the error is logged at "error" level (not the default "warn") so operators
 * notice state drift between memory and disk.
 *
 * Runs inside the caller's team.mutex.runExclusive block; retries extend the
 * mutex hold by at most ~200ms, acceptable for event-handler and sweep paths.
 *
 * @internal Exported for hooks-error-swallow.test.ts. Production code calls
 * this only from createEventHandler and sweepTeamOnce.
 */
export async function persistTeamState(
    ctx: PluginContext,
    team: Team,
    label: string,
    extra: Record<string, unknown>,
): Promise<void> {
    let lastErr: unknown
    for (let attempt = 1; attempt <= SAVE_MAX_ATTEMPTS; attempt++) {
        try {
            await saveTeamState(team)
            return
        } catch (err) {
            lastErr = err
            if (attempt < SAVE_MAX_ATTEMPTS) {
                await new Promise(r => setTimeout(r, SAVE_BACKOFF_MS))
            }
        }
    }
    logSwallowed(ctx, label, lastErr, { ...extra, attempts: SAVE_MAX_ATTEMPTS }, "error")
}

/**
 * Marks a session as currently compacting. Registered under
 * experimental.session.compacting in server init. The transform hook consumes
 * this flag once to skip the compaction-clone turn.
 */
export function createCompactingHook(): NonNullable<Hooks["experimental.session.compacting"]> {
    return async input => {
        const sid = typeof input === "object" && input !== null
            ? (input as Record<string, unknown>).sessionID
            : undefined
        if (typeof sid === "string" && sid) compacting.set(sid, Date.now() + COMPACTING_FLAG_TTL_MS)
    }
}

/**
 * The single event handler. Filters by event.type, resolves the
 * session to a team member, and runs processIdle under the team mutex. Master
 * sessions are resolved as synthetic members so their queued results drain.
 */
export function createEventHandler(ctx: PluginContext): NonNullable<Hooks["event"]> {
    return async ({ event }) => {
        const narrowed = narrowSdkEvent(event)
        const type = narrowed?.type
        const props = narrowed?.properties

        // session.status carries retry/error signals that session.idle does not.
        if (type === "session.status") {
            try {
                if (narrowed) await handleStatusEvent(ctx, narrowed)
            } catch (err) {
                logSwallowed(ctx, "session.status handler failed", err, { type })
            }
            return
        }

        // Session-scoping cleanup: when a session is deleted, remove any
        // project-scope teams it owned and drop its index entry. User-scope is
        // flat (no session segment) so only unindex applies there.
        if (type === "session.deleted") {
            const sid = sdkEventSessionID(event)
            if (sid) {
                try {
                    await handleSessionDeleted(ctx, sid)
                } catch (err) {
                    logSwallowed(ctx, "session.deleted handler failed", err, { type })
                }
            }
            return
        }

        // H24: session.error fires on abort, auth failure, or unrecoverable
        // provider error. Without handling it the member stays "running" in
        // the in-memory index, blocking barrier completion until wall-clock
        // timeout. Map the error to a member escalation so checkTermination
        // can fail the run (tolerance-0) or mark a branch errored (fanout).
        if (type === "session.error") {
            const sessionID = (() => {
                const fromProps = props?.sessionID
                return typeof fromProps === "string" && fromProps ? fromProps : undefined
            })()
            if (!sessionID) return
            try {
                const member = await resolveTeamMember(ctx.storageRoot, sessionID)
                if (!member) return
                const team = await loadTeamState(member.storageRoot, member.teamName, member.leadSessionId)
                await team.mutex.runExclusive(async () => {
                    const live = team.members.find(m => m.name === member.name)
                    // HIGH #11: verify the error event's sessionID matches
                    // the live member's current session. A stale error from
                    // a replaced session must not affect the current run.
                    if (live?.sessionId !== undefined && live.sessionId !== sessionID) return
                    // H-SD: gate session.error on status === "running" + active
                    // task + not deleted. Without this, a stale session.error
                    // from an aborted turn (team_cancel/finishRun already reset
                    // the member to idle) would re-escalate the member to
                    // errored and potentially fail the next run via
                    // checkTermination.
                    if (!live || live.status !== "running") return
                    if (!team.activeTask) return
                    if (team.deleted) return
                    live.status = "errored"
                    // L5: serialize the full error info instead of relying on
                    // SDK properties.error being a string (it may be an object).
                    const errProps = narrowed?.properties
                    // HIGH: JSON.stringify can throw on circular refs or BigInt.
                    // Use a safe serializer that never throws.
                    const safeStringify = (v: unknown): string => {
                        try { return JSON.stringify(v) } catch { return String(v) }
                    }
                    const errMsg = errProps?.error !== undefined
                        ? (typeof errProps.error === "string" ? errProps.error : safeStringify(errProps.error))
                        : errProps?.message !== undefined
                            ? String(errProps.message)
                            : "unknown"
                    const errSession = typeof errProps?.sessionID === "string" ? errProps.sessionID : undefined
                    live.error = `session.error: ${errMsg}${errSession ? ` (session: ${errSession})` : ""}`
                    recordEvent(team, {
                        timestamp: Date.now(),
                        kind: "errored",
                        member: live.name,
                        reason: live.error,
                    })
                    await checkTermination(ctx, team)
                    // I-1: re-drive mode-specific barrier handlers after a member
                    // errors. Pre-fix code only drove signoff; parallel,
                    // delegate, recurse, quorum, etc. were never notified, so
                    // if the error was within tolerance the run stalled until
                    // wall-clock timeout (no more idle events for this member).
                    // processIdle routes to the correct mode handler which
                    // checks errored count and advances the barrier if possible.
                    if (team.activeTask?.signoffStage) {
                        await handleSignoffIdle(ctx, team, live)
                    }
                    if (team.activeTask && team.status === "busy") {
                        // Run not terminated — re-drive the barrier so the mode
                        // handler can process the errored member.
                        // H-M3: processIdle returns early for errored members
                        // (H6 guard at idle.ts:255). Instead, call the mode
                        // handler directly so it can advance the barrier past
                        // the errored member.
                        await processErrorRecovery(ctx, team, live)
                    }
                    await persistTeamState(ctx, team, "persist team state failed (session.error)", { team: team.teamName, member: live.name })
                })
            } catch (err) {
                logSwallowed(ctx, "session.error handler failed", err, { sessionID })
            }
            return
        }

        if (type !== "session.idle") return

        const sessionID = (() => {
            const fromProps = props?.sessionID
            return typeof fromProps === "string" && fromProps ? fromProps : undefined
        })()
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
                        await persistTeamState(ctx, team, "persist team state failed (master idle)", { team: team.teamName })
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
                await persistTeamState(ctx, team, "persist team state failed (member idle)", { team: team.teamName, member: live.name })
            })
        } catch (err) {
            // H26: processIdle may have partially mutated state (e.g. flipped
            // member to idle in Step 1) before throwing. Without persisting,
            // the in-memory state diverges from disk. The sweep timer only
            // re-checks status === "running" members, so a member stuck in
            // idle after a failed processIdle is not retried until wall-clock
            // timeout. Best-effort persist so at least disk matches memory.
            try {
                const member = await resolveTeamMember(ctx.storageRoot, sessionID)
                if (member) {
                    const team = await loadTeamState(member.storageRoot, member.teamName, member.leadSessionId)
                    await team.mutex.runExclusive(async () => {
                        await persistTeamState(ctx, team, "persist team state failed (member idle error recovery)", { team: team.teamName, member: member.name })
                    })
                }
            } catch (recoveryErr) {
                // Recovery itself failed — nothing more we can do. The original
                // error is already logged; log the recovery failure too.
                logSwallowed(ctx, "member-idle error recovery persist failed", recoveryErr, { sessionID })
            }
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
 * sessionID source: the SDK types this hook's `input` as `{}` and the
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
        // Read sessionID from the messages (input is `{}`). All messages in a
        // single transform call share one sessionID.
        const messages = asSdkMessages(output.messages)
        const sessionID = messages.find(m => m.info?.sessionID)?.info?.sessionID
        if (!sessionID) return

        try {
            const member = await resolveTeamMember(ctx.storageRoot, sessionID)
            if (!member) return

            // The master (leader) mailbox is drained by the event handler's
            // deliverQueuedResultsToMaster (promptAsync, distinct turn). Skip it here
            // to avoid inline-injecting team results into the user's interactive turn.
            if (member.isMaster) return

            // Compaction guard. This hook also fires on a structuredClone of the
            // head during compaction — injecting there is lost, but pollMailbox +
            // ackMessages have real side effects → silent message loss. Consume the
            // compacting flag once and skip the clone turn (TTL bounds a stuck flag).
            const deadline = compacting.get(sessionID)
            if (deadline !== undefined) {
                compacting.delete(sessionID) // consume-once: next live transform proceeds
                if (Date.now() < deadline) return
            }
            // Opportunistic eviction: sweep expired entries so the Map does not grow
            // unbounded when sessions are deleted without ever triggering a transform.
            if (compacting.size > COMPACTING_MAP_CAP) {
                const now = Date.now()
                for (const [sid, exp] of compacting) {
                    if (now >= exp) compacting.delete(sid)
                }
            }

            const unread = await pollMailbox(member.directory, member.name)
            if (unread.length === 0) return

            // runId-scoped directive filtering. A directive carrying a runId
            // belongs to one specific orchestration run; once that run ends the
            // directive is stale and must be dropped (not injected).
            //
            // C-10: ALWAYS load team state when ANY directive is present
            // (scoped OR unscoped). Pre-fix code skipped the load when only
            // unscoped directives were in the batch, leaving activeRunIdForAuth
            // undefined; isAuthenticatedDirective then interpreted undefined as
            // "no active run" and accepted unscoped directives registered for
            // earlier runs (cross-run replay via team_intervene's runId===undefined
            // path, or via copied JSONL lines).
            let toInject = unread
            let activeRunIdForAuth: string | undefined
            const hasDirective = unread.some(m => m.kind === "directive")
            if (hasDirective) {
                let activeRunId: string | undefined
                let teamStateUnreadable = false
                try {
                    const team = await loadTeamState(member.storageRoot, member.teamName, member.leadSessionId)
                    activeRunId = team.activeTask?.runId
                    activeRunIdForAuth = activeRunId
                } catch (err) {
                    // Team state unreadable. Fail CLOSED for scoped directives:
                    // dropping them is safer than failing open (the previous
                    // behavior injected them with activeRunId=undefined, which
                    // isAuthenticatedDirective interpreted as "skip runId check",
                    // letting a directive authenticated for an ended run receive
                    // [DIRECTIVE] priority during a different run).
                    //
                    // Non-scoped directives (no runId) are unaffected and still
                    // inject normally below.
                    logSwallowed(ctx, "transform: team state unreadable for scoped directive filter; dropping scoped directives", err, { teamName: member.teamName })
                    teamStateUnreadable = true
                }
                toInject = unread.filter(m => {
                    // Non-directives, and directives without a runId, always pass
                    // (backward-compat with unscoped directives).
                    if (m.kind !== "directive" || m.runId === undefined) return true
                    // Scoped directive. On unreadable team state we CANNOT
                    // confirm the active run, so drop the directive entirely
                    // (fail-closed). The ack-all below still clears the slot.
                    if (teamStateUnreadable) return false
                    // Otherwise inject only when runId matches the active run.
                    return m.runId === activeRunId
                })
            }

            // Empty-injection guard: when every polled message was filtered out
            // (e.g. all stale directives), inject no text part — but still ack the
            // FULL reserved set below so the stale directives are dropped.
            if (toInject.length > 0) {
                const injection = formatMailboxInjection(toInject, activeRunIdForAuth, member.directory)

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
                const injectedPart = { type: "text" as const, text: injection, synthetic: true }
                parts.push(injectedPart)

                // H-5/M-hooks: ACK the full reserved set inside the injection
                // block. If the batch partially commits, retain only messages
                // whose processed records were written; otherwise roll back the
                // entire injected part so unacknowledged messages can be retried.
                try {
                    await ackMessages(member.directory, member.name, unread)
                } catch (ackErr) {
                    const acknowledgedIds = ackErr instanceof AckMessagesError
                        ? new Set(ackErr.acknowledgedMessages.map(message => message.id))
                        : new Set<string>()
                    const acknowledgedInjection = toInject.filter(message => acknowledgedIds.has(message.id))
                    if (acknowledgedInjection.length === 0) {
                        parts.pop()
                    } else {
                        injectedPart.text = formatMailboxInjection(
                            acknowledgedInjection,
                            activeRunIdForAuth,
                            member.directory,
                        )
                    }
                    throw ackErr
                }
            } else {
                // Empty injection (all filtered) — still ack the full set so
                // stale directives are dropped exactly once.
                await ackMessages(member.directory, member.name, unread)
            }
        } catch (err) {
            // The transform hook runs inside the user's interactive turn. An
            // unhandled rejection here crashes that turn. Swallow and log so
            // mailbox injection failures never break the host chat experience.
            logSwallowed(ctx, "transform hook failed", err, { sessionID })
        }
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
 * the top is load-bearing (see processIdle in idle.ts for the same
 * pattern). `statusMap` is the already-fetched session.status snapshot shared
 * across all teams in this sweep tick.
 */
export async function sweepTeamOnce(
    ctx: PluginContext,
    team: Team,
    statusMap: unknown,
): Promise<void> {
    await team.mutex.runExclusive(async () => {
        // Tombstone guard: a team_delete may have completed (set
        // team.deleted + removed the on-disk directory) between
        // activeTeams() snapshotted this reference and us acquiring
        // its mutex. Bail before any state mutation or release*()
        // call — those funnel through withLock -> acquireLock ->
        // fs.mkdir({recursive:true}), which would otherwise
        // recreate the just-removed <teamDir>/mailbox/ directory.
        // Mirrors processIdle (idle.ts) and
        // handleStatusEvent (status.ts) tombstone guards.
        if (team.deleted) return
        // CRIT: cross-process ownership guard. If runnerPid is set and
        // belongs to another process, do NOT mutate this team's state —
        // it is owned by a live sibling process.
        if (team.runnerPid !== undefined && team.runnerPid !== process.pid) return
        // 1. Reclaim stale resources.
        // M12: wrap cleanup in try-catch so a single corrupt mailbox/task
        // doesn't block termination checks for this team. Pre-fix code ran
        // cleanup sequentially before checkTermination; any thrown error
        // would skip timeout/budget enforcement entirely.
        try {
            await releaseStaleReservations(team.directory, "master").catch(err =>
                logSwallowed(ctx, "sweepTeamOnce: master reservation release failed", err, { team: team.teamName }),
            )
            for (const m of team.members) {
                if (m.status === "running") continue
                // H-cleanup: isolate per-member release so one corrupt mailbox
                // does NOT block subsequent members' reservation reclaim.
                // Pre-fix code shared one try — the first throw skipped all
                // remaining members AND reapStaleClaims.
                await releaseStaleReservations(team.directory, m.name).catch(err =>
                    logSwallowed(ctx, "sweepTeamOnce: member reservation release failed", err, { team: team.teamName, member: m.name }),
                )
            }
            // M10: reap stale claims for both delegate and recurse modes.
            const taskType = team.activeTask?.type
            if (taskType === "delegate" || taskType === "recurse") {
                await reapStaleClaims(team.directory).catch(err =>
                    logSwallowed(ctx, "sweepTeamOnce: reapStaleClaims failed", err, { team: team.teamName }),
                )
            }
        } catch (err) {
            logSwallowed(ctx, "sweepTeamOnce: unexpected cleanup error (continuing to termination checks)", err, {
                team: team.teamName,
            })
        }
        // 2. Approval timeout: fail the run if approval has been pending
        // longer than the configured limit. Pre-fix code had the types defined
        // but no execution path — a hung approval would deadlock the team
        // until wall-clock timeout.
        const task = team.activeTask
        if (task && task.approvalRequest && task.approvalTimeoutMs !== undefined) {
            const elapsed = Date.now() - task.approvalRequest.requestedAt
            if (elapsed > task.approvalTimeoutMs) {
                await finishRun(ctx, team, "approval_timeout", "failed")
                return
            }
        }
        // 3. Termination checks run even if no idle arrives.
        await checkTermination(ctx, team)
        if (!team.activeTask) return
        // M-8: check retry escalation for all members with retryingSince set.
        // Pre-fix code only checked the escalation window inside handleStatusEvent,
        // so a long retry storm with no new status events would never escalate.
        for (const member of team.members) {
            if (member.retryingSince !== undefined) {
                await maybeEscalateRetry(ctx, team, member)
                // M13: after each escalation, check if the run ended. Pre-fix
                // code only checked after the entire loop — the first member's
                // escalation could finishRun, but remaining members would still
                // be processed and marked errored.
                if (!team.activeTask) return
            }
        }
        if (!team.activeTask) return
        // I-3/H-2: use the sweep-wide snapshot only to identify candidates.
        // Every candidate carries its turn generation, then gets a fresh SDK
        // status read and a final live-team-state check before processIdle.
        const idleCandidates = team.members.flatMap(member => {
            if (!member.sessionId || member.status !== "running") return []
            const entry = extractSessionStatusEntry(statusMap, member.sessionId)
            return entry?.type === "idle"
                ? [{ name: member.name, sessionId: member.sessionId, turnCount: member.turnCount }]
                : []
        })
        for (const candidate of idleCandidates) {
            const beforeStatusRead = team.members.find(member => member.name === candidate.name)
            if (
                !beforeStatusRead
                || beforeStatusRead.sessionId !== candidate.sessionId
                || beforeStatusRead.status !== "running"
                || beforeStatusRead.turnCount !== candidate.turnCount
            ) {
                continue
            }
            let liveStatusMap: unknown
            try {
                liveStatusMap = (await ctx.client.session.status({})).data
            } catch (err) {
                logSwallowed(ctx, "sweepTeamOnce: live session status read failed", err, {
                    team: team.teamName,
                    member: candidate.name,
                })
                continue
            }
            const liveMember = team.members.find(member => member.name === candidate.name)
            if (
                !liveMember
                || liveMember.sessionId !== candidate.sessionId
                || liveMember.status !== "running"
                || liveMember.turnCount !== candidate.turnCount
            ) {
                continue
            }
            const liveEntry = extractSessionStatusEntry(liveStatusMap, candidate.sessionId)
            if (liveEntry?.type === "idle") {
                await processIdle(ctx, team, liveMember, candidate.sessionId)
            }
        }
        await persistTeamState(ctx, team, "persist team state failed (sweep)", { team: team.teamName ?? "(unknown)" })
    })
}

/** Start the periodic sweep timer that babysits busy teams for missed-idle reconciliation.
 * M-15: uses a recursive setTimeout pattern (not setInterval) so a slow
 * sweep iteration cannot overlap with the next one. Pre-fix code used
 * setInterval(async ...) which allowed overlapping sweeps when a single
 * iteration took longer than SWEEP_INTERVAL_MS. */
export function startSweepTimer(ctx: PluginContext): NodeJS.Timeout {
    const scheduleSweep = (): NodeJS.Timeout => setTimeout(async () => {
        try {
            // Periodic cleanup of expired compacting flags so sessions
            // deleted without a transform do not leak entries.
            const now = Date.now()
            for (const [sid, exp] of compacting) {
                if (now >= exp) compacting.delete(sid)
            }
            // H-M1: race the status API against a timeout so a hanging
            // host API does not block all teams' sweep ticks indefinitely.
            // Pre-fix code had no timeout — a stuck session.status would
            // permanently disable timeout detection, retry escalation, and
            // stale-resource recovery for ALL teams.
            const SWEEP_STATUS_TIMEOUT_MS = 10_000
            let statusMap: unknown = undefined
            try {
                const statusPromise = ctx.client.session.status({}).then(r => r.data)
                const timeoutPromise = new Promise<never>((_, reject) => {
                    const t = setTimeout(() => reject(new Error("session.status timeout")), SWEEP_STATUS_TIMEOUT_MS)
                    t.unref()
                })
                statusMap = await Promise.race([statusPromise, timeoutPromise])
            } catch (err) {
                logEvent(ctx, "warn", "sweep: session.status API failed; proceeding without missed-idle reconciliation", {
                    error: err instanceof Error ? err.message : String(err),
                })
            }
            for (const team of activeTeams()) {
                // M-29: isolate per-team sweep failures so one bad team does
                // not prevent the sweep from processing the remaining teams.
                // H-M2: race each team's sweep against a timeout so a
                // permanently hung team does not block the rest.
                const SWEEP_PER_TEAM_TIMEOUT_MS = 30_000
                try {
                    const sweepPromise = sweepTeamOnce(ctx, team, statusMap)
                    const teamTimeout = new Promise<never>((_, reject) => {
                        const t = setTimeout(() => reject(new Error(`sweep timeout for team ${team.teamName}`)), SWEEP_PER_TEAM_TIMEOUT_MS)
                        t.unref()
                    })
                    await Promise.race([sweepPromise, teamTimeout])
                } catch (err) {
                    logEvent(ctx, "warn", "sweep: per-team sweep failed (continuing)", {
                        team: team.teamName,
                        error: err instanceof Error ? err.message : String(err),
                    })
                }
            }
        } catch (err) {
            logEvent(ctx, "error", "sweep iteration failed", { error: err instanceof Error ? err.message : String(err) })
        }
        // M-15: schedule the next sweep AFTER this one completes, preventing
        // overlapping intervals.
        sweepHandle = scheduleSweep()
        sweepHandle.unref()
    }, SWEEP_INTERVAL_MS)
    let sweepHandle = scheduleSweep()
    // .unref() so the sweep timer does not keep the host event loop alive on
    // graceful shutdown — mirrors the lock heartbeat (locks.ts:110). Retained
    // via `handle` so a future teardown could clearInterval(handle) if the
    // plugin lifecycle ever grows a reload path.
    sweepHandle.unref()
    return sweepHandle
}

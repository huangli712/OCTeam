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
import type { MemberState } from "./core/types.js"
import {
    logEvent,
    logger,
    logSwallowed
} from "./core/log.js"
import { 
    handleStatusEvent,
    maybeEscalateRetry } from "./orchestration/lifecycle/status.js"
import { handleSessionDeleted } from "./orchestration/lifecycle/reconcile.js"
import { 
    processErrorRecovery,
    processIdle,
    retryIdleHandler
} from "./orchestration/lifecycle/idle.js"
import { checkTermination } from "./orchestration/lifecycle/termination.js"
import { finishRun } from "./orchestration/control/completion.js"
import { handleSignoffIdle } from "./orchestration/control/signoff.js"
import { recordEvent } from "./orchestration/records/events.js"
import {
    asSdkMessages,
    extractSessionStatusEntry
} from "./orchestration/protocol/output.js"
import type { Team } from "./state/store.js"
import {
    activeTeams,
    loadTeamState,
    saveTeamState
} from "./state/store.js"
import { safeReadFile } from "./state/locks.js"
import { statePath } from "./state/paths.js"
import { reapStaleClaims } from "./state/tasks.js"
import {
    resolveMasterTeams,
    resolveTeamMember,
    isMasterSession
} from "./state/resolve.js"
import {
    AckMessagesError,
    ackMessages,
    pollMailbox,
    releaseStaleReservations
} from "./messaging/mailbox.js"
import { formatMailboxInjection } from "./messaging/format.js"

// Period between sweep-timer ticks (missed-idle reconciliation, termination enforcement).
const SWEEP_INTERVAL_MS = 15_000

// Max retry attempts for persistTeamState on transient disk failures.
const SAVE_MAX_ATTEMPTS = 3

// Backoff between persistTeamState retry attempts.
const SAVE_BACKOFF_MS = 100

// TTL for compacting flags; bounds a stuck flag if compaction aborts before transform.
const COMPACTING_FLAG_TTL_MS = 15_000

/** Max tracked compacting flags; insert-time eviction enforces it (see below). */
const COMPACTING_MAP_CAP = 256

// ACK happens before the downstream LLM turn. Retain enough in-process state
// to count explicit session.error turns that can no longer redeliver their
// injected mailbox messages.
const earlyAckedMessageCountBySession = new Map<string, number>()

// Cumulative count of mailbox turns dropped after transform ACK, since plugin startup.
let droppedMailboxTurnsSinceStartup = 0

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
 * SDK events come in multiple shapes across versions:
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
    // The current SDK's session.deleted event places the id at
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

/**
 * Save team state with bounded retry. Transient disk failures (EIO, ENOSPC)
 * are retried up to SAVE_MAX_ATTEMPTS times before giving up. On final failure
 * the error is logged at "error" level (not the default "warn") so operators
 * notice state drift between memory and disk.
 *
 * Runs inside the caller's team.mutex.runExclusive block; the retry backoffs
 * add at most ~200ms to the mutex hold, and each saveTeamState attempt's own
 * duration (disk I/O) extends it further.
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
            team._persistDirty = false
            return
        } catch (err) {
            lastErr = err
            if (attempt < SAVE_MAX_ATTEMPTS) {
                await new Promise(r => setTimeout(r, SAVE_BACKOFF_MS))
            }
        }
    }
    team._persistDirty = true
    logSwallowed(ctx, label, lastErr, { ...extra, attempts: SAVE_MAX_ATTEMPTS }, "error")
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
 * Marks a session as currently compacting. Registered under
 * experimental.session.compacting in server init. The transform hook consumes
 * this flag once to skip the compaction-clone turn.
 */
export function createCompactingHook(): NonNullable<Hooks["experimental.session.compacting"]> {
    return async input => {
        const sid = typeof input === "object" && input !== null
            ? (input as Record<string, unknown>).sessionID
            : undefined
        if (typeof sid === "string" && sid) {
            // Enforce COMPACTING_MAP_CAP on insert: evict expired entries
            // first, then the oldest entry if still at capacity.
            if (compacting.size >= COMPACTING_MAP_CAP) {
                const now = Date.now()
                for (const [k, exp] of compacting) {
                    if (now >= exp) compacting.delete(k)
                    if (compacting.size < COMPACTING_MAP_CAP) break
                }
                // If the map remains at capacity, evict the oldest entry. A
                // still-valid eviction can cause message loss, so log it at
                // error level. The 256-entry cap keeps this path rare.
                if (compacting.size >= COMPACTING_MAP_CAP) {
                    const oldest = [...compacting.entries()].sort((a, b) => a[1] - b[1])[0]
                    if (oldest) {
                        const stillValid = Date.now() < oldest[1]
                        if (stillValid) {
                            logger.error(
                                "compacting flag map at CAP; evicting still-valid flag — possible message loss",
                                { sessionID: oldest[0], cap: COMPACTING_MAP_CAP },
                            )
                        }
                        compacting.delete(oldest[0])
                    }
                }
            }
            compacting.set(sid, Date.now() + COMPACTING_FLAG_TTL_MS)
        }
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
                earlyAckedMessageCountBySession.delete(sid)
                try {
                    await handleSessionDeleted(ctx, sid)
                } catch (err) {
                    logSwallowed(ctx, "session.deleted handler failed", err, { type })
                }
            }
            return
        }

        // session.error fires on abort, auth failure, or unrecoverable
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
            const acknowledgedMessages = earlyAckedMessageCountBySession.get(sessionID)
            earlyAckedMessageCountBySession.delete(sessionID)
            if (acknowledgedMessages !== undefined) {
                droppedMailboxTurnsSinceStartup++
                logEvent(ctx, "error", "mailbox turn failed after transform ACK; messages cannot be redelivered", {
                    sessionID,
                    acknowledgedMessages,
                    droppedTurnsSinceStartup: droppedMailboxTurnsSinceStartup,
                })
            }
            try {
                const member = await resolveTeamMember(ctx.storageRoot, sessionID)
                if (!member) return
                const team = await loadTeamState(member.storageRoot, member.teamName, member.leadSessionId)
                await team.mutex.runExclusive(async () => {
                    const live = team.members.find(m => m.name === member.name)
                    // Verify the error event's sessionID matches
                    // the live member's current session. A stale error from
                    // a replaced session must not affect the current run.
                    if (live?.sessionId !== undefined && live.sessionId !== sessionID) return
                    // Process session errors only while the member is running
                    // with an active task and a live team. This prevents stale
                    // errors from canceled turns from affecting a later run.
                    if (!live || live.status !== "running") return
                    if (!team.activeTask) return
                    if (team.deleted) return
                    live.status = "errored"
                    // Serialize the full error info instead of relying on
                    // SDK properties.error being a string (it may be an object).
                    const errProps = narrowed?.properties
                    /** Truncate a string to 4_096 chars, appending a marker when
                     *  cut. */
                    const truncateError = (value: string): string => {
                        const marker = "...[truncated]"
                        return value.length <= 4_096
                            ? value
                            : value.slice(0, 4_096 - marker.length) + marker
                    }
                    // JSON.stringify can throw on circular refs or BigInt.
                    // Use a safe serializer that never throws.
                    /** Serialize an unknown error value to a string, redacting
                     *  sensitive header/credential-like keys and truncating;
                     *  never throws (circular refs/BigInt → placeholder). */
                    const safeStringify = (value: unknown): string => {
                        const sensitiveFields = new Set([
                            "authorization", "proxyauthorization", "authenticationinfo",
                            "wwwauthenticate", "proxyauthenticate",
                            "cookie", "cookie2", "setcookie", "setcookie2",
                            "password", "passwd", "secret", "clientsecret",
                            "credential", "credentials", "privatekey",
                            "token", "accesstoken", "refreshtoken", "idtoken", "apikey",
                            "xapikey", "xauthtoken", "xaccesstoken",
                            "xamzsecuritytoken", "xgoogapikey", "xcsrftoken", "xsrftoken",
                        ])
                        try {
                            const serialized = JSON.stringify(value, (key, nestedValue) => {
                                const normalizedKey = key.replace(/[-_]/g, "").toLowerCase()
                                if (sensitiveFields.has(normalizedKey)) return "[REDACTED]"
                                return typeof nestedValue === "string" ? truncateError(nestedValue) : nestedValue
                            })
                            return truncateError(serialized ?? "[unserializable error]")
                        } catch {
                            return "[unserializable error]"
                        }
                    }
                    const errMsg = errProps?.error !== undefined
                        ? (typeof errProps.error === "string" ? truncateError(errProps.error) : safeStringify(errProps.error))
                        : errProps?.message !== undefined
                            ? truncateError(String(errProps.message))
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
                    // Re-drive mode-specific barrier handling after an error so
                    // a run within tolerance can advance without another idle event.
                    if (team.activeTask?.signoffStage) {
                        await handleSignoffIdle(ctx, team, live)
                    }
                    if (team.activeTask && team.status === "busy") {
                        // Run not terminated — re-drive the barrier so the mode
                        // handler can process the errored member.
                        // processIdle returns early for errored members. Call the
                        // mode handler directly so it can advance the barrier.
                        await processErrorRecovery(ctx, team, live)
                    }
                    await persistTeamState(
                        ctx,
                        team,
                        "persist team state failed (session.error)",
                        { team: team.teamName, member: live.name },
                    )
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
        earlyAckedMessageCountBySession.delete(sessionID)

        // Master drain-all: a master session may own MULTIPLE teams. Drain each
        // owned team's master mailbox under that team's own mutex, independent of
        // which team is "active" — activation governs interaction, not delivery.
        // processIdle's master branch (Step 1) drains queued results; no dispatch.
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

        // Member path — single team (1:1), driven by the session index.
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
                await persistTeamState(
                    ctx,
                    team,
                    "persist team state failed (member idle)",
                    { team: team.teamName, member: live.name },
                )
            })
        } catch (err) {
            // processIdle may have partially mutated state (e.g. flipped
            // member to idle in Step 2) before throwing. Without persisting,
            // the in-memory state diverges from disk. The sweep timer only
            // re-checks status === "running" members, so a member stuck in
            // idle after a failed processIdle is not retried until wall-clock
            // timeout. Best-effort persist so at least disk matches memory.
            try {
                const member = await resolveTeamMember(ctx.storageRoot, sessionID)
                if (member) {
                    const team = await loadTeamState(member.storageRoot, member.teamName, member.leadSessionId)
                    await team.mutex.runExclusive(async () => {
                        await persistTeamState(
                            ctx,
                            team,
                            "persist team state failed (member idle error recovery)",
                            { team: team.teamName, member: member.name },
                        )
                    })
                }
            } catch (recoveryErr) {
                // Recovery itself failed — nothing more we can do. The original
                // error is logged below; log the recovery failure too.
                logSwallowed(ctx, "member-idle error recovery persist failed", recoveryErr, { sessionID })
            }
            logSwallowed(ctx, "member-idle handler failed", err, { sessionID })
        }
    }
}

/**
 * Transform hook (Layer 3 of the three-layer communication model). On each chat turn for a team member,
 * atomically poll-and-reserve its mailbox and inject unread messages as a
 * synthetic text part on the last user message. Uses the same reservation
 * protocol as the master drain path.
 *
 * Known limitation: ACK commits before the downstream LLM turn runs. If
 * that turn fails, injected messages cannot be re-delivered, so this boundary
 * is at-most-once rather than exactly-once. Explicit session.error events emit
 * a cumulative dropped-turn counter; process crashes before an error event are
 * not observable. A full fix requires durable cross-hook pending-ACK state.
 *
 * The SDK types this hook's `input` as `{}` and passes `{}` at both trigger
 * sites. Each message carries a required `info.sessionID`, so the hook reads
 * the session ID from `output.messages`; all messages in one transform call
 * belong to the same session.
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
            const unread = await pollMailbox(member.directory, member.name)
            if (unread.length === 0) return

            // runId-scoped directive filtering. A directive carrying a runId
            // belongs to one specific orchestration run; once that run ends the
            // directive is stale and must be dropped (not injected).
            //
            // Load team state whenever any directive is present, scoped or
            // unscoped. This binds authentication to the active run and blocks
            // cross-run replay through directives that omit runId.
            let toInject = unread
            let activeRunIdForAuth: string | undefined
            const hasDirective = unread.some(m => m.kind === "directive")
            // Track team state unreadability outside the hasDirective
            // block so the empty-injection branch can decide whether to
            // retain directives for retry.
            let teamStateUnreadable = false
            if (hasDirective) {
                let activeRunId: string | undefined
                try {
                    const team = await loadTeamState(member.storageRoot, member.teamName, member.leadSessionId)
                    activeRunId = team.activeTask?.runId
                    activeRunIdForAuth = activeRunId
                } catch (err) {
                    // Without readable team state no directive can be bound to
                    // the current run, including directives without a runId.
                    logSwallowed(
                        ctx,
                        "transform: team state unreadable for directive filter; dropping directives",
                        err,
                        { teamName: member.teamName },
                    )
                    teamStateUnreadable = true
                }
                toInject = unread.filter(m => {
                    if (m.kind !== "directive") return true
                    if (teamStateUnreadable) return false
                    if (m.runId === undefined) return true
                    return m.runId === activeRunId
                })
            }

            // Empty-injection guard: when every polled message was filtered out
            // (e.g. all stale directives), inject no text part — but still ack
            // the reserved set below so the stale directives are dropped (when
            // team state is unreadable, directives are retained for retry).
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

                // ACK the full reserved set inside the injection
                // block. If the batch partially commits, retain only messages
                // whose processed records were written; otherwise roll back the
                // entire injected part so unacknowledged messages can be retried.
                // When teamStateUnreadable, only acknowledge injected
                // (non-directive) messages; retain directives for retry.
                const toAck = teamStateUnreadable
                    ? unread.filter(m => m.kind !== "directive")
                    : unread
                if (toAck.length === 0) {
                    parts.pop()
                } else try {
                    await ackMessages(member.directory, member.name, toAck)
                    earlyAckedMessageCountBySession.set(
                        sessionID,
                        (earlyAckedMessageCountBySession.get(sessionID) ?? 0) + toInject.length,
                    )
                } catch (ackErr) {
                    const acknowledgedIds = ackErr instanceof AckMessagesError
                        ? new Set(ackErr.acknowledgedMessages.map(message => message.id))
                        : new Set<string>()
                    const acknowledgedInjection = toInject.filter(message => acknowledgedIds.has(message.id))
                    if (acknowledgedInjection.length > 0) {
                        earlyAckedMessageCountBySession.set(
                            sessionID,
                            (earlyAckedMessageCountBySession.get(sessionID) ?? 0) + acknowledgedInjection.length,
                        )
                    }
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
                // Empty injection (all filtered) — ack non-directive messages
                // so they are dropped, but RETAIN directives when team state was
                // unreadable so they can be retried after state recovers.
                if (teamStateUnreadable) {
                    const nonDirectives = unread.filter(m => m.kind !== "directive")
                    if (nonDirectives.length > 0) {
                        await ackMessages(member.directory, member.name, nonDirectives)
                    }
                } else {
                    await ackMessages(member.directory, member.name, unread)
                }
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
 * State is snapshotted and processed under team.mutex, while live host status
 * reads run outside it. The caller snapshots activeTeams() before either lock,
 * so both critical sections repeat the tombstone and ownership guards.
 * `statusMap` is the already-fetched session.status snapshot shared across all
 * teams in this sweep tick.
 */
export async function sweepTeamOnce(
    ctx: PluginContext,
    team: Team,
    statusMap: unknown,
): Promise<void> {
    let idleCandidates: Array<{ name: string; sessionId: string; turnCount: number }> = []
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
        // Cross-process ownership guard. If runnerPid is set and
        // belongs to another process, do NOT mutate this team's state —
        // it is owned by a live sibling process.
        if (team.runnerPid !== undefined && team.runnerPid !== process.pid) return
        if (team._stateUnreadable) {
            // Read state.json directly because loadTeamState would re-acquire
            // this non-reentrant mutex. safeReadFile also bounds the read.
            try {
                const raw = await safeReadFile(team.directory, statePath(team.directory), { maxBytes: 1024 * 1024 })
                if (raw !== undefined) {
                    JSON.parse(raw)  // throws if corrupt
                    team._stateUnreadable = false
                } else {
                    return  // ENOENT — team deleted
                }
            } catch {
                logEvent(ctx, "error", "sweep: team state still unreadable after retry", {
                    team: team.teamName,
                })
                return
            }
        }
        if (team._persistDirty) {
            await persistTeamState(ctx, team, "persist dirty team state failed (sweep retry)", {
                team: team.teamName ?? "(unknown)",
            })
        }
        if (!team.activeTask) return
        // 1. Reclaim stale resources.
        // Isolate cleanup failures so termination checks still run for the team.
        try {
            await releaseStaleReservations(team.directory, "master").catch(err =>
                logSwallowed(ctx, "sweepTeamOnce: master reservation release failed", err, { team: team.teamName }),
            )
            for (const m of team.members) {
                if (m.status === "running") continue
                // Isolate each member's release so one corrupt mailbox does not
                // block subsequent members or stale-claim cleanup.
                await releaseStaleReservations(team.directory, m.name).catch(err =>
                    logSwallowed(
                        ctx,
                        "sweepTeamOnce: member reservation release failed",
                        err,
                        { team: team.teamName, member: m.name },
                    ),
                )
            }
            // Reap stale claims for both delegate and recurse modes.
            const taskType = team.activeTask?.type
            if (taskType === "delegate" || taskType === "recurse") {
                // Protect claims held by members whose sessions are actively
                // mid-turn (busy/running/retry). A long aggregation turn
                // routinely exceeds CLAIM_TTL while its owner is still
                // synthesizing; reaping it mid-turn orphans the output and
                // loops the aggregation dispatch.
                const protectOwners = new Set<string>()
                if (statusMap) {
                    for (const m of team.members) {
                        if (!m.sessionId) continue
                        const entry = extractSessionStatusEntry(statusMap, m.sessionId)
                        if (entry?.type === "busy" || entry?.type === "running" || entry?.type === "retry") {
                            protectOwners.add(m.name)
                        }
                    }
                }
                await reapStaleClaims(team.directory, { protectOwners }).catch(err =>
                    logSwallowed(ctx, "sweepTeamOnce: reapStaleClaims failed", err, { team: team.teamName }),
                )
            }
        } catch (err) {
            logSwallowed(ctx, "sweepTeamOnce: unexpected cleanup error (continuing to termination checks)", err, {
                team: team.teamName,
            })
        }
        // 2. Fail runs whose approval request exceeds the configured timeout.
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
        // Check retry escalation for every member with a retry window so a
        // quiet retry storm cannot bypass escalation.
        for (const member of team.members) {
            if (member.retryingSince !== undefined) {
                if (member.status === "idle") {
                    await retryIdleHandler(ctx, team, member).catch(err =>
                        logSwallowed(ctx, "sweepTeamOnce: idle handler retry failed", err, {
                            team: team.teamName,
                            member: member.name,
                        }),
                    )
                    if (!team.activeTask) return
                    continue
                }
                await maybeEscalateRetry(ctx, team, member)
                // Check after each escalation because it may finish the run
                // before later members are processed.
                if (!team.activeTask) return
            }
        }
        if (!team.activeTask) return
        // Use the sweep-wide snapshot only to identify candidates.
        // Every candidate carries its turn generation, then gets a fresh SDK
        // status read and a final live-team-state check before processIdle.
        idleCandidates = team.members.flatMap(member => {
            if (!member.sessionId || member.status !== "running") return []
            const entry = extractSessionStatusEntry(statusMap, member.sessionId)
            return entry?.type === "idle"
                ? [{ name: member.name, sessionId: member.sessionId, turnCount: member.turnCount }]
                : []
        })
        if (idleCandidates.length === 0) {
            await persistTeamState(
                ctx,
                team,
                "persist team state failed (sweep)",
                { team: team.teamName ?? "(unknown)" },
            )
        }
    })

    if (idleCandidates.length === 0) return

    const liveStatusMaps = new Map<string, unknown>()
    for (const candidate of idleCandidates) {
        try {
            liveStatusMaps.set(candidate.name, (await ctx.client.session.status({})).data)
        } catch (err) {
            logSwallowed(ctx, "sweepTeamOnce: live session status read failed", err, {
                team: team.teamName,
                member: candidate.name,
            })
        }
    }

    await team.mutex.runExclusive(async () => {
        if (team.deleted) return
        if (team.runnerPid !== undefined && team.runnerPid !== process.pid) return
        if (!team.activeTask) return
        for (const candidate of idleCandidates) {
            if (!liveStatusMaps.has(candidate.name)) continue
            const liveMember = team.members.find(member => member.name === candidate.name)
            if (
                !liveMember
                || liveMember.sessionId !== candidate.sessionId
                || liveMember.status !== "running"
                || liveMember.turnCount !== candidate.turnCount
            ) {
                continue
            }
            const liveEntry = extractSessionStatusEntry(liveStatusMaps.get(candidate.name), candidate.sessionId)
            if (liveEntry?.type === "idle") {
                await processIdle(ctx, team, liveMember, candidate.sessionId)
                if (!team.activeTask) break
            }
        }
        await persistTeamState(
            ctx,
            team,
            "persist team state failed (sweep)",
            { team: team.teamName ?? "(unknown)" },
        )
    })
}

/** Start the periodic sweep timer that babysits busy teams for missed-idle reconciliation.
 * A recursive setTimeout schedules each tick after the prior sweep completes,
 * preventing overlap when a sweep exceeds SWEEP_INTERVAL_MS. */
export function startSweepTimer(ctx: PluginContext): { stop: () => void } {
    let stopped = false
    let currentHandle: NodeJS.Timeout | undefined
    const scheduleSweep = (): NodeJS.Timeout => setTimeout(async () => {
        if (stopped) return
        try {
            // Periodic cleanup of expired compacting flags so sessions
            // deleted without a transform do not leak entries.
            const now = Date.now()
            for (const [sid, exp] of compacting) {
                if (now >= exp) compacting.delete(sid)
            }
            // Bound the status API call so a hung request does not block timeout
            // detection, retry escalation, or stale-resource recovery for all teams.
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
                // Isolate and bound each team's sweep so one bad or hung team
                // does not block the remaining teams.
                const SWEEP_PER_TEAM_TIMEOUT_MS = 30_000
                try {
                    const sweepPromise = sweepTeamOnce(ctx, team, statusMap)
                    const teamTimeout = new Promise<never>((_, reject) => {
                        const t = setTimeout(
                            () => reject(new Error(`sweep timeout for team ${team.teamName}`)),
                            SWEEP_PER_TEAM_TIMEOUT_MS,
                        )
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
            logEvent(ctx, "error", "sweep iteration failed", {
                error: err instanceof Error ? err.message : String(err),
            })
        }
        // Schedule the next sweep after this one completes, preventing
        // overlapping intervals.
        sweepHandle = scheduleSweep()
        sweepHandle.unref()
        currentHandle = sweepHandle
    }, SWEEP_INTERVAL_MS)
    let sweepHandle = scheduleSweep()
    sweepHandle.unref()
    currentHandle = sweepHandle
    return {
        stop: () => {
            stopped = true
            if (currentHandle) clearTimeout(currentHandle)
        },
    }
}

/**
 * Hook factories + sweep timer (design §6). These adapt the orchestration core
 * (processIdle, handleStatusEvent) and the mailbox drain (Transform hook) into
 * the OpenCode Hooks.event / experimental.chat.messages.transform signatures,
 * and run a periodic sweep timer that babysits busy teams (crash recovery,
 * missed-idle reconciliation, termination enforcement).
 */

import type { Hooks } from "@opencode-ai/plugin"

import type { PluginContext } from "./context.js"
import { loadTeamState, activeTeams, listTeamNames, saveTeamState } from "./state/store.js"
import { resolveTeamMember } from "./utils.js"
import { ackMessages, formatMailboxInjection, pollMailbox, releaseStaleReservations } from "./mailbox.js"
import { reapStaleClaims } from "./tasks.js"
import { handleStatusEvent, processIdle } from "./orchestration/handlers.js"
import { checkTermination } from "./orchestration/termination.js"
import type { RuntimeMember } from "./types.js"

const SWEEP_INTERVAL_MS = 15_000

/**
 * The single event handler (design §6). Filters by event.type, resolves the
 * session to a team member, and runs processIdle under the team mutex. Master
 * sessions are resolved as synthetic members (B1) so their queued results drain.
 */
export function createEventHandler(ctx: PluginContext): NonNullable<Hooks["event"]> {
    return async ({ event }) => {
        const type = (event as { type?: string }).type
        const props = (event as { properties?: Record<string, unknown> }).properties

        // B2: session.status carries retry/error signals that session.idle does not.
        if (type === "session.status") {
            await handleStatusEvent(ctx, event as { properties?: Record<string, unknown>; type?: string })
            return
        }
        if (type !== "session.idle") return

        const sessionID = (props as { sessionID?: string } | undefined)?.sessionID
        if (!sessionID) return

        const member = await resolveTeamMember(ctx.storageRoot, sessionID)
        if (!member) return // not a team member (the common case)

        const team = await loadTeamState(ctx.storageRoot, member.teamName)
        await team.mutex.runExclusive(async () => {
            if (member.isMaster) {
                // synthetic master — Step 0 drains queued results, no dispatch
                await processIdle(ctx, team, member as RuntimeMember, sessionID)
            } else {
                // operate on the LIVE member object so mutations persist
                const live = team.members.find(m => m.name === member.name)
                if (!live) return
                await processIdle(ctx, team, live, sessionID)
            }
        })
    }
}

/**
 * Transform hook (design §5, Layer 3). On each chat turn for a team member (or
 * master), atomically poll-and-reserve its mailbox and inject unread messages
 * as a synthetic user message before the last user message. Uses the same
 * reservation protocol as the master drain path → exactly-once delivery.
 */
export function createTransformHook(
    ctx: PluginContext,
): NonNullable<Hooks["experimental.chat.messages.transform"]> {
    // The SDK types the input as {} but runtime provides sessionID; cast for access.
    return async (input, output) => {
        const rec = input as { sessionID?: string; session?: { id?: string } }
        const sessionID = rec.sessionID ?? rec.session?.id
        if (!sessionID) return

        const member = await resolveTeamMember(ctx.storageRoot, sessionID)
        if (!member) return

        const unread = await pollMailbox(member.directory, member.name)
        if (unread.length === 0) return

        const injection = formatMailboxInjection(unread)

        // M3: append the injection as a synthetic text part to an existing message
        // (prefer the last user message) rather than fabricating a partial Message
        // object. A hand-rolled { info: { role } } is missing required Message fields
        // and risks crashing the host renderer / token accounting.
        const messages = output.messages as Array<{ info?: { role?: string }; parts?: any[] }>
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
 * Sweep timer (design §6, B1). Three jobs, every SWEEP_INTERVAL_MS:
 *   1. Release stale mailbox reservations + reap stale task claims (crash recovery)
 *   2. Run checkTermination so wall-clock/budget/error fire even without idles
 *   3. Reconcile missed idle events (member idle in OpenCode but still "running"
 *      in plugin state — re-enter processIdle)
 * Started once in server() init.
 */
/**
 * Crash recovery (design §3). On plugin startup, reconcile teams left in a
 * non-terminal state by a previous process that crashed mid-orchestration:
 *   - busy: the in-flight orchestration cannot resume deterministically — release
 *     stale mailbox reservations, mark running members errored, and transition the
 *     team to "failed". Its sessions persist and are reusable by a fresh workflow
 *     call (ensureMembersReady reuses members that already have a sessionId).
 *   - idle: release stale reservations (members reusable as-is).
 * live / failed / dead / disabled are terminal-or-pristine → skipped.
 * Runs once in server() init, AFTER rebuildSessionIndex, BEFORE startSweepTimer.
 * Safe to use the mutex here: hooks are not yet registered, so no event handler
 * runs concurrently.
 */
export async function reconcileCrashedTeams(ctx: PluginContext): Promise<void> {
    const names = await listTeamNames(ctx.storageRoot)
    for (const name of names) {
        let team
        try {
            team = await loadTeamState(ctx.storageRoot, name)
        } catch {
            continue // unreadable state.json — skip
        }
        if (team.status !== "busy" && team.status !== "idle") continue
        await team.mutex.runExclusive(async () => {
            await releaseStaleReservations(team.directory, "master").catch(() => {})
            for (const m of team.members) {
                await releaseStaleReservations(team.directory, m.name).catch(() => {})
            }
            if (team.status === "busy") {
                // Interrupted orchestration is unrecoverable — fail it cleanly.
                team.activeTask = undefined
                team.status = "failed"
                for (const m of team.members) {
                    if (m.status === "running") {
                        m.status = "errored"
                        m.error = "interrupted by plugin/host restart"
                    }
                }
            }
            await saveTeamState(team).catch(() => {
                // best-effort persist
            })
        })
    }
}

export function startSweepTimer(ctx: PluginContext): NodeJS.Timeout {
    return setInterval(async () => {
        try {
            // M6: no directory filter — include sessions in member worktrees too.
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
                    await saveTeamState(team).catch(() => {
                        // best-effort persist
                    })
                })
            }
        } catch {
            // sweep must never throw — it would kill the interval
        }
    }, SWEEP_INTERVAL_MS)
}

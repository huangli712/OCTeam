/**
 * The locked state machine. processIdle is the single entry point
 * driven by session.idle events (and the sweep timer's missed-idle
 * reconciliation). It MUST be called inside team.mutex.runExclusive — the
 * event-handler wrapper acquires the mutex, this function mutates state freely.
 *
 * Steps:
 *   0. Master special case — drain queued results, return (master never dispatches)
 *   1. Flip member to idle
 *   1.5. Role-setup barrier — first idle of uninitialized member marks it ready, returns
 *   2. Token accounting (recompute, never +=)
 *   3. Identity validation (stray idle does not advance pipeline/loop)
 *   4. Capture output (mode-aware; delegate does NOT use responses[])
 *   5. Unread-message wake hint (returns; Transform hook injects content next turn)
 *   6. Dispatch by active-task type
 *   7. Termination checks
 *
 * This module is the public entrypoint of the orchestration package: it owns
 * processIdle, getExpectedMember, handleStatusEvent, and re-exports the public
 * symbols of the per-mode handler modules so historical callers (hooks.ts,
 * tools/) keep working unchanged.
 */

import type { PluginContext } from "../core/context.js"
import { logEvent } from "../core/log.js"
import { type Team, loadTeamState, saveTeamState } from '../state/store.js';
import { countUnreadMessages } from "../messaging/mailbox.js"
import { sendWakeHint } from "../messaging/wake-hint.js"
import { extractOutputFromParts, sumMemberTokens, truncateOutput } from "../core/utils.js"
import { resolveTeamMember } from "../state/resolve.js"
import { atomicWrite } from "../state/locks.js"
import { runMemberOutputPath } from "../state/paths.js"
import { logSwallowed } from "../core/log.js"
import type { ActiveTask, MemberState } from "../core/types.js"
import { deliverQueuedResultsToMaster } from "./summary.js"
import { checkTermination } from "./termination.js"
import { recordEvent } from "./events.js"
import { handleReduceIdle, handleSignoffIdle } from "./signoff.js"
import { handleConsensusIdle } from "./consensus.js"
import { handleParallelIdle } from "./parallel.js"
import { handleLoopIdle, handlePipelineIdle } from "./pipeline-loop.js"
import { handleDelegateIdle } from "./delegate.js"
import { handleRecurseIdle } from "./recurse.js"
import { handleTollgateIdle } from "./tollgate.js"
import { handleArbitrateIdle, handleRouteIdle } from "./route-arbitrate.js"

// --- helpers ---

/**
 * Identity validation: which member may advance the state machine for this
 * task? parallel/delegate accept EVERY member's idle (all run concurrently);
 * pipeline/loop accept only the current stage's member. Returning the wrong
 * value here makes parallel degrade to serial or pipeline advance on stray idles.
 */
export function getExpectedMember(task: ActiveTask): string | null {
    // signoff stage: any reviewer may advance
    if (task.signoffStage) return null
    if (task.type === "parallel") return null
    if (task.type === "consensus") return null
    if (task.type === "delegate") return null
    if (task.type === "route") {
        // router phase: only the router advances; target phase: any target (like parallel)
        return task.routeStage ? null : (task.routerMember ?? null)
    }
    if (task.type === "arbitrate") {
        // debate phase: any debater advances (null); ruling phase: only the arbiter
        return task.arbitrationStage ? (task.arbiterMember ?? null) : null
    }
    if (task.type === "recurse") return null   // same as delegate: any member advances
    // tollgate: a single gate is active at a time. Only the phase-appropriate
    // member may advance — the producer (produce), the verifier (verify), or the
    // escalation handler (escalate). Returning escalateTo in the escalate phase
    // is load-bearing: without it, the escalation member's idle is treated as a
    // stray and never processed, deadlocking the run.
    if (task.type === "tollgate") {
        const s = task.gatedStages?.[task.currentStageIndex]
        if (!s) return null
        switch (task.tollgatePhase) {
            case "verify":   return s.verifier
            case "escalate": return task.escalateTo ?? null
            default:         return s.member                  // "produce" (and undefined initial state)
        }
    }
    return task.stages[task.currentStageIndex]?.member ?? null
}

/**
 * Build the re-prompt text for a member that went idle without calling
 * team_done() under require_done_ack. Extracted from processIdle's parallel
 * case so the prompt copy lives in one named place rather than inline.
 */
function buildPrematureIdleReprompt(teamName: string): string {
    return `[Team Orchestrator] You went idle on team "${teamName}" without calling `
        + `team_done(team_id="${teamName}"). This run uses require_done_ack: the `
        + `barrier fires ONLY after every participant calls team_done. `
        + `If your work is complete (including required messages and self-verification), `
        + `call team_done now. If you are blocked waiting for a dependency, briefly say `
        + `what you are waiting for AND do any other independent work you can; do NOT go `
        + `idle again without either acking or making concrete progress.`
}

// --- main entry ---

export async function processIdle(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
    sessionID: string,
): Promise<void> {
    // Tombstone: the team directory has been deleted (team_delete ran under
    // the mutex and set team.deleted=true). Bail before any state mutation or
    // saveTeamState / captureMemberOutput / recordEvent / persistRun call —
    // those all funnel through atomicWrite, whose mkdir({recursive:true}) would
    // otherwise recreate the just-removed directory.
    if (team.deleted) return
    // Step 0: Master special case — synthetic member, never dispatches.
    if (member.isMaster) {
        await deliverQueuedResultsToMaster(ctx, team, sessionID)
        return
    }

    // Step 1: member is now idle.
    member.status = "idle"
    member.retryingSince = undefined // idle clears retry tracking

    // Step 1.5: Role-setup barrier — first idle of an uninitialized member
    // marks it ready and returns WITHOUT capturing output or advancing.
    if (!member.initialized) {
        member.initialized = true
        await saveTeamState(team)
        return
    }

    // Step 2: Token accounting (recompute from full history, never +=).
    const msgs = await ctx.client.session.messages({ path: { id: sessionID } })
    const messages = (msgs.data ?? []) as Array<{ info?: any; parts?: any }>
    if (team.activeTask) {
        team.activeTask.tokensByMember[member.name] = sumMemberTokens(messages)
        team.activeTask.tokensUsed = Object.values(team.activeTask.tokensByMember).reduce(
            (a, b) => a + b,
            0,
        )
    }

    // Step 3: Identity validation — stray idle must not advance pipeline/loop.
    if (team.activeTask) {
        const expected = getExpectedMember(team.activeTask)
        if (expected !== null && member.name !== expected) {
            await saveTeamState(team) // persist token tally; do NOT advance
            return
        }
    }

    // Step 4: Capture output (mode-aware; delegate skips, signoff always captures).
    await captureMemberOutput(ctx, team, member, messages)

    await saveTeamState(team)

    // Step 5: Unread messages — wake hint only (Transform hook injects content).
    const unread = await countUnreadMessages(team.directory, member.name)
    if (unread > 0) {
        await sendWakeHint(ctx, sessionID, unread)
        return
    }

    // Step 6: Dispatch by active-task type.
    if (!team.activeTask) return
    // Capture the discriminant into a local so the switch narrows it (and the
    // default-branch exhaustiveness check) rather than re-reading a property on
    // the union each time — the latter defeats TS narrowing for `never` checks.
    const taskType = team.activeTask.type
    // reduce stage takes priority (real map-reduce): the reducer's idle is
    // captured into reducedResult, then signoff/deliver runs.
    if (team.activeTask.reduceStage) {
        await handleReduceIdle(ctx, team, member)
        await checkTermination(ctx, team)
        return
    }
    // signoff stage takes priority over normal mode dispatch
    if (team.activeTask.signoffStage) {
        await handleSignoffIdle(ctx, team, member)
        await checkTermination(ctx, team)
        return
    }
    switch (taskType) {
        case "parallel":
            // require_done_ack recovery: a member that went idle without calling
            // team_done() is "premature idle". Re-prompt it with explicit
            // instructions instead of consulting the barrier (which would not
            // fire anyway, since declaredDone is still false, but re-prompting
            // here gives the member a chance to ack or report a blocker).
            // maxMemberTurns / wall-clock timeout (checkTermination) cap retries.
            if (
                team.activeTask.requireDoneAck
                && (team.activeTask.mode === "isolated" || team.activeTask.mode === "collaborative")
                && !member.declaredDone
                && member.sessionId
            ) {
                await ctx.client.session.promptAsync({
                    path: { id: member.sessionId },
                    body: {
                        parts: [{ type: "text", text: buildPrematureIdleReprompt(team.teamName), synthetic: true }],
                        agent: member.agent ?? "build",
                    },
                    query: { directory: member.worktreePath ?? ctx.directory },
                })
                member.status = "running"
                member.turnCount++
                await saveTeamState(team)
                await checkTermination(ctx, team)
                return
            }
            await handleParallelIdle(ctx, team)
            break
        case "consensus":
            await handleConsensusIdle(ctx, team)
            break
        case "pipeline":
            await handlePipelineIdle(ctx, team, member)
            break
        case "loop":
            await handleLoopIdle(ctx, team, member)
            break
        case "delegate":
            await handleDelegateIdle(ctx, team, member)
            break
        case "route":
            await handleRouteIdle(ctx, team)
            break
        case "arbitrate":
            await handleArbitrateIdle(ctx, team)
            break
        case "recurse":
            await handleRecurseIdle(ctx, team, member)
            break
        case "tollgate":
            await handleTollgateIdle(ctx, team, member)
            break
        default: {
            // Exhaustiveness check: every OrchestrationType above is handled, so
            // this branch is unreachable and team.activeTask.type narrows to
            // `never`. If a new OrchestrationType is added in core/types.ts without
            // a matching case here, this assignment fails to compile — a compile-
            // time guard against silent fall-through. At runtime it also fails fast:
            // mark the member errored so the post-switch checkTermination fails the
            // run instead of letting the member stall until the wall-clock timeout.
            const _exhaustive: never = taskType
            logEvent(ctx, "error", "processIdle: unhandled task type", {
                team: team.teamName,
                member: member.name,
                type: String(_exhaustive),
            })
            member.status = "errored"
            member.error = `unhandled task type: ${String(_exhaustive)}`
            break
        }
    }

    // Step 7: Termination checks.
    await checkTermination(ctx, team)
}


/**
 * Step 4 of processIdle: capture the member's output from the current turn.
 * Mode-aware (delegate skips — results go via team_send_message; signoff stage
 * always captures to parse <signoff> tags). Persists the full output to
 * runs/<runId>/<member>.md and the truncated version to responses[].
 */
async function captureMemberOutput(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
    messages: Array<{ info?: any; parts?: any }>,
): Promise<void> {
    if (!team.activeTask) return
    const shouldCapture = team.activeTask.type !== "delegate" || !!team.activeTask.signoffStage
    if (!shouldCapture) return
    // Find the start of the current turn (last user message).
    let turnStart = 0
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.info?.role === "user") {
            turnStart = i + 1
            break
        }
    }
    // Collect all assistant messages in the current turn.
    const outputs: string[] = []
    for (let i = turnStart; i < messages.length; i++) {
        if (messages[i]?.info?.role === "assistant") {
            const text = extractOutputFromParts(messages[i]?.parts)
            if (text) outputs.push(text)
        }
    }
    if (outputs.length > 0) {
        const full = outputs.join("\n\n")
        // responses[] stays truncated for context-safety (loaded into state.json
        // and injected into prompts). The FULL output is persisted separately to
        // runs/<runId>/<member>.md so #2 retrieval can recover it losslessly.
        team.activeTask.responses[member.name] = truncateOutput(full)
        const runId = (team.activeTask.runId ??= crypto.randomUUID())
        await atomicWrite(
            runMemberOutputPath(team.directory, runId, member.name),
            full,
        ).catch(err =>
            logSwallowed(ctx, "persist member output failed", err, {
                team: team.teamName,
                member: member.name,
            }),
        )
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "captured",
            member: member.name,
            bytes: full.length,
        })
    }
}

const RETRY_ESCALATION_MS = 60_000

/**
 * handle session.status events. session.idle carries no error signal and a
 * retrying member never idles, so we subscribe to session.status to catch
 * retry/error and escalate a sustained retry to "errored" (otherwise the
 * barrier would wait forever). Mutates member state under the team mutex.
 */
export async function handleStatusEvent(
    ctx: PluginContext,
    event: { properties?: Record<string, unknown>; type?: string },
): Promise<void> {
    const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID
    if (!sessionID) return
    const member = await resolveTeamMember(ctx.storageRoot, sessionID)
    if (!member || member.isMaster) return

    const team = await loadTeamState(ctx.storageRoot, member.teamName, member.leadSessionId)
    await team.mutex.runExclusive(async () => {
        // Tombstone: team was deleted under the mutex; bail before any state
        // mutation or saveTeamState — mirrors processIdle's guard (line 113).
        // Without this, a late session.status event after team_delete would
        // saveTeamState and recreate the just-removed directory via
        // atomicWrite's mkdir({recursive:true}).
        if (team.deleted) return
        const live = team.members.find(m => m.name === member.name)
        if (!live) return
        // Omit the directory filter so sessions in member worktrees (a different
        // directory) are also returned — otherwise a worktree member stuck in retry
        // is never seen and retry escalation never fires.
        const status = await ctx.client.session.status({})
        const entry = (status.data as Record<string, { type: string; message?: string }> | undefined)?.[sessionID]
        if (entry?.type === "retry") {
            live.retryingSince ??= Date.now()
            if (Date.now() - live.retryingSince > RETRY_ESCALATION_MS) {
                const maxRetries = team.activeTask?.maxRetries ?? 0
                if ((live.retryCount ?? 0) < maxRetries) {
                    // Bounded retry (grace-extension): give the provider another
                    // RETRY_ESCALATION_MS window instead of erroring immediately.
                    // Host-safe (no re-dispatch of an in-flight session); the
                    // member is marked errored only after maxRetries windows.
                    live.retryCount = (live.retryCount ?? 0) + 1
                    live.retryingSince = Date.now()
                    recordEvent(team, {
                        timestamp: Date.now(),
                        kind: "retry",
                        member: live.name,
                        detail: `grace ${live.retryCount}/${maxRetries}`,
                    })
                    await saveTeamState(team)
                    return
                }
                live.status = "errored"
                live.error =
                    `sustained retry > ${RETRY_ESCALATION_MS}ms`
                    + ((live.retryCount ?? 0) > 0 ? ` after ${live.retryCount} retries` : "")
                    + `: ${entry.message ?? "unknown"}`
                await saveTeamState(team)
                recordEvent(team, {
                    timestamp: Date.now(),
                    kind: "errored",
                    member: live.name,
                    reason: live.error,
                })
                await checkTermination(ctx, team) // fail-fast if over tolerance / all errored
                // Re-drive using the SAME routing as processIdle: if this errored
                // member was the LAST to reach a terminal state, no further idle
                // event will arrive. checkTermination above only fail-fasts;
                // within tolerance it is a no-op, so re-evaluate completion / the
                // barrier here. Handlers are safe with an errored `live`:
                // dispatchToMember skips errored members (no revival of a terminal
                // member), and the completion / quorum / deadlock checks run
                // regardless of the passed member.
                if (team.activeTask) {
                    if (team.activeTask.reduceStage) {
                        await handleReduceIdle(ctx, team, live)
                    } else if (team.activeTask.signoffStage) {
                        await handleSignoffIdle(ctx, team, live)
                    } else {
                        switch (team.activeTask.type) {
                            case "parallel":
                                await handleParallelIdle(ctx, team)
                                break
                            case "delegate":
                                await handleDelegateIdle(ctx, team, live)
                                break
                            case "recurse":
                                await handleRecurseIdle(ctx, team, live)
                                break
                            // Sequential modes (pipeline/loop/consensus/route/
                            // arbitrate/tollgate) have tolerance 0, so the
                            // checkTermination above already fail-fast cleared
                            // activeTask — nothing to re-drive here.
                            default:
                                break
                        }
                    }
                }
                // Persist the terminal transition: checkTermination / the barrier
                // re-drive may have cleared activeTask and flipped team.status, but
                // the only save above predates them. Without this, state.json stays
                // "busy" on disk after the run actually finished here — staling the
                // sidebar and mis-reconciling a completed run as failed on restart.
                await saveTeamState(team)
            }
        } else if (entry?.type === "idle") {
            live.retryingSince = undefined
            await saveTeamState(team)
        }
    })
}

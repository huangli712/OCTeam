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

import crypto from "node:crypto"
import { readFile } from "node:fs/promises"
import type { PluginContext } from "../core/context.js"
import { type Team, loadTeamState, saveTeamState } from '../state/store.js';
import { countUnreadMessages } from "../messaging/mailbox.js"
import { sendWakeHint } from "../messaging/wake-hint.js"
import { extractOutputFromParts, isEnoent, sumMemberTokens, truncateOutput } from '../core/utils.js';
import { findActiveWorkflowStepIndexForMember, getActiveWorkflowStepActors } from "./workflow-dag.js"
import { resolveTeamMember } from "../state/resolve.js"
import { safeMemberAgent } from "../core/role.js"
import { atomicWrite } from "../state/locks.js"
import { runMemberOutputPath, runReduceOutputPath } from "../state/paths.js"
import type { ActiveTask, MemberState, OrchestrationType } from "../core/types.js"
import { deliverQueuedResultsToMaster } from "./summary.js"
import { checkTermination } from "./termination.js"
import { recordEvent } from "./events.js"
import { handleReduceIdle, handleSignoffIdle } from "./signoff.js"
import { handleConsensusIdle } from "./consensus.js"
import { handleParallelIdle } from "./parallel.js"
import { handlePipelineIdle } from "./pipeline.js"
import { handleLoopIdle } from "./loop.js"
import { handleDelegateIdle } from "./delegate.js"
import { handleRecurseIdle } from "./recurse.js"
import { handleTollgateIdle } from "./tollgate.js"
import { handleRouteIdle } from "./route.js"
import { handleArbitrateIdle } from "./arbitrate.js"
import { advanceWorkflowStep, handleWorkflowIdle } from "./workflow.js"
import { handleArenaIdle } from "./arena.js"

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
    if (task.type === "arena") {
        // implement phase: any candidate advances the barrier (null); evaluate
        // phase: only the evaluator advances (a stray candidate idle is a no-op).
        return task.arenaPhase === "evaluate" ? (task.evaluatorMember ?? null) : null
    }
    if (task.type === "recurse") return null   // same as delegate: any member advances
    if (task.type === "workflow") {
        // workflow: linear state expects one actor; fanout frontiers can have
        // several active branch actors and are rejected inside handleWorkflowIdle.
        const actors = getActiveWorkflowStepActors(task)
        return actors.length === 1 ? (actors[0] ?? null) : null
    }
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

// processIdle helpers (extracted from the 158-line function for readability)

/**
 * Steps 2-3: Fetch session messages, recompute token accounting (always from
 * full history, never +=), and validate the idle member's identity (stray
 * idle must not advance pipeline/loop). Returns the fetched messages for
 * Step 4 (captureMemberOutput) to reuse without a second API call, or null
 * if this is a stray idle (caller must return after persisting).
 */
async function accountAndValidateIdle(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
    sessionID: string,
): Promise<Array<{ info?: any; parts?: any }> | null> {
    const msgs = await ctx.client.session.messages({ path: { id: sessionID } })
    const messages = (msgs.data ?? []) as Array<{ info?: any; parts?: any }>
    if (team.activeTask) {
        // Step 2: Token accounting (recompute from full history, never +=).
        team.activeTask.tokensByMember[member.name] = sumMemberTokens(messages)
        team.activeTask.tokensUsed = Object.values(team.activeTask.tokensByMember).reduce(
            (a, b) => a + b,
            0,
        )
        // Step 3: Identity validation — stray idle must not advance pipeline/loop.
        const expected = getExpectedMember(team.activeTask)
        if (expected !== null && member.name !== expected) {
            await saveTeamState(team) // persist token tally; do NOT advance
            return null
        }
    }
    return messages
}

/**
 * require_done_ack recovery: a member that went idle without calling
 * team_done() is "premature idle". Re-prompt it with explicit instructions
 * instead of consulting the barrier (which would not fire anyway, since
 * declaredDone is still false, but re-prompting here gives the member a
 * chance to ack or report a blocker). maxMemberTurns / wall-clock timeout
 * (checkTermination) cap retries.
 * Returns true if re-prompted (caller must return); false to proceed normally.
 */
async function maybeRepromptPrematureIdle(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
): Promise<boolean> {
    if (!team.activeTask) return false
    if (
        team.activeTask.requireDoneAck
        && (team.activeTask.mode === "isolated" || team.activeTask.mode === "cooperative")
        && !member.declaredDone
        && member.sessionId
    ) {
        await ctx.client.session.promptAsync({
            path: { id: member.sessionId },
            body: {
                parts: [{ type: "text", text: buildPrematureIdleReprompt(team.teamName), synthetic: true }],
                agent: safeMemberAgent(member.agent),
            },
            query: { directory: member.worktreePath ?? ctx.directory },
        })
        member.status = "running"
        member.turnCount++
        await saveTeamState(team)
        await checkTermination(ctx, team)
        return true
    }
    return false
}

/**
 * Idle dispatch table. Record<OrchestrationType, ...> enforces compile-time
 * completeness: adding a new OrchestrationType without a table entry is a
 * type error. Wrappers adapt heterogeneous handler signatures (some take
 * member, some don't) to a uniform interface.
 */
const idleDispatch: Record<OrchestrationType, (ctx: PluginContext, team: Team, member: MemberState) => Promise<void>> = {
    parallel: async (ctx, team) => handleParallelIdle(ctx, team),
    consensus: async (ctx, team) => handleConsensusIdle(ctx, team),
    pipeline: async (ctx, team, member) => handlePipelineIdle(ctx, team, member),
    loop: async (ctx, team, member) => handleLoopIdle(ctx, team, member),
    delegate: async (ctx, team, member) => handleDelegateIdle(ctx, team, member),
    route: async (ctx, team) => handleRouteIdle(ctx, team),
    arbitrate: async (ctx, team) => handleArbitrateIdle(ctx, team),
    recurse: async (ctx, team, member) => handleRecurseIdle(ctx, team, member),
    tollgate: async (ctx, team, member) => handleTollgateIdle(ctx, team, member),
    workflow: async (ctx, team, member) => handleWorkflowIdle(ctx, team, member),
    arena: async (ctx, team, member) => handleArenaIdle(ctx, team, member),
}

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

    // Steps 2-3: Token accounting + identity validation.
    const messages = await accountAndValidateIdle(ctx, team, member, sessionID)
    if (messages === null) return // stray idle

    // Step 4: Capture output (mode-aware; delegate skips, signoff always captures).
    await captureMemberOutput(team, member, messages)

    await saveTeamState(team)

    // Step 5: Unread messages — wake hint only (Transform hook injects content).
    const unread = await countUnreadMessages(team.directory, member.name)
    if (unread > 0) {
        await sendWakeHint(ctx, sessionID, unread)
        return
    }

    // Step 6: Dispatch by active-task type via the handler table.
    // Record<OrchestrationType, ...> enforces compile-time completeness:
    // a new mode without a table entry is a type error, not a runtime gap.
    if (!team.activeTask) return
    const taskType = team.activeTask.type
    if (team.activeTask.approvalStage) {
        return
    }
    // reduce stage takes priority (real map-reduce).
    if (team.activeTask.reduceStage) {
        await handleReduceIdle(ctx, team, member)
        await checkTermination(ctx, team)
        return
    }
    // signoff stage takes priority over normal mode dispatch.
    if (team.activeTask.signoffStage) {
        await handleSignoffIdle(ctx, team, member)
        await checkTermination(ctx, team)
        return
    }
    // require_done_ack recovery (parallel-only): re-prompt premature idle.
    if (taskType === "parallel" && await maybeRepromptPrematureIdle(ctx, team, member)) return

    await idleDispatch[taskType](ctx, team, member)

    // Step 7: Termination checks.
    await checkTermination(ctx, team)
}


/**
 * Build the accumulated run-member output by appending the current turn's
 * output to whatever was captured previously. EVERY turn (including the first)
 * is prefixed with a separator carrying the capture timestamp and turn
 * byte-length, so the file reads as a complete, uniformly-delimited transcript
 * of the member's deliveries across the run (NOT just the last turn).
 *
 * Extracted from captureMemberOutput so the accumulation logic is unit-testable
 * independent of ctx/team plumbing. Pure: no IO, no side effects.
 */
export function appendTurnBlock(prev: string, turnOutput: string, capturedIso: string): string {
    const block = `--- captured ${capturedIso} (${turnOutput.length} bytes) ---\n\n${turnOutput}`
    return prev === "" ? block : `${prev}\n\n${block}`
}

/**
 * Step 4 of processIdle: capture the member's output from the current turn.
 * Uniform across all modes: turn output is captured to <member>.md. Delegate
 * members ALSO report via team_send_message (mailbox); both paths coexist so
 * run_dir holds a full-output archive while master receives per-task reports.
 *
 * Persistence is ACCUMULATIVE across turns (not last-turn overwrite): a member
 * may idle multiple times in one run (reducer role, re-prompt, multi-turn
 * incremental delivery). Overwriting would silently drop earlier turns'
 * deliverables. The file is read, the new turn is appended via appendTurnBlock,
 * and the result is written back atomically.
 *
 * Reduce-stage routing: when the parallel task is in its reduce stage and this
 * member is the reducer, the output is the run-level reduced artifact (a
 * synthesis of ALL members' outputs), not this member's own deliverable. It is
 * persisted to runs/<runId>/reduce.md (run-scoped) so it never overwrites the
 * reducer's own <member>.md. Both files accumulate.
 *
 * responses[] still receives the truncated CURRENT turn (loaded into state.json
 * and injected into prompts; also the source of reducedResult in handleReduceIdle).
 */
export async function captureMemberOutput(
    team: Team,
    member: MemberState,
    messages: Array<{ info?: any; parts?: any }>,
): Promise<void> {
    const task = team.activeTask
    if (!task) return
    // All modes capture turn output to <member>.md. Delegate members ALSO
    // report via team_send_message; both paths coexist (mailbox is the
    // per-task report, .md is the lossless full-turn archive).
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
    if (outputs.length === 0) return
    const full = outputs.join("\n\n")
    // responses[] stays truncated for context-safety (loaded into state.json
    // and injected into prompts; handleReduceIdle reads reducedResult from here).
    // The FULL accumulated output is persisted separately to runs/<runId>/*.md
    // so #2 retrieval can recover it losslessly across ALL turns.
    const captured = truncateOutput(full)
    if (task.type === "workflow" && !task.signoffStage) {
        const activeStepIndex = findActiveWorkflowStepIndexForMember(task, member.name)
        if (activeStepIndex === null) return
        const activeStep = task.steps?.[activeStepIndex]
        if (activeStep?.kind === "task") {
            activeStep.output = activeStep.maxOutputBytes !== undefined
                ? truncateOutput(captured, activeStep.maxOutputBytes)
                : captured
        }
        if (activeStep?.kind === "gate") {
            activeStep.output = captured
        }
    }
    task.responses[member.name] = captured
    const runId = (task.runId ??= crypto.randomUUID())

    // Reduce-stage reducer output is a run-level artifact, not the reducer's own
    // deliverable. Route it to runs/<runId>/reduce.md so it never overwrites the
    // reducer's <member>.md (which holds that member's primary task output).
    const isReduceTurn =
        task.type === "parallel" && !!task.reduceStage && member.name === task.reducerMember
    const outPath = isReduceTurn
        ? runReduceOutputPath(team.directory, runId)
        : runMemberOutputPath(team.directory, runId, member.name)

    // Accumulate: read whatever was previously captured for this target, append
    // the current turn with a separator, and write back atomically. A member
    // (or the reducer slot) can idle more than once in a run — without this,
    // each idle would overwrite prior turns' deliverables.
    let prev = ""
    try {
        prev = await readFile(outPath, "utf8")
    } catch (err) {
        if (!isEnoent(err)) throw err
    }
    const accumulated = appendTurnBlock(prev, full, new Date().toISOString())

    await atomicWrite(outPath, accumulated)
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "captured",
        member: member.name,
        bytes: full.length,
    })
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
                            case "workflow":
                                await advanceWorkflowStep(ctx, team)
                                break
                            case "arena":
                                // If this errored member was the LAST candidate to
                                // reach a terminal state, no further idle event will
                                // arrive. Re-drive the barrier so it re-evaluates
                                // (waitForBarrier counts errored as terminal-ready)
                                // and the run advances to evaluate / fails instead of
                                // hanging to wall-clock. handleArenaIdle ignores the
                                // passed member's identity in the implement phase.
                                await handleArenaIdle(ctx, team, live)
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
        } else if (entry?.type === "busy") {
            // Sync member.status with the actual session state. A member may
            // be flipped to busy by a wake-hint (promptAsync) without going
            // through dispatchToMember — without this branch member.status
            // stays "idle" while the session is actually working, which makes
            // the delegate/recurse deadlock check (allIdle) false-positive.
            // NOTE: the SDK SessionStatus type uses "busy" (not "running") for
            // an actively-processing session.
            if (live.status === "idle") {
                live.status = "running"
                await saveTeamState(team)
            }
        }
    })
}

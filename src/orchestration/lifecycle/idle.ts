/**
 * The idle state machine. processIdle is the single entry point
 * driven by session.idle events (and the sweep timer's missed-idle
 * reconciliation). It MUST be called inside team.mutex.runExclusive — the
 * event-handler wrapper acquires the mutex, this function mutates state freely.
 *
 * Steps:
 *   1. Master special case — drain queued results, return (master never dispatches)
 *   2. Flip member to idle
 *   3. Role-setup barrier — first idle of uninitialized member marks it ready, returns
 *   4. Token accounting (recompute, never +=)
 *   5. Identity validation (stray idle does not advance pipeline/loop)
 *   6. Capture output (delegated to records/capture.ts)
 *   6.5. Recurse decompose short-circuit (process <decompose> before wake-hint)
 *   7. Unread-message wake hint (returns; Transform hook injects content next turn)
 *   8. Dispatch by active-task type
 *   9. Termination checks
 */

import type { PluginContext } from "../../core/context.js"
import { dispatchToMember } from "../control/dispatch.js"
import type { ActiveTask, MemberState, OrchestrationType, SdkMessage } from "../../core/types.js"
import { type Team, saveTeamState } from "../../state/store.js"
import { countUnreadMessages } from "../../messaging/mailbox.js"
import { sendWakeHint } from "../../messaging/wake-hint.js"
import { asSdkMessages, sumMemberTokens } from "../protocol/output.js"
import {
    findActiveWorkflowStepIndexForMember,
    getActiveWorkflowStepActors,
    getActiveWorkflowStepIndices,
} from "../workflow/dag.js"
import { deliverQueuedResultsToMaster } from "../control/delivery.js"
import { handleSignoffIdle } from "../control/signoff.js"
import { checkTermination } from "./termination.js"
import { handleReduceIdle } from "../modes/reduce.js"
import { handleConsensusIdle } from "../modes/consensus.js"
import { handleParallelIdle } from "../modes/parallel.js"
import { handlePipelineIdle } from "../modes/pipeline.js"
import { handleLoopIdle } from "../modes/loop.js"
import { handleDelegateIdle } from "../modes/delegate.js"
import { handleRecurseIdle } from "../modes/recurse.js"
import { handleTollgateIdle } from "../modes/tollgate.js"
import { handleRouteIdle } from "../modes/route.js"
import { handleArbitrateIdle } from "../modes/arbitrate.js"
import { handleArenaIdle } from "../modes/arena.js"
import { handleWorkflowIdle } from "../workflow/handler.js"
import { handleQuorumIdle } from "../modes/quorum.js"
import { captureMemberOutput, type CaptureMemberOutputResult } from "../records/capture.js"

/**
 * Idle dispatch table. Record<OrchestrationType, ...> enforces compile-time
 * completeness: adding a new OrchestrationType without a table entry is a
 * type error. Wrappers adapt heterogeneous handler signatures (some take
 * member, some don't) to a uniform interface.
 */
const idleDispatch: Record<OrchestrationType, (ctx: PluginContext, team: Team, member: MemberState, captureResult?: CaptureMemberOutputResult) => Promise<void>> = {
    parallel: async (ctx, team) => handleParallelIdle(ctx, team),
    consensus: async (ctx, team, _member, captureResult) => handleConsensusIdle(ctx, team, captureResult),
    pipeline: async (ctx, team, member) => handlePipelineIdle(ctx, team, member),
    loop: async (ctx, team, member, captureResult) => handleLoopIdle(ctx, team, member, captureResult),
    delegate: async (ctx, team, member) => handleDelegateIdle(ctx, team, member),
    route: async (ctx, team, _member, captureResult) => handleRouteIdle(ctx, team, captureResult),
    arbitrate: async (ctx, team, _member, captureResult) => handleArbitrateIdle(ctx, team, captureResult),
    recurse: async (ctx, team, member) => handleRecurseIdle(ctx, team, member),
    tollgate: async (ctx, team, member) => handleTollgateIdle(ctx, team, member),
    workflow: async (ctx, team, member, captureResult) => handleWorkflowIdle(ctx, team, member, captureResult?.fresh),
    arena: async (ctx, team, member, captureResult) => handleArenaIdle(ctx, team, member, captureResult),
    quorum: async (ctx, team) => handleQuorumIdle(ctx, team),
}

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
    if (task.type === "quorum") return null
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
        // An ensemble gate dispatches multiple verifiers in parallel; any of them
        // may advance, so do not nominate a single (last-dispatched) actor —
        // member-specific validation is deferred to handleWorkflowIdle.
        const steps = task.steps ?? []
        for (const index of getActiveWorkflowStepIndices(task)) {
            const step = steps[index]
            if (step?.kind === "gate" && step.verifiers) return null
        }
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
    return `[Team Orchestrator]\n` 
        + `You went idle on team "${teamName}" without calling `
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
): Promise<SdkMessage[] | null> {
    const msgs = await ctx.client.session.messages({ path: { id: sessionID } })
    const messages = asSdkMessages(msgs.data)
    if (team.activeTask) {
        // Step 4: Token accounting keeps the highest full-history observation
        // because session compaction can remove messages and lower the total.
        const baseline = team.activeTask.tokenBaselineByMember?.[member.name] ?? 0
        const observedTokens = Math.max(0, sumMemberTokens(messages) - baseline)
        team.activeTask.tokensByMember[member.name] = Math.max(
            team.activeTask.tokensByMember[member.name] ?? 0,
            observedTokens,
        )
        team.activeTask.tokensUsed = Object.values(team.activeTask.tokensByMember).reduce(
            (a, b) => a + b,
            0,
        )
        // Step 5: Identity validation — stray idle must not advance pipeline/loop.
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
        // H-11: route through the canonical dispatch primitive so promptAsync +
        // member state transition + saveTeamState + event recording are atomic.
        await dispatchToMember(
            ctx,
            member,
            buildPrematureIdleReprompt(team.teamName),
            member.worktreePath ?? ctx.directory,
            team,
        )
        await checkTermination(ctx, team)
        return true
    }
    return false
}

/**
 * Error-recovery barrier re-drive: called from hooks.ts session.error handler.
 * Unlike processIdle, this does NOT gate on member.status === "errored" —
 * the whole point is to let the mode handler see the errored member and
 * advance the barrier past it. Pre-fix code called processIdle which
 * returned immediately at the H6 errored guard.
 */
export async function processErrorRecovery(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
): Promise<void> {
    if (!team.activeTask) return
    if (team.activeTask.approvalStage) return
    if (team.activeTask.signoffStage) {
        await handleSignoffIdle(ctx, team, member)
        await checkTermination(ctx, team)
        return
    }
    if (team.activeTask.reduceStage) {
        await handleReduceIdle(ctx, team, member)
        await checkTermination(ctx, team)
        return
    }
    const taskType = team.activeTask.type
    if (idleDispatch[taskType]) {
        await idleDispatch[taskType](ctx, team, member, undefined)
        await checkTermination(ctx, team)
    }
}

/** Single entry point for the idle state machine, driven by session.idle events. */
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
    // HIGH: stale idle guard — the idle event's sessionID must match the
    // member's current sessionId. A session that was replaced (rename,
    // fixmember, re-spawn) can fire a late idle for the OLD session, which
    // would process the new session's output as if it belonged to the old one.
    if (member.sessionId !== undefined && member.sessionId !== sessionID) {
        return
    }
    // Step 1: Master special case — synthetic member, never dispatches.
    if (member.isMaster) {
        await deliverQueuedResultsToMaster(ctx, team, sessionID)
        return
    }

    // Step 2: member is now idle.
    // H6: refuse stale idle for errored members. An errored member's late
    // idle event (from a turn that was already aborted/failed) must not
    // resurrect the member to idle and re-enter the mode handler.
    if (member.status === "errored") {
        console.warn("processIdle: skipping stale idle for errored member", {
            team: team.teamName, member: member.name,
        })
        return
    }
    // M-1: defer the status flip to "idle" until AFTER output capture
    // succeeds. Pre-fix code set status="idle" at line 250, then called
    // session.messages/captureMemberOutput which can throw (transient host
    // error). The sweep's missed-idle reconciliation only retries members
    // with status==="running", so a read failure permanently stranded the
    // member as idle with uncaptured output. Now: keep status="running"
    // until capture succeeds; the sweep will retry on the next tick.
    // Step 3: Role-setup barrier — first idle of an uninitialized member
    // marks it ready and returns WITHOUT capturing output or advancing.
    if (!member.initialized) {
        member.retryingSince = undefined
        member.initialized = true
        member.status = "idle"
        await saveTeamState(team)
        return
    }

    // Steps 4-5: Token accounting + identity validation.
    const messages = await accountAndValidateIdle(ctx, team, member, sessionID)
    if (messages === null) return // stray idle

    // Step 6: Capture output (mode-aware; delegate skips, signoff always captures).
    // capturedNew signals whether this turn produced fresh assistant output.
    // A decider/reviewer idling during signoffStage with NO new output is a
    // stale pre-signoff idle (its dispatch landed but the signoff turn hasn't
    // replied) — advancing the signoff policy on it would read the stale
    // pre-signoff response and falsely reject. Step 8 gates on this signal.
    const task = team.activeTask
    let captureResult: CaptureMemberOutputResult = { fresh: false, reason: "empty" }
    if (
        task?.type !== "workflow"
        || task.signoffStage === true
        || findActiveWorkflowStepIndexForMember(task, member.name) !== null
    ) {
        captureResult = await captureMemberOutput(team, member, messages)
    }

    if (!captureResult.fresh && captureResult.reason === "stale") {
        const unread = await countUnreadMessages(team.directory, member.name)
        if (unread > 0) await sendWakeHint(ctx, sessionID, unread)
        return
    }
    const capturedNew = captureResult.fresh

    // M-1: now that capture succeeded, flip the status to idle. Pre-fix
    // code flipped at the start; deferring means a capture throw leaves
    // the member as "running" so the sweep retries on the next tick.
    member.retryingSince = undefined
    member.status = "idle"
    await saveTeamState(team)

    // Step 6.5: recurse mode — the decomposer may broadcast coordination
    // messages via team_send_message in the SAME turn as her <decompose> block
    // (the prompt explicitly instructs her to). Those messages land in her
    // teammates' inboxes, who reply BEFORE the decomposer's idle event fires,
    // so the replies are already in the decomposer's own inbox at step 7.
    // Without this guard, step 7's wake-hint early-returns and SKIPS
    // handleRecurseIdle, silently dropping the <decompose> block; the next
    // (wake-hint-triggered) turn captures non-decompose output and overwrites
    // task.responses[decomposer], permanently losing the decomposition intent.
    // If the captured turn contains a decompose tag, hand it to the recurse
    // handler BEFORE the wake-hint short-circuit.
    if (
        task?.type === "recurse"
        && capturedNew
        && /<(?:decompose|分解)>/.test(task.responses[member.name] ?? "")
    ) {
        await idleDispatch[task.type](ctx, team, member, captureResult)
        await checkTermination(ctx, team)
        return
    }

    // Step 7: Unread messages — wake hint only (Transform hook injects content).
    // HIGH-B: only short-circuit on stale idle (!capturedNew). When this turn
    // produced fresh output, the handler MUST run first (step 8) — otherwise
    // the next turn's capture overwrites task.responses[member] with mailbox
    // reply content, losing the original verdict / reduce output / work.
    // After step 8, if the task is still active, we wake-hint so the member
    // drains its mailbox on the next turn.
    const unread = await countUnreadMessages(team.directory, member.name)
    if (unread > 0 && !capturedNew) {
        await sendWakeHint(ctx, sessionID, unread)
        return
    }

    // Step 8: Dispatch by active-task type via the handler table.
    // Record<OrchestrationType, ...> enforces compile-time completeness:
    // a new mode without a table entry is a type error, not a runtime gap.
    if (!team.activeTask) return
    const taskType = team.activeTask.type
    if (team.activeTask.approvalStage) {
        return
    }
    // reduce stage takes priority (real map-reduce).
    if (team.activeTask.reduceStage) {
        await handleReduceIdle(ctx, team, member, captureResult)
        await checkTermination(ctx, team)
        return
    }
    // signoff stage takes priority over normal mode dispatch.
    if (team.activeTask.signoffStage) {
        // MEDIUM #4: only skip on STALE idle (no new turn). A genuinely new
        // but EMPTY turn (reason="empty") must reach handleSignoffIdle so
        // the missing-tag retry path can fire. Pre-fix code blocked ALL
        // non-fresh idles, permanently stalling signoff on empty turns.
        if (captureResult?.fresh === false && captureResult.reason === "stale") return
        await handleSignoffIdle(ctx, team, member)
        await checkTermination(ctx, team)
        return
    }
    // require_done_ack recovery (parallel-only): re-prompt premature idle.
    if (taskType === "parallel" && await maybeRepromptPrematureIdle(ctx, team, member)) return

    await idleDispatch[taskType](ctx, team, member, captureResult)

    // Step 9: Termination checks.
    await checkTermination(ctx, team)

    // HIGH-B: after dispatch, if the task is still active and there are unread
    // messages, wake-hint so the member drains its mailbox on the next turn.
    // This runs only when capturedNew=true caused us to skip the step 7
    // short-circuit above.
    if (capturedNew && team.activeTask && unread > 0) {
        await sendWakeHint(ctx, sessionID, unread)
    }
}

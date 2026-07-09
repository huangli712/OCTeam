/**
 * The idle state machine. processIdle is the single entry point
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
 *   4. Capture output (delegated to capture.ts)
 *   5. Unread-message wake hint (returns; Transform hook injects content next turn)
 *   6. Dispatch by active-task type
 *   7. Termination checks
 */

import type { PluginContext } from "../core/context.js"
import { type Team, saveTeamState } from "../state/store.js"
import { countUnreadMessages } from "../messaging/mailbox.js"
import { sendWakeHint } from "../messaging/wake-hint.js"
import { sumMemberTokens } from "./output.js";
import { getActiveWorkflowStepActors } from "./dag.js"
import { safeMemberAgent } from "../core/role.js"
import type { ActiveTask, MemberState, OrchestrationType, SdkMessage } from "../core/types.js"
import { deliverQueuedResultsToMaster } from "./summary.js"
import { checkTermination } from "./termination.js"
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
import { handleWorkflowIdle } from "./workflow-handler.js"
import { handleArenaIdle } from "./arena.js"
import { captureMemberOutput } from "./capture.js"

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




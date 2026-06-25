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
 */

import type { PluginContext } from "../core/context.js"
import { logEvent } from "../core/log.js"
import { type Team, clearActiveTask, loadTeamState, saveTeamState } from '../state/store.js';
import { countUnreadMessages } from "../messaging/mailbox.js"
import { listAllTasks } from "../state/tasks.js"
import { sendWakeHint } from "../messaging/wake-hint.js"
import { extractOutputFromParts, resolveTeamMember, sumMemberTokens, truncateOutput } from "../core/utils.js"
import type { ActiveTask, DecisionRecord, MemberState } from "../core/types.js"
import { advanceToStage, dispatchToMember } from "./dispatch.js"
import { buildRoundSummary, buildSummary, deliverQueuedResultsToMaster, deliverSummaryToLeader } from "./summary.js"
import { checkTermination } from "./termination.js"

const NOTIFY_COOLDOWN_MS = 10_000
const NO_ISSUES_KEYWORDS = ["no issues", "no bugs found", "no improvements", "all clear"]

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
    return task.stages[task.currentStageIndex]?.member ?? null
}

/**
 * Parse a decider's <decision>{...}</decision> block. On missing/invalid JSON,
 * returns parseFailed:true so handleLoopIdle can count consecutive failures
 * (loop aborts at 3). Defaults to "continue" on failure.
 */
export function parseDecision(rawText: string): DecisionRecord & { parseFailed?: boolean } {
    const fail = (): DecisionRecord & { parseFailed: boolean } => ({
        round: 0,
        decision: "continue",
        rationale: "Decision parse failed; defaulting to continue",
        nextActions: [],
        timestamp: Date.now(),
        parseFailed: true,
    })
    // Greedy {...} so nested braces (e.g. structured nextActions) parse correctly (L2).
    const match = rawText?.match(/<(?:decision|决策)>\s*(\{[\s\S]*\})\s*<\/(?:decision|决策)>/)
    if (!match) return fail()
    try {
        const parsed = JSON.parse(match[1])
        return {
            round: 0,
            decision: parsed.decision === "done" || parsed.done === true ? "done" : "continue",
            rationale: parsed.rationale ?? "No rationale provided",
            nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions : [],
            timestamp: Date.now(),
        }
    } catch {
        return fail()
    }
}

/** Loop exit condition 2: all read_only stages report no issues (keyword match). */
export function allReadOnlyStagesReportNoIssues(task: ActiveTask): boolean {
    const roStages = task.stages.filter(s => s.action === "read_only")
    if (roStages.length === 0) return false
    return roStages.every(s => {
        const out = task.responses[s.member] ?? ""
        const lower = out.toLowerCase()
        return NO_ISSUES_KEYWORDS.some(k => lower.includes(k))
    })
}

/** Consensus: every participant must emit agreed consensus. */
export function allMembersAgree(responses: Record<string, string>): boolean {
    const texts = Object.values(responses)
    if (texts.length === 0) return false
    return texts.every(t => {
        const m = t.match(/<consensus>\s*(\{[\s\S]*\})\s*<\/consensus>/)
        if (!m) return false
        try {
            return JSON.parse(m[1]).agreed === true
        } catch {
            return false
        }
    })
}

/**
 * Parse a <signoff>{"approved": true|false, "rationale": "..."}</signoff> block
 * from a reviewer's output. Returns null if no valid signoff tag found.
 */
export function parseSignoff(text: string): { approved: boolean; rationale: string } | null {
    const m = text?.match(/<signoff>\s*(\{[\s\S]*\})\s*<\/signoff>/)
    if (!m) return null
    try {
        const parsed = JSON.parse(m[1])
        return {
            approved: parsed.approved === true,
            rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
        }
    } catch {
        return null
    }
}

/**
 * Check peer-quorum signoff status. Returns whether all reviewers have
 * responded, whether the quorum threshold was reached, and the approval count.
 * Exported for unit testing.
 */
export function isQuorumReached(
    approvals: Record<string, boolean>,
    reviewerCount: number,
    quorum: number,
): { allResponded: boolean; reached: boolean; approvedCount: number } {
    const responses = Object.keys(approvals).length
    const allResponded = responses >= reviewerCount
    const approvedCount = Object.values(approvals).filter(Boolean).length
    const reached = allResponded && reviewerCount > 0 && approvedCount / reviewerCount >= quorum
    return { allResponded, reached, approvedCount }
}

/**
 * Idempotent barrier check (NOT blocking). Called from handleParallelIdle on
 * each idle. If all participating members are idle, fires onBarrier exactly
 * once for this phase (the mutex guarantees the status flips are atomic, so a
 * later idle in the same phase sees members already "running" → no double-fire).
 *
 * require_done_ack mode: the readiness signal is `declaredDone === true`
 * (set by team_done tool) instead of `status === "idle"`. This prevents the
 * barrier from firing when a member goes idle prematurely (e.g. waiting for a
 * dependency); the barrier only fires after every participant has explicitly
 * acknowledged completion.
 *
 * Exported for direct unit testing of the readiness predicate.
 */
export async function waitForBarrier(
    team: Team,
    memberNames: string[],
    onBarrier: () => Promise<void>,
): Promise<void> {
    const requireDoneAck = team.activeTask?.requireDoneAck === true
    const allReady = memberNames.every(name => {
        const m = team.members.find(x => x.name === name)
        if (!m) return false
        // errored is TERMINAL: it counts toward the barrier so survivors can be
        // delivered (failure isolation). Checked first so it also unblocks a
        // require_done_ack run, where an errored member never calls team_done().
        if (m.status === "errored") return true
        return requireDoneAck
            ? m.declaredDone === true
            : m.status === "idle"
    })
    if (allReady) {
        await onBarrier()
    }
    // else: return — the next idle/ack re-checks. checkTermination + sweep enforce timeouts.
}

// --- main entry ---

export async function processIdle(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
    sessionID: string,
): Promise<void> {
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

    // Step 4: Capture output (null-guarded + mode-aware). delegate does NOT use
    // responses[] (per-task results go to master via team_send_message; capturing
    // here would overwrite). Exception: signoff stage must capture reviewer
    // output regardless of task type (to parse <signoff> tags).
    //
    // Scans ALL assistant messages in the current turn (not just the last) and
    // extracts both text and work-tool invocations (write/edit/bash) so that
    // members who use tools to produce code are properly captured.
    if (team.activeTask) {
        const shouldCapture = team.activeTask.type !== "delegate" || !!team.activeTask.signoffStage
        if (shouldCapture) {
            // Find the start of the current turn (last user message).
            let turnStart = 0
            for (let i = messages.length - 1; i >= 0; i--) {
                if ((messages[i] as any)?.info?.role === "user") {
                    turnStart = i + 1
                    break
                }
            }
            // Collect all assistant messages in the current turn.
            const outputs: string[] = []
            for (let i = turnStart; i < messages.length; i++) {
                if ((messages[i] as any)?.info?.role === "assistant") {
                    const text = extractOutputFromParts((messages[i] as any).parts)
                    if (text) outputs.push(text)
                }
            }
            if (outputs.length > 0) {
                team.activeTask.responses[member.name] = truncateOutput(outputs.join("\n\n"))
            }
        }
    }

    await saveTeamState(team)

    // Step 5: Unread messages — wake hint only (Transform hook injects content).
    const unread = await countUnreadMessages(team.directory, member.name)
    if (unread > 0) {
        await sendWakeHint(ctx, sessionID, unread)
        return
    }

    // Step 6: Dispatch by active-task type.
    if (!team.activeTask) return
    // signoff stage takes priority over normal mode dispatch
    if (team.activeTask.signoffStage) {
        await handleSignoffIdle(ctx, team, member)
        await checkTermination(ctx, team)
        return
    }
    switch (team.activeTask.type) {
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
                const text =
                    `[Team Orchestrator] You went idle on team "${team.teamName}" without calling `
                    + `team_done(team_id="${team.teamName}"). This run uses require_done_ack: the `
                    + `barrier fires ONLY after every participant calls team_done. `
                    + `If your work is complete (including required messages and self-verification), `
                    + `call team_done now. If you are blocked waiting for a dependency, briefly say `
                    + `what you are waiting for AND do any other independent work you can; do NOT go `
                    + `idle again without either acking or making concrete progress.`
                await ctx.client.session.promptAsync({
                    path: { id: member.sessionId },
                    body: {
                        parts: [{ type: "text", text, synthetic: true }],
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
    }

    // Step 7: Termination checks.
    await checkTermination(ctx, team)
}

// --- signoff helpers (Phase B: decider mode; Phase D adds peer-quorum) ---

/**
 * Check if a signoff stage is required and trigger it if so. Returns true if
 * signoff was triggered (caller must NOT deliver summary); false if no signoff
 * needed (caller proceeds with deliverSummaryToLeader).
 */
async function maybeTriggerSignoff(ctx: PluginContext, team: Team): Promise<boolean> {
    const task = team.activeTask
    if (!task) return false
    if (!task.signoffPolicy || task.signoffPolicy === "none") return false
    if (task.signoffStage) return true  // already in signoff

    task.signoffStage = true
    task.signoffApprovals = {}

    const summary = await buildSummary(team, task, "pending_signoff")
    const reviewPrompt =
        `[Signoff review] Review the following workflow output. `
        + `If it meets quality standards, emit <signoff>{"approved": true, "rationale": "..."}</signoff>. `
        + `If not, emit <signoff>{"approved": false, "rationale": "specific issues..."}</signoff>.\n\n${summary}`

    if (task.signoffPolicy === "decider") {
        const decider = team.members.find(m => m.name === task.signoffDecider && !m.isMaster)
        if (!decider?.sessionId) {
            // decider unavailable, fall back to direct delivery
            task.signoffStage = false
            return false
        }
        await dispatchToMember(ctx, decider, reviewPrompt, decider.worktreePath ?? ctx.directory)
    } else if (task.signoffPolicy === "peer-quorum") {
        // Dispatch to all non-master members with a session.
        const reviewers = team.members.filter(m => !m.isMaster && m.sessionId)
        if (reviewers.length === 0) {
            task.signoffStage = false
            return false
        }
        for (const m of reviewers) {
            await dispatchToMember(ctx, m, reviewPrompt, m.worktreePath ?? ctx.directory)
        }
    }

    await saveTeamState(team)
    return true
}

/**
 * Handle a reviewer's idle during the signoff stage. Parses <signoff> from the
 * reviewer's output and either delivers the final summary (decider mode) or
 * waits for more reviewers (peer-quorum mode, Phase D).
 */
async function handleSignoffIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    const task = team.activeTask
    if (!task?.signoffStage) return

    const memberOutput = task.responses[member.name] ?? ""
    const signoff = parseSignoff(memberOutput)
    if (!signoff) {
        logEvent(ctx, "debug", "signoff tag parse failed", { team: team.teamName, member: member.name })
    }
    // record approval (false if parse failed)
    task.signoffApprovals![member.name] = signoff?.approved === true

    if (task.signoffPolicy === "decider") {
        const approved = signoff?.approved === true
        const reason = approved ? "signoff_approved" : "signoff_rejected"
        await deliverSummaryToLeader(ctx, team, reason)
        clearActiveTask(team)
        team.status = "idle"
    } else if (task.signoffPolicy === "peer-quorum") {
        // Wait for all reviewers to respond, then check quorum.
        const reviewers = team.members.filter(m => !m.isMaster && m.sessionId).map(m => m.name)
        const { allResponded, reached } = isQuorumReached(
            task.signoffApprovals ?? {},
            reviewers.length,
            task.signoffQuorum ?? 0.5,
        )
        if (!allResponded) return  // wait for more

        const reason = reached ? "signoff_quorum_reached" : "signoff_quorum_not_reached"
        await deliverSummaryToLeader(ctx, team, reason)
        clearActiveTask(team)
        team.status = "idle"
    }
}

// --- per-mode handlers ---

async function handleParallelIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task) return
    const participants = team.members.filter(m => !m.isMaster).map(m => m.name)

    await waitForBarrier(team, participants, async () => {
        // Failure isolation: count terminally-errored members. Within tolerance →
        // deliver survivors (partial success); over tolerance or no survivors → fail.
        const errored = participants.filter(
            n => team.members.find(m => m.name === n)?.status === "errored",
        )
        const tolerance = task.maxErroredMembers ?? 0
        const survivors = participants.length - errored.length
        if (survivors === 0 || errored.length > tolerance) {
            const e = team.members.find(m => m.name === errored[0])
            await deliverSummaryToLeader(ctx, team, `member_error:${e?.name}:${e?.error ?? "unknown"}`)
            clearActiveTask(team)
            team.status = "failed"
            return
        }
        // Maybe trigger signoff before delivering.
        if (await maybeTriggerSignoff(ctx, team)) {
            return  // signoff in progress
        }
        // Single barrier: collect outputs → deliver to leader → done.
        const reason = errored.length > 0
            ? `parallel_${task.mode}_partial:${errored.length}_errored`
            : `parallel_${task.mode}_complete`
        await deliverSummaryToLeader(ctx, team, reason)
        clearActiveTask(team)
        team.status = "idle"
    })
}

async function handleConsensusIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task) return
    const participants = team.members.filter(m => !m.isMaster).map(m => m.name)

    await waitForBarrier(team, participants, async () => {
        task.consensusReached = allMembersAgree(task.responses)
        if (task.consensusReached) {
            await deliverSummaryToLeader(ctx, team, "consensus_reached")
            clearActiveTask(team)
            team.status = "idle"
            return
        }
        if ((task.currentRound ?? 0) >= (task.maxRounds ?? 0)) {
            // Reached here only when consensus was NOT detected → failed.
            await deliverSummaryToLeader(ctx, team, "consensus_max_rounds")
            clearActiveTask(team)
            team.status = "failed"
            return
        }
        // Next round: broadcast prior-round summary, reset to running.
        task.currentRound = (task.currentRound ?? 0) + 1
        const summary = buildRoundSummary(task.responses)
        const roundText =
            `[Consensus Round ${task.currentRound}] Others said:\n${summary}\n\n`
            + `Respond, then emit <consensus>{"agreed": true|false}</consensus>.`
        for (const m of team.members.filter(x => !x.isMaster)) {
            await dispatchToMember(ctx, m, roundText, m.worktreePath ?? ctx.directory)
        }
    })
}

async function handlePipelineIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    const task = team.activeTask
    if (!task) return
    const stages = task.stages

    const currentStage = stages[task.currentStageIndex]
    if (!currentStage || currentStage.member !== member.name) return // stray idle

    currentStage.completed = true

    const nextIndex = stages.findIndex(s => !s.completed)
    if (nextIndex === -1) {
        // All stages complete → maybe trigger signoff, then deliver.
        if (await maybeTriggerSignoff(ctx, team)) {
            return  // signoff in progress
        }
        await deliverSummaryToLeader(ctx, team, "pipeline_complete")
        clearActiveTask(team)
        team.status = "idle"
        return
    }

    task.currentStageIndex = nextIndex
    const nextStage = stages[nextIndex]
    const nextMember = team.members.find(m => m.name === nextStage.member)
    if (!nextMember || !nextMember.sessionId) return

    const prevResult = nextIndex > 0 ? task.responses[stages[nextIndex - 1].member] : null
    const fullTask = prevResult
        ? `[Output from ${stages[nextIndex - 1].member}]\n${truncateOutput(prevResult)}\n\n[Your task]\n${nextStage.task}`
        : nextStage.task

    await ctx.client.session.promptAsync({
        path: { id: nextMember.sessionId },
        body: {
            parts: [{ type: "text", text: fullTask, synthetic: true }],
            agent: nextMember.agent ?? "build",
        },
        query: { directory: nextMember.worktreePath ?? ctx.directory },
    })
    nextMember.status = "running"
    nextMember.turnCount++
}

async function handleLoopIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    const task = team.activeTask
    if (!task) return
    const stages = task.stages

    const currentStage = stages[task.currentStageIndex]
    if (!currentStage || currentStage.member !== member.name) return // stray idle

    currentStage.completed = true
    task.currentStageIndex++

    if (task.currentStageIndex < stages.length) {
        // Next stage in current round.
        await advanceToStage(ctx, team, stages[task.currentStageIndex])
        return
    }

    // All stages complete (including decider). Decider output is the last stage.
    const deciderOutput = task.responses[task.deciderMember ?? ""]
    const decision = parseDecision(deciderOutput ?? "")

    if (decision.parseFailed) {
        logEvent(ctx, "warn", "decision parse failed", { team: team.teamName, member: member.name })
        task.decisionParseFailures++
        if (task.decisionParseFailures >= 3) {
            await deliverSummaryToLeader(ctx, team, "loop_complete:decision_parse_failure")
            clearActiveTask(team)
            team.status = "failed"
            return
        }
    } else {
        task.decisionParseFailures = 0
    }

    if (decision.decision === "done") {
        await deliverSummaryToLeader(ctx, team, "loop_complete:decider_done")
        task.decisionHistory.push({ ...decision, round: task.currentRound ?? 0 })
        clearActiveTask(team)
        team.status = "idle"
        return
    }

    if ((task.currentRound ?? 0) >= (task.maxRounds ?? 0)) {
        await deliverSummaryToLeader(ctx, team, "loop_complete:max_rounds")
        clearActiveTask(team)
        team.status = "failed"
        return
    }

    if (allReadOnlyStagesReportNoIssues(task)) {
        await deliverSummaryToLeader(ctx, team, "loop_complete:no_issues")
        clearActiveTask(team)
        team.status = "idle"
        return
    }

    // Continue to next round — inject the decider's feedback (rationale +
    // nextActions) into stage 0's prompt so the loop is actually corrective.
    // Without this the next round re-sends the original task verbatim.
    task.decisionHistory.push({ ...decision, round: task.currentRound ?? 0 })
    task.currentRound = (task.currentRound ?? 0) + 1
    task.currentStageIndex = 0
    for (const s of task.stages) s.completed = false
    const feedback =
        `[Round ${task.currentRound} — decider feedback]\n${decision.rationale}`
        + (decision.nextActions.length > 0
            ? `\nNext actions:\n${decision.nextActions.map(a => `- ${a}`).join("\n")}`
            : "")
    await advanceToStage(ctx, team, stages[0], feedback)
}

async function handleDelegateIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    const tasks = await listAllTasks(team.directory)
    const incomplete = tasks.filter(t => t.status !== "completed" && t.status !== "deleted")

    // All done?
    if (incomplete.length === 0) {
        if (await maybeTriggerSignoff(ctx, team)) {
            return  // signoff in progress
        }
        await deliverSummaryToLeader(ctx, team, "delegate_complete")
        clearActiveTask(team)
        team.status = "idle"
        return
    }

    // Claimable tasks: pending AND all blockers completed.
    const claimable = incomplete.filter(
        t =>
            t.status === "pending"
            && t.blockedBy.every(id => tasks.find(x => x.id === id)?.status === "completed"),
    )

    // Deadlock: no claimable tasks and all members idle.
    if (claimable.length === 0) {
        // errored counts as terminal (like idle) so an errored member cannot wedge
        // the deadlock check — its claimed tasks are reaped by the sweep and a
        // survivor reclaims them.
        const allIdle = team.members.every(m => m.status === "idle" || m.status === "errored" || !m.sessionId)
        if (allIdle) {
            await deliverSummaryToLeader(ctx, team, "delegate_deadlock")
            clearActiveTask(team)
            team.status = "failed"
            return
        }
        return // some members still running, wait
    }

    // Re-prompt this member — RATE-LIMITED to avoid claim-race busy-loop.
    const now = Date.now()
    if (member.lastNotifiedAt && now - member.lastNotifiedAt < NOTIFY_COOLDOWN_MS) {
        return
    }
    const running = team.members.filter(m => m.status === "running" && !m.isMaster).length
    if (claimable.length <= running) {
        return // enough members already heading for the available tasks
    }
    if (!member.sessionId) return
    member.lastNotifiedAt = now
    const reprompt =
        `[Team Orchestrator] You have completed your task. ${claimable.length} task(s) available. `
        + `Use team_task_list to check, team_task_update to claim, execute, then team_send_message `
        + `to report to master. Repeat until no tasks remain.`
    await dispatchToMember(ctx, member, reprompt, member.worktreePath ?? ctx.directory)
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
                    await saveTeamState(team)
                    return
                }
                live.status = "errored"
                live.error =
                    `sustained retry > ${RETRY_ESCALATION_MS}ms`
                    + ((live.retryCount ?? 0) > 0 ? ` after ${live.retryCount} retries` : "")
                    + `: ${entry.message ?? "unknown"}`
                await saveTeamState(team)
                await checkTermination(ctx, team) // fail-fast if over tolerance / all errored
                // Re-drive the barrier: if this errored member was the LAST to reach
                // a terminal state, no further idle event will arrive to fire the
                // barrier. checkTermination above only fails fast; within tolerance it
                // is a no-op, so deliver survivors here.
                if (team.activeTask?.type === "parallel") {
                    await handleParallelIdle(ctx, team)
                }
            }
        } else if (entry?.type === "idle") {
            live.retryingSince = undefined
        }
    })
}

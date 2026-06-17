/**
 * The locked state machine (design §6). processIdle is the single entry point
 * driven by session.idle events (and the sweep timer's missed-idle
 * reconciliation). It MUST be called inside team.mutex.runExclusive — the
 * event-handler wrapper acquires the mutex, this function mutates state freely.
 *
 * Steps (per §6 processIdle):
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

import type { PluginContext } from "../context.js"
import type { Team } from "../state/store.js"
import { countUnreadMessages } from "../mailbox.js"
import { reapStaleClaims, listAllTasks } from "../tasks.js"
import { sendWakeHint } from "../wake-hint.js"
import { extractTextFromParts, sumMemberTokens, truncateOutput } from "../utils.js"
import type { ActiveTask, DecisionRecord, RuntimeMember } from "../types.js"
import { advanceToStage } from "./dispatch.js"
import { buildRoundSummary, deliverQueuedResultsToMaster, deliverSummaryToLeader } from "./summary.js"
import { checkTermination } from "./termination.js"

const NOTIFY_COOLDOWN_MS = 10_000
const NO_ISSUES_KEYWORDS = ["no issues", "no bugs found", "no improvements", "all clear"]

// --- helpers ---

/**
 * Identity validation (M3): which member may advance the state machine for this
 * task? parallel/delegate accept EVERY member's idle (all run concurrently);
 * pipeline/loop accept only the current stage's member. Returning the wrong
 * value here makes parallel degrade to serial or pipeline advance on stray idles.
 */
export function getExpectedMember(task: ActiveTask): string | null {
    if (task.type === "parallel") return null
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
    const match = rawText?.match(/<decision>\s*(\{[\s\S]*?\})\s*<\/decision>/)
    if (!match) return fail()
    try {
        const parsed = JSON.parse(match[1])
        return {
            round: 0,
            decision: parsed.decision === "done" ? "done" : "continue",
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

/** Discussion consensus: every participant must emit agreed consensus. */
export function allMembersAgree(responses: Record<string, string>): boolean {
    const texts = Object.values(responses)
    if (texts.length === 0) return false
    return texts.every(t => {
        const m = t.match(/<consensus>\s*(\{[\s\S]*?\})\s*<\/consensus>/)
        if (!m) return false
        try {
            return JSON.parse(m[1]).agreed === true
        } catch {
            return false
        }
    })
}

/**
 * Idempotent barrier check (NOT blocking). Called from handleParallelIdle on
 * each idle. If all participating members are idle, fires onBarrier exactly
 * once for this phase (the mutex guarantees the status flips are atomic, so a
 * later idle in the same phase sees members already "running" → no double-fire).
 */
async function waitForBarrier(
    team: Team,
    memberNames: string[],
    onBarrier: () => Promise<void>,
): Promise<void> {
    const allIdle = memberNames.every(name => {
        const m = team.members.find(x => x.name === name)
        return m?.status === "idle"
    })
    if (allIdle) {
        await onBarrier()
    }
    // else: return — the next idle re-checks. checkTermination + sweep enforce timeouts.
}

// --- main entry ---

export async function processIdle(
    ctx: PluginContext,
    team: Team,
    member: RuntimeMember,
    sessionID: string,
): Promise<void> {
    // Step 0: Master special case (B1) — synthetic member, never dispatches.
    if (member.isMaster) {
        await deliverQueuedResultsToMaster(ctx, team, sessionID)
        return
    }

    // Step 1: member is now idle.
    member.status = "idle"
    member.retryingSince = undefined // B2: idle clears retry tracking

    // Step 1.5: Role-setup barrier (B3) — first idle of an uninitialized member
    // marks it ready and returns WITHOUT capturing output or advancing.
    if (!member.initialized) {
        member.initialized = true
        const { saveTeamState } = await import("../state/store.js")
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
            const { saveTeamState } = await import("../state/store.js")
            await saveTeamState(team) // persist token tally; do NOT advance
            return
        }
    }

    // Step 4: Capture output (null-guarded + mode-aware). delegate does NOT use
    // responses[] (per-task results go to master via team_send_message; capturing
    // here would overwrite — #3).
    if (team.activeTask && team.activeTask.type !== "delegate") {
        let lastAssistant: { parts?: any } | undefined
        for (let i = messages.length - 1; i >= 0; i--) {
            if ((messages[i] as any)?.info?.role === "assistant") {
                lastAssistant = messages[i]
                break
            }
        }
        if (lastAssistant) {
            const text = extractTextFromParts(lastAssistant.parts)
            team.activeTask.responses[member.name] = truncateOutput(text)
        }
    }

    const { saveTeamState } = await import("../state/store.js")
    await saveTeamState(team)

    // Step 5: Unread messages — wake hint only (Transform hook injects content).
    const unread = await countUnreadMessages(team.directory, member.name)
    if (unread > 0) {
        await sendWakeHint(ctx, sessionID, unread)
        return
    }

    // Step 6: Dispatch by active-task type.
    if (!team.activeTask) return
    switch (team.activeTask.type) {
        case "parallel":
            await handleParallelIdle(ctx, team)
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

// --- per-mode handlers ---

async function handleParallelIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task) return
    const participants = team.members.filter(m => !m.isMaster).map(m => m.name)

    await waitForBarrier(team, participants, async () => {
        switch (task.mode) {
            case "isolated":
            case "collaborative": {
                // Single barrier: collect outputs → deliver to leader → done.
                await deliverSummaryToLeader(ctx, team, `parallel_${task.mode}_complete`)
                team.activeTask = undefined
                team.status = "idle"
                return
            }
            case "discussion": {
                task.consensusReached = allMembersAgree(task.responses)
                if (task.consensusReached) {
                    await deliverSummaryToLeader(ctx, team, "discussion_consensus")
                    team.activeTask = undefined
                    team.status = "idle"
                    return
                }
                if ((task.currentRound ?? 0) >= (task.maxRounds ?? 0)) {
                    // Reached here only when consensus was NOT detected → failed.
                    await deliverSummaryToLeader(ctx, team, "discussion_max_rounds")
                    team.activeTask = undefined
                    team.status = "failed"
                    return
                }
                // Next round: broadcast prior-round summary, reset to running.
                task.currentRound = (task.currentRound ?? 0) + 1
                const summary = buildRoundSummary(task.responses)
                for (const m of team.members.filter(x => !x.isMaster)) {
                    if (!m.sessionId) continue
                    await ctx.client.session.promptAsync({
                        path: { id: m.sessionId },
                        body: {
                            parts: [
                                {
                                    type: "text",
                                    text:
                                        `[Discussion Round ${task.currentRound}] Others said:\n${summary}\n\n`
                                        + `Respond, then emit <consensus>{"agreed": true|false}</consensus>.`,
                                    synthetic: true,
                                },
                            ],
                        },
                    })
                    m.status = "running"
                    m.turnCount++
                }
                return
            }
            default:
                return
        }
    })
}

async function handlePipelineIdle(ctx: PluginContext, team: Team, member: RuntimeMember): Promise<void> {
    const task = team.activeTask
    if (!task) return
    const stages = task.stages

    const currentStage = stages[task.currentStageIndex]
    if (!currentStage || currentStage.member !== member.name) return // stray idle

    currentStage.completed = true

    const nextIndex = stages.findIndex(s => !s.completed)
    if (nextIndex === -1) {
        // All stages complete → deliver summary to leader.
        await deliverSummaryToLeader(ctx, team, "pipeline_complete")
        team.activeTask = undefined
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
        query: { directory: nextMember.worktreePath ?? team.directory },
    })
    nextMember.status = "running"
    nextMember.turnCount++
}

async function handleLoopIdle(ctx: PluginContext, team: Team, member: RuntimeMember): Promise<void> {
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
        task.decisionParseFailures++
        if (task.decisionParseFailures >= 3) {
            await deliverSummaryToLeader(ctx, team, "loop_complete:decision_parse_failure")
            team.activeTask = undefined
            team.status = "failed"
            return
        }
    } else {
        task.decisionParseFailures = 0
    }

    if (decision.decision === "done") {
        await deliverSummaryToLeader(ctx, team, "loop_complete:decider_done")
        task.decisionHistory.push({ ...decision, round: task.currentRound ?? 0 })
        team.activeTask = undefined
        team.status = "idle"
        return
    }

    if ((task.currentRound ?? 0) >= (task.maxRounds ?? 0)) {
        await deliverSummaryToLeader(ctx, team, "loop_complete:max_rounds")
        team.activeTask = undefined
        team.status = "failed"
        return
    }

    if (allReadOnlyStagesReportNoIssues(task)) {
        await deliverSummaryToLeader(ctx, team, "loop_complete:no_issues")
        team.activeTask = undefined
        team.status = "idle"
        return
    }

    // Continue to next round.
    task.decisionHistory.push({ ...decision, round: task.currentRound ?? 0 })
    task.currentRound = (task.currentRound ?? 0) + 1
    task.currentStageIndex = 0
    for (const s of task.stages) s.completed = false
    await advanceToStage(ctx, team, stages[0])
}

async function handleDelegateIdle(ctx: PluginContext, team: Team, member: RuntimeMember): Promise<void> {
    const tasks = await listAllTasks(team.directory)
    const incomplete = tasks.filter(t => t.status !== "completed" && t.status !== "deleted")

    // All done?
    if (incomplete.length === 0) {
        await deliverSummaryToLeader(ctx, team, "delegate_complete")
        team.activeTask = undefined
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
        const allIdle = team.members.every(m => m.status === "idle" || !m.sessionId)
        if (allIdle) {
            await deliverSummaryToLeader(ctx, team, "delegate_deadlock")
            team.activeTask = undefined
            team.status = "failed"
            return
        }
        return // some members still running, wait
    }

    // Re-prompt this member — RATE-LIMITED (#10) to avoid claim-race busy-loop.
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
    await ctx.client.session.promptAsync({
        path: { id: member.sessionId },
        body: {
            parts: [
                {
                    type: "text",
                    text: `[Team Orchestrator] You have completed your task. ${claimable.length} task(s) available. Use team_task_list to check, team_task_update to claim, execute, then team_send_message to report to master. Repeat until no tasks remain.`,
                    synthetic: true,
                },
            ],
        },
    })
    member.status = "running"
    member.turnCount++
}

// re-export for the sweep timer / event handler to reuse the same reapers
export { reapStaleClaims }

const RETRY_ESCALATION_MS = 60_000

/**
 * B2: handle session.status events. session.idle carries no error signal and a
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
    const { resolveTeamMember } = await import("../utils.js")
    const member = await resolveTeamMember(ctx.storageRoot, sessionID)
    if (!member || member.isMaster) return

    const team = await loadTeamStateLive(ctx, member.teamName)
    await team.mutex.runExclusive(async () => {
        const live = team.members.find(m => m.name === member.name)
        if (!live) return
        const status = await ctx.client.session.status({ query: { directory: ctx.directory } })
        const entry = (status.data as Record<string, { type: string; message?: string }> | undefined)?.[sessionID]
        if (entry?.type === "retry") {
            live.retryingSince ??= Date.now()
            if (Date.now() - live.retryingSince > RETRY_ESCALATION_MS) {
                live.status = "errored"
                live.error = `sustained retry > ${RETRY_ESCALATION_MS}ms: ${entry.message ?? "unknown"}`
                const { saveTeamState } = await import("../state/store.js")
                await saveTeamState(team)
                await checkTermination(ctx, team) // member-error branch now fires
            }
        } else if (entry?.type === "idle") {
            live.retryingSince = undefined
        }
    })
}

// helper to avoid a top-level store import cycle in this already-heavy module
async function loadTeamStateLive(ctx: PluginContext, teamName: string) {
    const { loadTeamState } = await import("../state/store.js")
    return loadTeamState(ctx.storageRoot, teamName)
}

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
import { createTask, listAllTasks, updateTask } from "../state/tasks.js"
import { sendWakeHint } from "../messaging/wake-hint.js"
import { extractOutputFromParts, resolveTeamMember, sumMemberTokens, truncateOutput } from "../core/utils.js"
import { atomicWrite } from "../state/locks.js"
import { runMemberOutputPath } from "../state/paths.js"
import { logSwallowed } from "../core/log.js"
import type { ActiveTask, DecisionRecord, MemberState } from "../core/types.js"
import { advanceToStage, buildUpstreamContext, dispatchToMember } from "./dispatch.js"
import { buildRoundSummary, buildSummary, deliverQueuedResultsToMaster, deliverSummaryToLeader } from "./summary.js"
import { checkTermination } from "./termination.js"
import { recordEvent } from "./events.js"

const NOTIFY_COOLDOWN_MS = 10_000
// Structured, i18n-consistent "no issues" signal for loop read_only stages. A
// read_only stage emits <no_issues/> (or the Chinese <无问题/>) to declare clean.
// Replaces the old English keyword-substring heuristic, which both false-matched
// negated contexts ("there are no issues with X, but bugs in Y") and never fired
// for non-English agents.
const NO_ISSUES_TAG = /<(?:no_issues|无问题)\s*\/?>/

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

/**
 * Parse a router's <route>{...}</route> (or <路由>) decision block into the
 * selected branch names. Pure extraction — branch existence is validated in
 * handleRouteIdle. Returns parseFailed:true when no tag or no names are found.
 * Accepts branch/branches/target/targets aliases for LLM robustness.
 */
export function parseRouteDecision(
    rawText: string,
): { targets: string[]; rationale: string; parseFailed?: boolean } {
    const match = rawText?.match(/<(?:route|路由)>\s*(\{[\s\S]*\})\s*<\/(?:route|路由)>/)
    if (!match) return { targets: [], rationale: "", parseFailed: true }
    try {
        const p = JSON.parse(match[1]) as Record<string, unknown>
        const raw = p.branches ?? p.targets ?? p.branch ?? p.target
        const targets = (Array.isArray(raw) ? raw : raw != null ? [raw] : [])
            .filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
        if (targets.length === 0) return { targets: [], rationale: "", parseFailed: true }
        return {
            targets,
            rationale: typeof p.rationale === "string" ? p.rationale : "",
        }
    } catch {
        return { targets: [], rationale: "", parseFailed: true }
    }
}

/**
 * Parse an arbiter's <ruling>{...}</ruling> (or <裁决>) decision block into the
 * binding ruling and rationale. Accepts decision/ruling aliases; a non-empty
 * ruling is required, else parseFailed. Single ruling (no retry counting,
 * unlike loop's parseDecision).
 */
export function parseArbitrationDecision(
    rawText: string,
): { ruling: string; rationale: string; parseFailed?: boolean } {
    const match = rawText?.match(/<(?:ruling|裁决)>\s*(\{[\s\S]*\})\s*<\/(?:ruling|裁决)>/)
    if (!match) return { ruling: "", rationale: "", parseFailed: true }
    try {
        const p = JSON.parse(match[1]) as Record<string, unknown>
        const ruling = typeof p.decision === "string"
            ? p.decision
            : typeof p.ruling === "string" ? p.ruling : ""
        if (!ruling) return { ruling: "", rationale: "", parseFailed: true }
        return {
            ruling,
            rationale: typeof p.rationale === "string" ? p.rationale : "",
        }
    } catch {
        return { ruling: "", rationale: "", parseFailed: true }
    }
}

/**
 * Parse a member's <decompose>{...}</decompose> (or <分解>) block into the
 * proposed subtasks. Unlike parseDecision/parseRouteDecision, parseFailed is
 * NOT a failure signal: an absent tag means "solve directly" (a leaf). Only an
 * explicit tag with no valid subtasks yields parseFailed.
 */
export function parseDecompose(
    rawText: string,
): { subtasks: { subject: string; description: string }[]; parseFailed?: boolean } {
    const match = rawText?.match(/<(?:decompose|分解)>\s*(\{[\s\S]*\})\s*<\/(?:decompose|分解)>/)
    if (!match) return { subtasks: [] }
    try {
        const p = JSON.parse(match[1]) as { subtasks?: unknown }
        const arr = Array.isArray(p.subtasks) ? p.subtasks : []
        const subtasks: { subject: string; description: string }[] = []
        for (const item of arr) {
            if (
                typeof item === "object" && item !== null
                && "subject" in item && typeof item.subject === "string" && item.subject.length > 0
                && "description" in item && typeof item.description === "string" && item.description.length > 0
            ) {
                subtasks.push({ subject: item.subject, description: item.description })
            }
        }
        if (subtasks.length === 0) return { subtasks: [], parseFailed: true }
        return { subtasks }
    } catch {
        return { subtasks: [], parseFailed: true }
    }
}

/** Loop exit condition 2: every read_only stage emitted a <no_issues/> tag. */
export function allReadOnlyStagesReportNoIssues(task: ActiveTask): boolean {
    const roStages = task.stages.filter(s => s.action === "read_only")
    if (roStages.length === 0) return false
    return roStages.every(s => NO_ISSUES_TAG.test(task.responses[s.member] ?? ""))
}

/** Consensus: every participant must emit agreed consensus. */
export function allMembersAgree(responses: Record<string, string>): boolean {
    const texts = Object.values(responses)
    if (texts.length === 0) return false
    return texts.every(t => {
        // Bilingual tag, aligned with parseDecision's <(?:decision|决策)> so a
        // non-English agent emitting <共识> is recognized.
        const m = t.match(/<(?:consensus|共识)>\s*(\{[\s\S]*\})\s*<\/(?:consensus|共识)>/)
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
        case "route":
            await handleRouteIdle(ctx, team)
            break
        case "arbitrate":
            await handleArbitrateIdle(ctx, team)
            break
        case "recurse":
            await handleRecurseIdle(ctx, team, member)
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
    recordEvent(team, { timestamp: Date.now(), kind: "signoff", detail: task.signoffPolicy })

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
        await dispatchToMember(ctx, decider, reviewPrompt, decider.worktreePath ?? ctx.directory, team)
    } else if (task.signoffPolicy === "peer-quorum") {
        // Dispatch to all non-master members with a session.
        const reviewers = team.members.filter(m => !m.isMaster && m.sessionId)
        if (reviewers.length === 0) {
            task.signoffStage = false
            return false
        }
        for (const m of reviewers) {
            await dispatchToMember(ctx, m, reviewPrompt, m.worktreePath ?? ctx.directory, team)
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

/**
 * Real map-reduce (#4). When reducePolicy != summarize AND a live reducerMember
 * is named AND there is >1 candidate, dispatch that member to combine all member
 * outputs into ONE result (captured into reducedResult by handleReduceIdle).
 * Returns true if a reducer was dispatched (caller must NOT deliver); false if no
 * real reduce is needed (caller falls back to the legacy header summary).
 * Mirrors maybeTriggerSignoff.
 */
export async function maybeTriggerReduce(ctx: PluginContext, team: Team): Promise<boolean> {
    const task = team.activeTask
    if (!task || task.type !== "parallel") return false
    if (!task.reducePolicy || task.reducePolicy === "summarize") return false
    if (task.reduceStage) return true                          // already reducing
    if (Object.keys(task.responses).length <= 1) return false  // N<=1: nothing to reduce
    const reducer = team.members.find(m => m.name === task.reducerMember && !m.isMaster)
    // Require a LIVE, non-errored reducer. Dispatching to an errored member would
    // flip it back to running (violating the errored-is-terminal invariant) and
    // stall the reduce stage. No live reducer → fall back to legacy delivery.
    if (!reducer?.sessionId || reducer.status === "errored") return false

    task.reduceStage = true
    // Reuse the existing [Reduce policy: X] header + candidates as the reducer
    // prompt (reducedResult is still unset here, so buildSummary returns the
    // guidance block, not the verbatim result).
    const body = await buildSummary(team, task, "pending_reduce")
    const prompt =
        `[Reduce task] You are the reducer for a parallel run. Combine the candidate `
        + `outputs below into ONE final result per the policy. Output ONLY the final `
        + `result, with no preamble.\n\n${body}`
    await dispatchToMember(ctx, reducer, prompt, reducer.worktreePath ?? ctx.directory, team)
    await saveTeamState(team)
    return true
}

/**
 * Handle the reducer's idle during the reduce stage. Captures its output as
 * reducedResult (delivered verbatim by buildSummary), then runs the post-reduce
 * tail: signoff reviews the reduced result, else deliver. Mirrors handleSignoffIdle.
 */
async function handleReduceIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    const task = team.activeTask
    if (!task?.reduceStage) return
    if (member.name !== task.reducerMember) return  // ignore stray non-reducer idle

    task.reducedResult = task.responses[member.name] ?? ""
    task.reduceStage = false
    // Post-reduce tail: signoff reviews the single reduced artifact, else deliver.
    if (await maybeTriggerSignoff(ctx, team)) return
    await deliverSummaryToLeader(ctx, team, `parallel_${task.mode}_reduced:${task.reducePolicy}`)
    clearActiveTask(team)
    team.status = "idle"
}

export async function handleParallelIdle(ctx: PluginContext, team: Team): Promise<void> {
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
        // Reduce (real map-reduce) BEFORE signoff: signoff then reviews the single
        // reduced artifact, not the N raw outputs. Re-entry while reduceStage is
        // still set means the reducer reached a terminal state without idling
        // (errored) — fall back to non-reduced delivery (reducedResult stays unset)
        // so the successful mappers' work is not wasted and the run cannot hang.
        if (task.reduceStage) {
            task.reduceStage = false
        } else if (await maybeTriggerReduce(ctx, team)) {
            return  // reducer dispatched; handleReduceIdle finishes the run
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

export async function handleConsensusIdle(ctx: PluginContext, team: Team): Promise<void> {
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
        recordEvent(team, { timestamp: Date.now(), kind: "round", round: task.currentRound })
        const summary = buildRoundSummary(task.responses)
        const roundText =
            `[Consensus Round ${task.currentRound}] Others said:\n${summary}\n\n`
            + `Respond, then emit <consensus>{"agreed": true|false}</consensus> (or <共识>{"agreed": ...}</共识>).`
        for (const m of team.members.filter(x => !x.isMaster)) {
            await dispatchToMember(ctx, m, roundText, m.worktreePath ?? ctx.directory, team)
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

    const upstream = buildUpstreamContext(stages, task.responses, nextIndex)
    const fullTask = upstream
        ? `${upstream}\n\n[Your task]\n${nextStage.task}`
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
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "stage_advanced",
        member: nextMember.name,
        stage: nextIndex,
    })
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
    recordEvent(team, { timestamp: Date.now(), kind: "round", round: task.currentRound })
    task.currentStageIndex = 0
    for (const s of task.stages) s.completed = false
    const feedback =
        `[Round ${task.currentRound} — decider feedback]\n${decision.rationale}`
        + (decision.nextActions.length > 0
            ? `\nNext actions:\n${decision.nextActions.map(a => `- ${a}`).join("\n")}`
            : "")
    await advanceToStage(ctx, team, stages[0], feedback)
}

/**
 * Shared delegate-style termination tail: scan the task list, deliver on
 * all-complete, fail on deadlock, else rate-limit re-prompt the idling member
 * toward claimable tasks. Used by both delegate (label "delegate") and recurse
 * (label "recurse"); the reason prefix and re-prompt text differ by caller.
 */
async function runDelegateStyleTail(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
    label: string,
    buildReprompt: (claimableCount: number) => string,
): Promise<void> {
    const tasks = await listAllTasks(team.directory)
    const incomplete = tasks.filter(t => t.status !== "completed" && t.status !== "deleted")

    if (incomplete.length === 0) {
        if (await maybeTriggerSignoff(ctx, team)) {
            return  // signoff in progress
        }
        await deliverSummaryToLeader(ctx, team, `${label}_complete`)
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
            await deliverSummaryToLeader(ctx, team, `${label}_deadlock`)
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
    await dispatchToMember(ctx, member, buildReprompt(claimable.length), member.worktreePath ?? ctx.directory, team)
}

async function handleDelegateIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    await runDelegateStyleTail(ctx, team, member, "delegate", n =>
        `[Team Orchestrator] You have completed your task. ${n} task(s) available. `
        + `Use team_task_list to check, team_task_update to claim, execute, then team_send_message `
        + `to report to master. Repeat until no tasks remain.`)
}

/**
 * Build the recursive-decomposition contract prompt: claim a task, then either
 * solve it directly or emit a <decompose> block; aggregate completed sub-tasks
 * instead of re-decomposing. Members must NOT call team_task_update completed —
 * the orchestrator finalizes their task on idle (eliminates finalize races).
 */
export function buildRecursePrompt(): string {
    return (
        `[Recursive task] Claim an available task (team_task_update status="claimed"), then read it (team_task_get).\n`
        + `Then EITHER:\n`
        + ` • Solve it directly — produce the full result as your final message; OR\n`
        + ` • If too large to solve in one step, emit exactly one:\n`
        + `   <decompose>{"subtasks":[{"subject":"...","description":"..."}]}</decompose>  (Chinese <分解> accepted)\n`
        + `If the task you claimed has completed sub-tasks (shown under "Blocked by"), DO NOT decompose —\n`
        + `read each sub-task's result via team_task_get and synthesize them into this task's result.\n`
        + `Do NOT call team_task_update completed — the orchestrator finalizes your task when you go idle.`
    )
}

/**
 * Hierarchical recursive decomposition (recurse mode). When a member idles,
 * the orchestrator inspects that member's claimed task and either:
 *   • branch — splits it into subtasks (depth+1) and re-queues the task as a
 *     pending aggregator blocked by those subtasks (re-claim aggregation); or
 *   • leaf — finalizes the task as completed with the member's output as result.
 * Aggregators (blockedBy non-empty), depth/width-capped tasks, and no-tag
 * responses are always leaves — preventing infinite recursion/oscillation.
 * The tail reuses delegate's task-pool termination engine.
 */
async function handleRecurseIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    const task = team.activeTask
    if (!task) return

    // Inspect the member's claimed/in-progress task and finalize it.
    const tasks = await listAllTasks(team.directory)
    const T = tasks.find(
        t => t.owner === member.name && (t.status === "claimed" || t.status === "in_progress"),
    )
    if (T) {
        const output = task.responses[member.name] ?? ""
        const depth = T.depth ?? 0
        const dec = parseDecompose(output)
        const maxDepth = task.maxDepth ?? 3
        const maxSubtasks = task.maxSubtasks ?? 5
        const canDecompose =
            !dec.parseFailed
            && dec.subtasks.length > 0
            && depth < maxDepth
            && T.blockedBy.length === 0
            && dec.subtasks.length <= maxSubtasks
        if (canDecompose) {
            // Branch: create subtasks (depth+1), re-queue T as their aggregator.
            const ids: string[] = []
            for (const s of dec.subtasks) {
                const child = await createTask(team.directory, {
                    subject: s.subject,
                    description: s.description,
                    depth: depth + 1,
                })
                ids.push(child.id)
            }
            await updateTask(team.directory, T.id, {
                status: "pending",
                owner: undefined,
                blockedBy: ids,
            })
            recordEvent(team, {
                timestamp: Date.now(),
                kind: "decomposed",
                member: member.name,
                detail: `${T.subject} -> ${ids.length} @d${depth + 1}`,
            })
        } else {
            // Leaf (or capped/aggregator): finalize with the member's output.
            await updateTask(team.directory, T.id, { status: "completed", result: output })
        }
    }

    // Shared delegate-style tail: all-complete / deadlock / re-prompt.
    await runDelegateStyleTail(ctx, team, member, "recurse", () => buildRecursePrompt())
}

/**
 * Content-Based Routing (route mode). Two-phase orchestration:
 *   Phase A (router): a single member inspects the input and emits a
 *     <route>{...} decision naming the branch(es) to dispatch to. Only the
 *     router's idle advances the state machine (getExpectedMember gate).
 *   Phase B (targets): the selected branches' members run in parallel; their
 *     barrier converges to delivery (mirrors parallel, including failure
 *     isolation and optional signoff).
 *
 * No default route: a parse failure or zero matching branches fails the run
 * with a reason containing "decision_parse_failure" so runStatusFromReason
 * classifies it as failed.
 */
export async function handleRouteIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task) return

    // Phase A: router phase (routeStage not yet set).
    if (!task.routeStage) {
        const decision = parseRouteDecision(task.responses[task.routerMember ?? ""] ?? "")
        const branches = task.routeBranches ?? []
        const selected = branches.filter(b => decision.targets.includes(b.name))

        if (decision.parseFailed || selected.length === 0) {
            // No default route: unmatched input fails the run.
            await deliverSummaryToLeader(ctx, team, "route_complete:decision_parse_failure")
            clearActiveTask(team)
            team.status = "failed"
            return
        }

        // Transition to Phase B: resolve targets, fan out.
        task.routeStage = true
        task.routeTargets = selected.map(b => b.member)
        task.routeDecisionRationale = decision.rationale
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "routed",
            member: task.routerMember,
            detail: `targets: ${task.routeTargets.join(",")}`,
        })
        for (const b of selected) {
            const m = team.members.find(x => x.name === b.member && !x.isMaster)
            if (!m?.sessionId) continue
            const text = b.task ?? task.task ?? ""
            await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory, team)
        }
        await saveTeamState(team)
        return
    }

    // Phase B: target barrier (any selected target's idle re-checks readiness).
    const targets = task.routeTargets ?? []
    await waitForBarrier(team, targets, async () => {
        // checkTermination owns fail-fast for route errors (route is excluded
        // from termination's concurrent set, so tolerance is 0); by the time the
        // barrier fires, all targets are idle.
        if (await maybeTriggerSignoff(ctx, team)) {
            return // signoff in progress
        }
        await deliverSummaryToLeader(ctx, team, "route_complete")
        clearActiveTask(team)
        team.status = "idle"
    })
}

/**
 * Build a debater's prompt for the current debate round. Round 1 states the
 * dispute subject; later rounds rebut other debaters' positions (drawn from
 * the latest captured responses via buildRoundSummary).
 */
export function buildDebatePrompt(task: ActiveTask): string {
    const round = task.currentRound ?? 1
    if (round <= 1) {
        return (
            `[Arbitration debate — Round 1] Subject:\n${task.task ?? ""}\n\n`
            + `State your position with reasoning. An arbiter will weigh all positions and issue a binding ruling.`
        )
    }
    const positions = buildRoundSummary(task.responses)
    return (
        `[Arbitration debate — Round ${round}] Other positions:\n${positions}\n\n`
        + `Rebut or refine your position.`
    )
}

/**
 * Build the arbiter's ruling prompt: the dispute plus every debater's final
 * position, requesting exactly one <ruling>{...} decision.
 */
export function buildArbiterPrompt(task: ActiveTask): string {
    const positions = (task.disputants ?? [])
        .map(name => `### ${name}\n${truncateOutput(task.responses[name] ?? "")}`)
        .join("\n\n")
    return (
        `[Arbitration ruling] Dispute:\n${task.task ?? ""}\n\n`
        + `Debater positions:\n${positions}\n\n`
        + `Weigh impartially and issue a BINDING ruling. Emit exactly one:\n`
        + `<ruling>{"decision":"...","rationale":"..."}</ruling> (Chinese <裁决> also accepted)`
    )
}

/**
 * Arbitrate (authoritative ruling). Two-phase orchestration:
 *   Phase A (debate): the debaters run in parallel over up to maxRounds rounds,
 *     each round broadcasting prior positions (consensus skeleton). Any
 *     debater's idle re-checks the barrier; it advances only when all are idle.
 *   Phase B (ruling): once rounds are exhausted, the arbiter is dispatched with
 *     all positions and emits a binding <ruling>; its idle delivers the result
 *     (loop decider pattern). Only the arbiter advances Phase B.
 *
 * max_rounds is the normal debate length (NOT a failure condition, unlike
 * consensus). Failures: arbiter unavailable, or unparseable ruling.
 */
export async function handleArbitrateIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task) return
    const disputants = task.disputants ?? []

    // Phase A: debate (arbitrationStage not yet set).
    if (!task.arbitrationStage) {
        await waitForBarrier(team, disputants, async () => {
            if ((task.currentRound ?? 1) >= (task.maxRounds ?? 1)) {
                // Debate exhausted -> transition to the ruling phase.
                task.arbitrationStage = true
                const arbiter = team.members.find(
                    m => m.name === task.arbiterMember && !m.isMaster,
                )
                if (!arbiter?.sessionId) {
                    // Arbiter unavailable: cannot rule -> fail.
                    await deliverSummaryToLeader(ctx, team, "arbitrate_complete:arbiter_unavailable")
                    clearActiveTask(team)
                    team.status = "failed"
                    return
                }
                await dispatchToMember(
                    ctx,
                    arbiter,
                    buildArbiterPrompt(task),
                    arbiter.worktreePath ?? ctx.directory,
                    team,
                )
                await saveTeamState(team)
                return
            }
            // Next debate round: broadcast prior positions, re-dispatch debaters.
            task.currentRound = (task.currentRound ?? 1) + 1
            recordEvent(team, { timestamp: Date.now(), kind: "round", round: task.currentRound })
            for (const name of disputants) {
                const m = team.members.find(x => x.name === name)
                if (!m?.sessionId) continue
                await dispatchToMember(ctx, m, buildDebatePrompt(task), m.worktreePath ?? ctx.directory, team)
            }
        })
        return
    }

    // Phase B: ruling (only the arbiter's idle reaches here).
    const r = parseArbitrationDecision(task.responses[task.arbiterMember ?? ""] ?? "")
    if (r.parseFailed) {
        await deliverSummaryToLeader(ctx, team, "arbitrate_complete:decision_parse_failure")
        clearActiveTask(team)
        team.status = "failed"
        return
    }
    task.arbitrationRuling = r.ruling
    task.arbitrationRationale = r.rationale
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "arbitrated",
        member: task.arbiterMember,
        detail: truncateOutput(r.ruling, 200),
    })
    if (await maybeTriggerSignoff(ctx, team)) {
        return // signoff in progress
    }
    await deliverSummaryToLeader(ctx, team, "arbitrate_complete:ruled")
    clearActiveTask(team)
    team.status = "idle"
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
                // Re-drive the barrier: if this errored member was the LAST to reach
                // a terminal state, no further idle event will arrive to fire the
                // barrier. checkTermination above only fails fast; within tolerance it
                // is a no-op, so deliver survivors here.
                if (team.activeTask?.type === "parallel") {
                    await handleParallelIdle(ctx, team)
                }
                // Persist the terminal transition: checkTermination / the barrier
                // re-drive may have cleared activeTask and flipped team.status, but
                // the only save above predates them. Without this, state.json stays
                // "busy" on disk after the run actually finished here — staling the
                // sidebar and mis-reconciling a completed run as failed on restart.
                // NOTE: delegate's tolerant last-errored case is NOT re-driven here
                // (handleDelegateIdle needs an idle member); it is reconciled by the
                // sweep timer instead — a known, wall-clock-bounded limitation.
                await saveTeamState(team)
            }
        } else if (entry?.type === "idle") {
            live.retryingSince = undefined
            await saveTeamState(team)
        }
    })
}

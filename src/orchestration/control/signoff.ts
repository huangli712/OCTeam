/**
 * Signoff and reduce stage handling (Phase B decider / Phase D peer-quorum, and
 * real map-reduce #4). Both stages share the same shape: a special stage flag
 * is set on the active task, a designated member (decider / reducer / each
 * reviewer) is dispatched, and the matching handleXxxIdle captures the response
 * and either delivers the final summary or waits for more responses.
 *
 * maybeTriggerSignoff / maybeTriggerReduce are called from the per-mode
 * handlers (parallel, pipeline, loop, tollgate, route, arbitrate) before they
 * would deliver — returning true means "stage dispatched, caller must NOT
 * deliver". handleSignoffIdle / handleReduceIdle are dispatched to by
 * processIdle when the corresponding stage flag is set (they take priority
 * over the per-mode switch).
 */

import type { PluginContext } from "../../core/context.js"
import { logEvent } from "../../core/log.js"
import { type Team, saveTeamState } from "../../state/store.js"
import type { MemberState } from "../../core/types.js"
import { dispatchToMember } from "./dispatch.js"
import { buildSummary } from "../records/summary.js"
import { finishRun } from "./completion.js"
import { recordEvent } from "../records/events.js"
import { isQuorumReached, parseSignoff } from "../protocol/decisions.js"

// --- shared prompt builders (live + crash-recovery paths must use identical wording) ---

/**
 * Build the [Reduce task] prompt. Shared by maybeTriggerReduce (live path) and
 * resumeDispatch (crash-recovery) so a one-sided edit cannot make a resumed
 * run send different instructions than the original.
 */
export function buildReducePrompt(body: string): string {
    return `[Reduce task] You are the reducer for a parallel run. Combine the candidate `
        + `outputs below into ONE final result per the policy. Output ONLY the final `
        + `result, with no preamble.\n\n${body}`
}

/**
 * Build the [Signoff review] prompt. Shared by maybeTriggerSignoff (live path)
 * and resumeDispatch (crash-recovery) for the same drift-prevention reason as
 * buildReducePrompt.
 */
export function buildSignoffReviewPrompt(summary: string): string {
    return `[Signoff review] Review the following workflow output. `
        + `If it meets quality standards, emit <signoff>{"approved": true, "rationale": "..."}</signoff>. `
        + `If not, emit <signoff>{"approved": false, "rationale": "specific issues..."}</signoff>.\n\n${summary}`
}

// --- signoff helpers (Phase B: decider mode; Phase D adds peer-quorum) ---

/**
 * Check if a signoff stage is required and trigger it if so. Returns true if
 * signoff was triggered (caller must NOT deliver summary); false if no signoff
 * needed (caller proceeds with deliverSummaryToLeader).
 */
export async function maybeTriggerSignoff(ctx: PluginContext, team: Team): Promise<boolean> {
    const task = team.activeTask
    if (!task) return false
    if (!task.signoffPolicy || task.signoffPolicy === "none") return false
    if (task.signoffStage) return true  // already in signoff

    task.signoffStage = true
    task.signoffApprovals = {}
    recordEvent(team, { timestamp: Date.now(), kind: "signoff", detail: task.signoffPolicy })

    const summary = await buildSummary(team, task, "pending_signoff")
    const reviewPrompt = buildSignoffReviewPrompt(summary)

    if (task.signoffPolicy === "decider") {
        const decider = team.members.find(m => m.name === task.signoffDecider && !m.isMaster)
        // Require a LIVE, non-errored decider (mirrors maybeTriggerReduce guard):
        // dispatching to an errored member would flip it back to running, violating
        // the errored-is-terminal invariant.
        if (!decider?.sessionId || decider.status === "errored") {
            // decider unavailable, fall back to direct delivery
            task.signoffStage = false
            return false
        }
        await dispatchToMember(ctx, decider, reviewPrompt, decider.worktreePath ?? ctx.directory, team)
    } else if (task.signoffPolicy === "peer-quorum") {
        // Dispatch to all non-master members with a session. Exclude errored
        // members: they are terminal and must not be revived by a signoff
        // dispatch (mirrors maybeTriggerReduce's errored guard).
        const reviewers = team.members.filter(m => !m.isMaster && m.sessionId && m.status !== "errored")
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
export async function handleSignoffIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
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
        await finishRun(ctx, team, reason, "idle")
    } else if (task.signoffPolicy === "peer-quorum") {
        // Wait for all reviewers to respond, then check quorum. Must use the
        // SAME errored-exclusion as the dispatch site, else the denominator
        // counts a member who will never respond, stalling to wall-clock.
        const reviewers = team.members.filter(m => !m.isMaster && m.sessionId && m.status !== "errored").map(m => m.name)
        const { allResponded, reached } = isQuorumReached(
            task.signoffApprovals ?? {},
            reviewers.length,
            task.signoffQuorum ?? 0.5,
        )
        if (!allResponded) return  // wait for more

        const reason = reached ? "signoff_quorum_reached" : "signoff_quorum_not_reached"
        await finishRun(ctx, team, reason, "idle")
    }
}

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
    const prompt = buildReducePrompt(body)
    await dispatchToMember(ctx, reducer, prompt, reducer.worktreePath ?? ctx.directory, team)
    await saveTeamState(team)
    return true
}

/**
 * Handle the reducer's idle during the reduce stage. Captures its output as
 * reducedResult (delivered verbatim by buildSummary), then runs the post-reduce
 * tail: signoff reviews the reduced result, else deliver. Mirrors handleSignoffIdle.
 */
export async function handleReduceIdle(ctx: PluginContext, team: Team, member: MemberState): Promise<void> {
    const task = team.activeTask
    if (!task?.reduceStage) return
    if (member.name !== task.reducerMember) return  // ignore stray non-reducer idle

    task.reducedResult = task.responses[member.name] ?? ""
    task.reduceStage = false
    // Post-reduce tail: signoff reviews the single reduced artifact, else deliver.
    if (await maybeTriggerSignoff(ctx, team)) return
    await finishRun(ctx, team, `parallel_${task.mode}_reduced:${task.reducePolicy}`, "idle")
}

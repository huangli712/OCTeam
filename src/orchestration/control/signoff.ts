/**
 * Post-completion signoff state machine for decider and peer-quorum policies.
 *
 * maybeTriggerSignoff dispatches reviewers before a mode completes;
 * handleSignoffIdle records each verdict and completes the run when policy
 * conditions are satisfied.
 */

import type { PluginContext } from "../../core/context.js"
import { logEvent } from "../../core/log.js"
import type { MemberState } from "../../core/types.js"
import { type Team, saveTeamState } from "../../state/store.js"
import { isQuorumReached, parseSignoff } from "../protocol/decisions.js"
import { recordEvent } from "../records/events.js"
import { buildSummary } from "../records/summary.js"
import { finishRun } from "./completion.js"
import { dispatchToMember } from "./dispatch.js"
import { findMember } from "../../tools/support.js"

/** Build the structured verdict contract shared by live and resumed reviews. */
export function buildSignoffReviewPrompt(summary: string): string {
    return `[Signoff review]\n` 
        + `Review the following workflow output. \n`
        + `Write the <signoff> tag directly in your response text. Do NOT send it via team_send_message.\n`
        + `If it meets quality standards, emit <signoff>{"approved": true, "rationale": "..."}</signoff>. \n`
        + `If not, emit <signoff>{"approved": false, "rationale": "specific issues..."}</signoff>.\n${summary}`
}

/**
 * Enter signoff when configured. Returns true when the caller must stop normal
 * completion because signoff is already active or reviewers were dispatched.
 *
 * Reviewer availability is resolved per policy BEFORE any signoff state is
 * committed, so a guard failure leaves no stale event in the timeline and
 * resets signoffStage to false for the caller's direct-delivery fallback.
 */
export async function maybeTriggerSignoff(ctx: PluginContext, team: Team): Promise<boolean> {
    const task = team.activeTask
    if (!task) return false
    if (!task.signoffPolicy || task.signoffPolicy === "none") return false
    if (task.signoffStage) return true

    const summary = await buildSummary(team, task, "pending_signoff")
    const reviewPrompt = buildSignoffReviewPrompt(summary)

    // Resolve eligible reviewers per policy before recording the signoff event,
    // so a guard failure does not leave a stale "signoff" entry in the timeline.
    let reviewers: MemberState[]
    if (task.signoffPolicy === "decider") {
        const decider = findMember(team, task.signoffDecider ?? "")
        if (!decider?.sessionId || decider.status === "errored") {
            task.signoffStage = false
            return false
        }
        reviewers = [decider]
    } else {
        reviewers = team.members.filter(member =>
            !member.isMaster && member.sessionId && member.status !== "errored"
        )
        if (reviewers.length === 0) {
            task.signoffStage = false
            return false
        }
    }

    // Commit the signoff stage only once reviewers are confirmed available.
    task.signoffStage = true
    task.signoffApprovals = {}
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "signoff",
        detail: task.signoffPolicy,
    })
    // Persist BEFORE dispatching reviewers so a crash between save and
    // dispatch does not leave reviewers prompted without signoffStage
    // persisted. On resume, signoffStage=true ensures reviewer responses
    // are routed to handleSignoffIdle instead of being treated as stray.
    //
    // HIGH-A: rollback the in-memory signoffStage on save failure. Pre-fix
    // code let saveTeamState throw with signoffStage=true still set in memory,
    // stranding the team in a "signoff paused but reviewers never dispatched"
    // state — the next idle would route to handleSignoffIdle on a stage that
    // had no reviewers in flight.
    try {
        await saveTeamState(team)
    } catch (err) {
        task.signoffStage = false
        task.signoffApprovals = undefined
        throw err
    }
    for (const reviewer of reviewers) {
        await dispatchToMember(
            ctx,
            reviewer,
            reviewPrompt,
            reviewer.worktreePath ?? ctx.directory,
            team,
        )
    }

    return true
}

/** Capture one reviewer verdict and complete the signoff policy when ready. */
export async function handleSignoffIdle(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
): Promise<void> {
    const task = team.activeTask
    if (!task?.signoffStage) return

    // Decider policy: only the configured decider may advance the signoff
    // verdict. A non-decider member idling during signoffStage (e.g. a
    // late-finishing coder in delegate mode) must NOT be treated as the
    // signoff decision — doing so terminates the run prematurely with a
    // spurious signoff_rejected before the decider has even idled.
    if (task.signoffPolicy === "decider" && member.name !== task.signoffDecider) {
        return
    }

    const memberOutput = task.signoffRawOutputs?.[member.name] ?? task.responses[member.name] ?? ""
    const signoff = parseSignoff(memberOutput)
    if (!signoff) {
        logEvent(ctx, "debug", "signoff tag parse failed", {
            team: team.teamName,
            member: member.name,
        })
    }
    // signoffApprovals is initialized to {} in maybeTriggerSignoff before
    // signoffStage is set. Guard against undefined for robustness.
    if (!task.signoffApprovals) task.signoffApprovals = {}
    task.signoffApprovals[member.name] = signoff?.approved === true

    if (task.signoffPolicy === "decider") {
        const reason = signoff?.approved === true ? "signoff_approved" : "signoff_rejected"
        await finishRun(ctx, team, reason, "idle")
    } else if (task.signoffPolicy === "peer-quorum") {
        // Reviewer list: use current live members. An errored reviewer
        // is excluded from the denominator, but their dispatch already
        // happened — the barrier waits only for non-errored reviewers.
        // This is the same set used by maybeTriggerSignoff at dispatch time.
        const reviewers = team.members
            .filter(member => !member.isMaster && member.sessionId && member.status !== "errored")
            .map(member => member.name)
        const reviewerSet = new Set(reviewers)
        // Filter approvals to only include current non-errored reviewers so
        // that members who errored AFTER responding do not inflate the
        // response count or approval count beyond the active set.
        const activeApprovals: Record<string, boolean> = {}
        for (const [name, approved] of Object.entries(task.signoffApprovals ?? {})) {
            if (reviewerSet.has(name)) activeApprovals[name] = approved
        }
        const { allResponded, reached } = isQuorumReached(
            activeApprovals,
            reviewers.length,
            task.signoffQuorum ?? 0.5,
        )
        if (!allResponded) return
        const reason = reached ? "signoff_quorum_reached" : "signoff_quorum_not_reached"
        await finishRun(ctx, team, reason, "idle")
    }
}

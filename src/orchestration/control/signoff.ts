/**
 * Post-completion signoff state machine for decider and peer-quorum policies.
 *
 * maybeTriggerSignoff dispatches reviewers before a mode completes;
 * handleSignoffIdle records each verdict and completes the run when policy
 * conditions are satisfied.
 */

import type { PluginContext } from "../../core/context.js"
import { logEvent, logSwallowed } from "../../core/log.js"
import type { MemberState } from "../../core/types.js"
import { type Team, saveTeamStateBounded } from "../../state/store.js"
import { isQuorumReached, parseSignoff } from "../protocol/decisions.js"
import { recordEvent } from "../records/events.js"
import { buildSummary } from "../records/summary.js"
import { finishRun } from "./completion.js"
import { dispatchToMember } from "./dispatch.js"
import { findMember } from "../../tools/support.js"

const MAX_SIGNOFF_PARSE_FAILURES = 3

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
    //
    // M9 fix: recordEvent was fire-and-forget BEFORE save. If save failed,
    // the timeline showed a signoff entry that was rolled back. Now record
    // the event only AFTER successful save so the timeline is consistent.
    try {
        await saveTeamStateBounded(team)
    } catch (err) {
        task.signoffStage = false
        task.signoffApprovals = undefined
        throw err
    }
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "signoff",
        detail: task.signoffPolicy,
    })
    // G: track dispatch failures so partial-dispatch does not leave the run
    // stalled. Pre-fix code had no error handling in the loop; if reviewer
    // dispatch threw partway, already-dispatched reviewers were prompted but
    // the run stalled waiting for never-dispatched ones (peer-quorum) or
    // failed with a misleading error (decider).
    const dispatchFailures: string[] = []
    const dispatchedReviewers: string[] = []
    for (const reviewer of reviewers) {
        // Do NOT pre-write a false sentinel for pending reviewers — false is
        // a valid rejection vote and isQuorumReached counts map keys as
        // "responded". A pending reviewer with false in the map would be
        // tallied as rejected before they've even seen the prompt. Instead,
        // just dispatch; the reviewer's name appears in signoffApprovals only
        // when they actually respond via handleSignoffIdle.
        try {
            await dispatchToMember(
                ctx,
                reviewer,
                reviewPrompt,
                reviewer.worktreePath ?? ctx.directory,
                team,
            )
            dispatchedReviewers.push(reviewer.name)
        } catch (err) {
            // Isolate per-reviewer dispatch failures. For decider policy this
            // is fatal (the single reviewer never got the prompt); for
            // peer-quorum it's a soft failure (remaining reviewers may still
            // reach quorum).
            dispatchFailures.push(reviewer.name)
            logSwallowed(ctx, "signoff: reviewer dispatch failed", err, {
                team: team.teamName, reviewer: reviewer.name, policy: task.signoffPolicy,
            })
            if (task.signoffPolicy === "decider") {
                // Decider dispatch failed — the run cannot complete. Rollback
                // the signoffStage so finishRun(failed) is the explicit outcome.
                task.signoffStage = false
                task.signoffApprovals = undefined
                task.signoffReviewers = undefined
                try {
                    await saveTeamStateBounded(team)
                } catch (rollbackErr) {
                    logSwallowed(ctx, "signoff: rollback save failed after decider dispatch failure", rollbackErr, { team: team.teamName })
                }
                throw err
            }
        }
    }
    // peer-quorum with all-failures: no reviewer was prompted, so the run
    // would stall. Rollback the stage and fail the run.
    if (dispatchFailures.length === reviewers.length) {
        task.signoffStage = false
        task.signoffApprovals = undefined
        task.signoffReviewers = undefined
        try {
            await saveTeamStateBounded(team)
        } catch (rollbackErr) {
            logSwallowed(ctx, "signoff: rollback save failed after all-reviewers dispatch failure", rollbackErr, { team: team.teamName })
        }
        throw new Error(`signoff: all ${reviewers.length} reviewer dispatch(es) failed: ${dispatchFailures.join(", ")}`)
    }

    task.signoffReviewers = dispatchedReviewers
    await saveTeamStateBounded(team)

    return true
}

/** Settle peer-quorum signoff against the successfully dispatched live roster. */
export async function evaluateSignoffQuorum(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task?.signoffStage || task.signoffPolicy !== "peer-quorum") return
    const reviewerRoster = task.signoffReviewers
        ?? team.members.filter(member => !member.isMaster && member.sessionId).map(member => member.name)
    const reviewers = reviewerRoster.filter(name => {
        const reviewer = team.members.find(member => member.name === name)
        return reviewer?.sessionId && reviewer.status !== "errored"
    })
    const reviewerSet = new Set(reviewers)
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
    await finishRun(ctx, team, reason, reached ? "idle" : "failed")
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

    // HIGH#4: errored reviewers must not be counted as rejections. A
    // session.error was raised — the reviewer never produced a verdict.
    // Skip errored members so they don't get signoffApprovals[false].
    if (member.status === "errored") {
        // If this is the decider, the signoff cannot reach a verdict without
        // its decision. Fail the run so it doesn't wait for wall-clock timeout.
        if (task.signoffPolicy === "decider" && member.name === task.signoffDecider) {
            await finishRun(ctx, team, "signoff_decider_error", "failed")
            return
        }
        // For peer-quorum, skip this reviewer's vote and settle against the
        // remaining live roster.
        await evaluateSignoffQuorum(ctx, team)
        return
    }

    const memberOutput = task.signoffRawOutputs?.[member.name] ?? task.responses[member.name] ?? ""
    const signoff = parseSignoff(memberOutput)
    if (!signoff) {
        logEvent(ctx, "debug", "signoff tag parse failed", {
            team: team.teamName,
            member: member.name,
        })
    } else if (signoff.parseFailed) {
        if (!task.signoffParseFailures) task.signoffParseFailures = {}
        const failures = (task.signoffParseFailures[member.name] ?? 0) + 1
        task.signoffParseFailures[member.name] = failures
        logEvent(ctx, "warn", "signoff payload malformed", {
            team: team.teamName,
            member: member.name,
            failures,
            maxFailures: MAX_SIGNOFF_PARSE_FAILURES,
        })
        if (failures < MAX_SIGNOFF_PARSE_FAILURES) {
            if (task.signoffApprovals) delete task.signoffApprovals[member.name]
            await dispatchToMember(
                ctx,
                member,
                `[Signoff format retry]\nYour previous signoff was malformed. Emit exactly one <signoff>{"approved": true|false, "rationale": "..."}</signoff> block.`,
                member.worktreePath ?? ctx.directory,
                team,
            )
            return
        }
    } else if (task.signoffParseFailures) {
        delete task.signoffParseFailures[member.name]
    }
    // signoffApprovals is initialized to {} in maybeTriggerSignoff before
    // signoffStage is set. Guard against undefined for robustness.
    if (!task.signoffApprovals) task.signoffApprovals = {}
    task.signoffApprovals[member.name] = signoff?.approved === true

    if (task.signoffPolicy === "decider") {
        const approved = signoff?.approved === true
        const reason = approved ? "signoff_approved" : "signoff_rejected"
        // H36: a signoff rejection is a QUALITY GATE FAILURE, not a successful
        // completion. Pre-fix code passed status="idle" for both approved and
        // rejected, which completion.ts mapped to run status "completed".
        // Run records, metrics, and result queries then showed the rejected
        // run as successful. Pass "failed" for rejections so the run record
        // correctly reflects the gate failure.
        await finishRun(ctx, team, reason, approved ? "idle" : "failed")
    } else if (task.signoffPolicy === "peer-quorum") {
        await evaluateSignoffQuorum(ctx, team)
    }
}

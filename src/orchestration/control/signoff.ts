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

/** Malformed-signoff retry cap per reviewer; at cap the parsed verdict
 * stands as final. */
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
 * Enter signoff when configured. Returns false when no active task exists or
 * signoff is disabled. Returns true when signoff is already active, reviewers
 * were dispatched, or the run was terminated because no reviewer is available.
 * Reviewer availability is resolved before signoff state is committed, so a
 * failed guard leaves no stale signoff event in the timeline.
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
            // Fail the run directly so all callers terminate.
            task.signoffStage = false
            await finishRun(ctx, team, "signoff_failed:decider_unavailable", "failed")
            return true
        }
        reviewers = [decider]
    } else {
        reviewers = team.members.filter(member =>
            !member.isMaster && member.sessionId && member.status !== "errored"
        )
        if (reviewers.length === 0) {
            task.signoffStage = false
            await finishRun(ctx, team, "signoff_failed:no_reviewers", "failed")
            return true
        }
    }

    // Commit the signoff stage only once reviewers are confirmed available.
    task.signoffStage = true
    task.signoffApprovals = {}
    task.signoffReviewers = reviewers.map(reviewer => reviewer.name)
    // Persist BEFORE dispatching reviewers so a crash between save and
    // dispatch does not lose the original roster or leave reviewers prompted
    // without signoffStage persisted. On resume, signoffStage=true ensures
    // reviewer responses are routed to handleSignoffIdle instead of being stray.
    //
    // Roll back the in-memory signoff stage on save failure so idle handling
    // cannot enter a stage with no reviewers in flight.
    //
    // Record the event only after a successful save so the timeline cannot
    // retain a signoff stage that persistence rolled back.
    try {
        await saveTeamStateBounded(team)
    } catch (err) {
        task.signoffStage = false
        task.signoffApprovals = undefined
        task.signoffReviewers = undefined
        throw err
    }
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "signoff",
        detail: task.signoffPolicy,
    })
    // Track dispatch failures so a partial reviewer dispatch cannot leave the
    // run waiting for reviewers who were never prompted.
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
                // Terminate on decider dispatch failure because the triggering
                // mode has completed and no future idle event can re-drive the
                // barrier.
                try {
                    await finishRun(ctx, team, "signoff_dispatch_failed:decider", "failed")
                } catch (finishErr) {
                    logSwallowed(
                        ctx,
                        "signoff: finishRun failed after decider dispatch failure",
                        finishErr,
                        { team: team.teamName },
                    )
                }
                return true
            }
        }
    }
    // peer-quorum with all-failures: no reviewer was prompted, so the run
    // would stall. finishRun terminates immediately.
    if (dispatchFailures.length === reviewers.length) {
        try {
            await finishRun(ctx, team, `signoff_dispatch_failed:all_reviewers`, "failed")
        } catch (finishErr) {
            logSwallowed(
                ctx,
                "signoff: finishRun failed after all-reviewers dispatch failure",
                finishErr,
                { team: team.teamName },
            )
        }
        return true
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
    // Keep all recorded votes, including votes from members who later errored,
    // so a recorded rejection cannot disappear and flip the result.
    // Only exclude errored members who have NOT yet voted.
    const reviewers = reviewerRoster.filter(name => {
        const reviewer = team.members.find(member => member.name === name)
        if (!reviewer?.sessionId) return false
        if (reviewer.status === "errored" && task.signoffApprovals?.[name] === undefined) return false
        return true
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

    // Errored reviewers must not be counted as rejections. A
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

    // Read only signoffRawOutputs from the reviewer's signoff-specific turn.
    // A missing entry is empty output and triggers retry rather than parsing a
    // <signoff> example from the primary task response as a real verdict.
    const memberOutput = task.signoffRawOutputs?.[member.name] ?? ""
    const signoff = parseSignoff(memberOutput)
    // A missing tag enters the same retry path as a malformed payload so one
    // format omission cannot immediately veto the run.
    if (!signoff || signoff.parseFailed) {
        if (!task.signoffParseFailures) task.signoffParseFailures = {}
        const failures = (task.signoffParseFailures[member.name] ?? 0) + 1
        task.signoffParseFailures[member.name] = failures
        const reason = !signoff ? "signoff tag not found" : "signoff payload malformed"
        logEvent(ctx, "warn", reason, {
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
                `[Signoff format retry]\nYour previous signoff was malformed or missing. Emit exactly one <signoff>{"approved": true|false, "rationale": "..."}</signoff> block.`,
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
        // A signoff rejection is a quality-gate failure. Mark it failed so run
        // records, metrics, and result queries cannot report it as successful.
        await finishRun(ctx, team, reason, approved ? "idle" : "failed")
    } else if (task.signoffPolicy === "peer-quorum") {
        await evaluateSignoffQuorum(ctx, team)
    }
}

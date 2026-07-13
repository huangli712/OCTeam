/**
 * Post-completion signoff handling for decider and peer-quorum policies.
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

export function buildSignoffReviewPrompt(summary: string): string {
    return `[Signoff review] Review the following workflow output. `
        + `If it meets quality standards, emit <signoff>{"approved": true, "rationale": "..."}</signoff>. `
        + `If not, emit <signoff>{"approved": false, "rationale": "specific issues..."}</signoff>.\n\n${summary}`
}

export async function maybeTriggerSignoff(ctx: PluginContext, team: Team): Promise<boolean> {
    const task = team.activeTask
    if (!task) return false
    if (!task.signoffPolicy || task.signoffPolicy === "none") return false
    if (task.signoffStage) return true

    task.signoffStage = true
    task.signoffApprovals = {}
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "signoff",
        detail: task.signoffPolicy,
    })
    const summary = await buildSummary(team, task, "pending_signoff")
    const reviewPrompt = buildSignoffReviewPrompt(summary)

    if (task.signoffPolicy === "decider") {
        const decider = team.members.find(member =>
            member.name === task.signoffDecider && !member.isMaster
        )
        if (!decider?.sessionId || decider.status === "errored") {
            task.signoffStage = false
            return false
        }
        await dispatchToMember(
            ctx,
            decider,
            reviewPrompt,
            decider.worktreePath ?? ctx.directory,
            team,
        )
    } else if (task.signoffPolicy === "peer-quorum") {
        const reviewers = team.members.filter(member =>
            !member.isMaster && member.sessionId && member.status !== "errored"
        )
        if (reviewers.length === 0) {
            task.signoffStage = false
            return false
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
    }

    await saveTeamState(team)
    return true
}

export async function handleSignoffIdle(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
): Promise<void> {
    const task = team.activeTask
    if (!task?.signoffStage) return

    const memberOutput = task.responses[member.name] ?? ""
    const signoff = parseSignoff(memberOutput)
    if (!signoff) {
        logEvent(ctx, "debug", "signoff tag parse failed", {
            team: team.teamName,
            member: member.name,
        })
    }
    task.signoffApprovals![member.name] = signoff?.approved === true

    if (task.signoffPolicy === "decider") {
        const reason = signoff?.approved === true ? "signoff_approved" : "signoff_rejected"
        await finishRun(ctx, team, reason, "idle")
    } else if (task.signoffPolicy === "peer-quorum") {
        const reviewers = team.members
            .filter(member => !member.isMaster && member.sessionId && member.status !== "errored")
            .map(member => member.name)
        const { allResponded, reached } = isQuorumReached(
            task.signoffApprovals ?? {},
            reviewers.length,
            task.signoffQuorum ?? 0.5,
        )
        if (!allResponded) return
        const reason = reached ? "signoff_quorum_reached" : "signoff_quorum_not_reached"
        await finishRun(ctx, team, reason, "idle")
    }
}

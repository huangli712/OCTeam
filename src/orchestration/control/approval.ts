/**
 * Human-in-the-loop approval control for mid-run pauses.
 *
 * Unlike post-completion signoff, approval is controlled by the team leader via
 * team_approve/team_reject. This module owns request creation, persistence,
 * leader notification, crash-resume notification, and forced gate escalation.
 */

import crypto from "node:crypto"

import type { PluginContext } from "../../core/context.js"
import type { ApprovalKind, ApprovalRequest, ApprovalSubtask } from "../../core/types.js"
import { type Team, saveTeamState } from "../../state/store.js"
import { recordEvent } from "../records/events.js"

type ApprovalRequestInput = {
    kind: ApprovalKind
    summary: string
    stage?: number
    round?: number
    taskId?: string
    member?: string
    subtasks?: ApprovalSubtask[]
}

/** Build the leader-facing prompt for a persisted approval request. */
export function buildApprovalPrompt(teamName: string, request: ApprovalRequest): string {
    const stageLabel = request.kind === "workflow_step" ? "step" : "stage"
    const stageDisplay = request.kind === "workflow_step" && request.stage !== undefined
        ? request.stage + 1
        : request.stage
    const where = [
        stageDisplay !== undefined ? `${stageLabel} ${stageDisplay}` : "",
        request.round !== undefined ? `round ${request.round}` : "",
    ].filter(Boolean).join(", ")
    const location = where ? ` (${where})` : ""
    return `[Human approval required] Team "${teamName}" is paused at ${request.kind}${location}.\n`
        + `Approval id: ${request.id}\n\n`
        + `${request.summary}\n\n`
        + `Call team_approve(team_id="${teamName}", approval_id="${request.id}") to continue, `
        + `or team_reject(team_id="${teamName}", approval_id="${request.id}", feedback="...") to reject.`
}

/** Notify the team leader without mutating approval state. */
async function notifyLeader(ctx: PluginContext, team: Team, request: ApprovalRequest): Promise<void> {
    await ctx.client.session.promptAsync({
        path: { id: team.leadSessionId },
        body: {
            parts: [{ type: "text", text: buildApprovalPrompt(team.teamName, request), synthetic: true }],
        },
    })
}

/**
 * Persist and announce a human-approval pause when the active task opted into
 * HITL. Returns true when a pause already exists or a new pause was created.
 */
export async function maybeRequestApproval(
    ctx: PluginContext,
    team: Team,
    input: ApprovalRequestInput,
): Promise<boolean> {
    const task = team.activeTask
    if (!task?.humanApproval) return false
    if (task.approvalStage && task.approvalRequest) return true
    return createApprovalPause(ctx, team, input)
}

/**
 * Build, persist, and announce a new approval pause.
 *
 * Assumes the caller has already authorized the pause (HITL flag or forced
 * escalation) and confirmed no active stage exists. Returns false only when
 * there is no active task to attach the pause to.
 */
async function createApprovalPause(
    ctx: PluginContext,
    team: Team,
    input: ApprovalRequestInput,
): Promise<boolean> {
    const task = team.activeTask
    if (!task) return false
    const request: ApprovalRequest = {
        id: crypto.randomUUID(),
        kind: input.kind,
        requestedAt: Date.now(),
        summary: input.summary,
        stage: input.stage,
        round: input.round,
        taskId: input.taskId,
        member: input.member,
        subtasks: input.subtasks,
    }
    task.approvalStage = true
    task.approvalRequest = request
    recordEvent(team, {
        timestamp: request.requestedAt,
        kind: "approval_requested",
        stage: request.stage,
        round: request.round,
        detail: request.kind,
    })
    await notifyLeader(ctx, team, request)
    await saveTeamState(team)
    return true
}

/** Re-notify the leader about an already persisted approval after resume. */
export async function resumeApprovalStage(ctx: PluginContext, team: Team): Promise<boolean> {
    const request = team.activeTask?.approvalRequest
    if (!team.activeTask?.approvalStage || !request) return false
    await notifyLeader(ctx, team, request)
    return true
}

/**
 * Force a human-approval pause regardless of the task's humanApproval flag.
 * Gate-level escalation uses this path when global HITL is disabled.
 */
export async function forceApprovalRequest(
    ctx: PluginContext,
    team: Team,
    input: ApprovalRequestInput,
): Promise<boolean> {
    const task = team.activeTask
    if (task?.approvalStage && task.approvalRequest) return true
    return createApprovalPause(ctx, team, input)
}

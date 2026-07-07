/**
 * Human-in-the-loop approval stages. Unlike signoff (post-completion member
 * review), approvalStage is a mid-run pause controlled by the leader via
 * team_approve/team_reject.
 */

import crypto from "node:crypto"

import type { PluginContext } from "../core/context.js"
import type { ApprovalKind, ApprovalRequest, ApprovalSubtask } from "../core/types.js"
import { type Team, saveTeamState } from "../state/store.js"
import { recordEvent } from "./events.js"

type ApprovalRequestInput = {
    kind: ApprovalKind
    summary: string
    stage?: number
    round?: number
    taskId?: string
    member?: string
    subtasks?: ApprovalSubtask[]
}

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

async function notifyLeader(ctx: PluginContext, team: Team, request: ApprovalRequest): Promise<void> {
    await ctx.client.session.promptAsync({
        path: { id: team.leadSessionId },
        body: {
            parts: [{ type: "text", text: buildApprovalPrompt(team.teamName, request), synthetic: true }],
        },
    })
}

export async function maybeRequestApproval(
    ctx: PluginContext,
    team: Team,
    input: ApprovalRequestInput,
): Promise<boolean> {
    const task = team.activeTask
    if (!task?.humanApproval) return false
    if (task.approvalStage && task.approvalRequest) return true

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

export async function resumeApprovalStage(ctx: PluginContext, team: Team): Promise<boolean> {
    const request = team.activeTask?.approvalRequest
    if (!team.activeTask?.approvalStage || !request) return false
    await notifyLeader(ctx, team, request)
    return true
}

/**
 * Force a human-approval pause regardless of the task's `humanApproval` flag.
 * Used by gate-level policies (e.g. workflow on_invalid='escalate') that must
 * escalate to the leader even when global HITL is disabled.
 */
export async function forceApprovalRequest(
    ctx: PluginContext,
    team: Team,
    input: ApprovalRequestInput,
): Promise<boolean> {
    if (team.activeTask?.approvalStage && team.activeTask?.approvalRequest) return true
    // Temporarily enable humanApproval so maybeRequestApproval persists the
    // pause; restore the original value afterwards to keep global semantics.
    const task = team.activeTask
    if (!task) return false
    const prev = task.humanApproval
    task.humanApproval = true
    try {
        return await maybeRequestApproval(ctx, team, input)
    } finally {
        task.humanApproval = prev
    }
}

/**
 * Human approval tools. These are master-only control-plane tools that resolve
 * a mid-run approvalStage by approving or rejecting the current request.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"

import type { PluginContext } from "../../core/context.js"
import type { ApprovalDecisionRecord, ApprovalRequest } from "../../core/types.js"
import { finishRun } from "../../orchestration/control/completion.js"
import { recordEvent } from "../../orchestration/records/events.js"
import { advancePipelineAfterStage } from "../../orchestration/modes/pipeline.js"
import { advanceTollgateAfterPass, startVerification } from "../../orchestration/modes/tollgate.js"
import { buildArbiterPrompt } from "../../orchestration/modes/arbitrate.js"
import { approveLoopDone, rejectLoopDone } from "../../orchestration/modes/loop.js"
import { advanceRouteAfterDecision } from "../../orchestration/modes/route.js"
import { approveRecurseDecompose, rejectRecurseDecompose } from "../../orchestration/modes/recurse.js"
import { advanceWorkflowStep } from "../../orchestration/workflow/engine.js"
import { maybeTriggerSignoff } from "../../orchestration/control/signoff.js"
import { resolveCallerInTeam } from "../../state/resolve.js"
import { loadTeamState, saveTeamStateBounded, type Team } from "../../state/store.js"
import { dispatchToMember } from "../../orchestration/control/dispatch.js"
import { findMember } from "../support.js"

/** Result of a human approval decision: approved boolean with optional feedback. */
type ApprovalDecision = {
    approved: boolean
    feedback?: string
}

/** Validate that a team has a pending approval matching the given approvalId (if provided). */
function validateApproval(team: Team, approvalId: string | undefined): ApprovalRequest | string {
    const task = team.activeTask
    if (!task?.approvalStage || !task.approvalRequest) {
        return `Error: team "${team.teamName}" has no pending human approval.`
    }
    if (approvalId !== undefined && approvalId !== task.approvalRequest.id) {
        return `Error: approval_id "${approvalId}" does not match pending approval "${task.approvalRequest.id}".`
    }
    return task.approvalRequest
}

/**
 * H4: validate that an ApprovalRequest carries the payload its kind requires.
 * Returns null when valid, or an error message string describing the gap.
 * Prevents malformed/tampered requests from reaching the resume handler and
 * silently no-oping, leaving the run stuck in approval limbo.
 */
function validateApprovalPayload(req: ApprovalRequest): string | null {
    switch (req.kind) {
        case "recurse_decompose":
            if (!req.taskId) return "missing required field 'taskId'"
            if (!req.member) return "missing required field 'member'"
            if (!Array.isArray(req.subtasks) || req.subtasks.length === 0) return "missing or empty required field 'subtasks'"
            return null
        case "tollgate_gate":
            if (req.stage === undefined) return "missing required field 'stage'"
            return null
        case "workflow_step":
            if (req.stage === undefined) return "missing required field 'stage'"
            return null
        case "pipeline_stage":
            if (req.stage === undefined) return "missing required field 'stage'"
            return null
        case "loop_done":
            if (req.round === undefined) return "missing required field 'round'"
            return null
        // route_decision, arbitrate_ruling, consensus_deadlock have no
        // kind-specific required fields beyond summary/id (always present).
        default:
            return null
    }
}

/** Apply an approval decision to the active task, advancing or failing the orchestration. */
export async function applyApprovalDecision(
    ctx: PluginContext,
    team: Team,
    decision: ApprovalDecision,
): Promise<string> {
    const task = team.activeTask
    if (!task?.approvalStage || !task.approvalRequest) {
        return `Error: team "${team.teamName}" has no pending human approval.`
    }
    const request = task.approvalRequest
    // H4: validate that the request carries the payload its kind requires.
    // ApprovalRequest is a flat type — kind is an enum but the payload fields
    // are all optional, so a malformed/tampered request (e.g. recurse_decompose
    // with no subtasks) would reach the resume handler and silently no-op,
    // leaving the run stuck in approval limbo. Reject early with a clear error.
    const payloadErr = validateApprovalPayload(request)
    if (payloadErr) {
        return `Error: approval request ${request.id} has an incomplete payload for kind "${request.kind}": ${payloadErr}`
    }
    const resolvedAt = Date.now()
    const pausedMs = Math.max(0, resolvedAt - request.requestedAt)
    // Shift startedAt by the paused duration so wall-clock timeout
    // accounts for the human delay. Guard against undefined startedAt.
    const savedStartedAt = task.startedAt
    task.startedAt = (task.startedAt ?? Date.now()) + pausedMs
    const record: ApprovalDecisionRecord = {
        id: request.id,
        kind: request.kind,
        approved: decision.approved,
        requestedAt: request.requestedAt,
        resolvedAt,
    }
    if (decision.feedback !== undefined) record.feedback = decision.feedback
    task.approvalHistory = [...(task.approvalHistory ?? []), record]
    task.approvalStage = undefined
    task.approvalRequest = undefined
    // H-13/G: persist the approval resolution BEFORE dispatch/advance. Pre-fix
    // code saved only at the end, so a dispatch throw left disk showing the
    // approval as still pending. M20 moved save inside the try but the catch
    // only restored startedAt — a SAVE failure left approvalStage/Request
    // cleared and approvalHistory updated in memory while disk still showed
    // the old pending request, so a retry could re-approve.
    // G fix: wrap the save in its own try/catch. On save failure, restore the
    // FULL approval state (approvalStage, approvalRequest, approvalHistory,
    // startedAt) and rethrow. On dispatch failure (after successful save),
    // keep the approval resolved (disk already has it) — only restore
    // startedAt per H-13.
    try {
        await saveTeamStateBounded(team)
    } catch (saveErr) {
        // Save failed: disk does NOT have the resolution. Restore all
        // mutated fields so a retry sees the original pending request.
        task.startedAt = savedStartedAt
        task.approvalStage = true
        task.approvalRequest = request
        task.approvalHistory = (task.approvalHistory ?? []).slice(0, -1)
        throw saveErr
    }
    recordEvent(team, {
        timestamp: resolvedAt,
        kind: "approval_resolved",
        stage: request.stage,
        round: request.round,
        detail: `${request.kind}:${decision.approved ? "approved" : "rejected"}`,
    })

    // Save succeeded — dispatch/advance below. A failure here must NOT
    // restore the approval (disk already has the resolution; restoring
    // would let the master re-approve and duplicate the dispatch).
    try {
    if (!decision.approved) {
        switch (request.kind) {
            case "pipeline_stage":
                await finishRun(ctx, team, "pipeline_human_rejected", "failed")
                return `Rejected ${request.kind} for team "${team.teamName}".`
            case "tollgate_gate":
                await finishRun(ctx, team, "tollgate_human_rejected", "failed")
                return `Rejected ${request.kind} for team "${team.teamName}".`
            case "loop_done":
                await rejectLoopDone(ctx, team, decision.feedback)
                return `Rejected ${request.kind} for team "${team.teamName}".`
            case "route_decision":
                await finishRun(ctx, team, "route_human_rejected", "failed")
                return `Rejected ${request.kind} for team "${team.teamName}".`
            case "arbitrate_ruling":
                await finishRun(ctx, team, "arbitrate_human_rejected", "failed")
                return `Rejected ${request.kind} for team "${team.teamName}".`
            case "consensus_deadlock":
                await finishRun(ctx, team, "consensus_human_rejected", "failed")
                return `Rejected ${request.kind} for team "${team.teamName}".`
            case "recurse_decompose":
                await rejectRecurseDecompose(ctx, team, request)
                return `Rejected ${request.kind} for team "${team.teamName}".`
            case "workflow_step":
                await finishRun(ctx, team, "workflow_human_rejected", "failed")
                return `Rejected ${request.kind} for team "${team.teamName}".`
            default: {
                const _exhaustive: never = request.kind
                void _exhaustive
                return `Error: unsupported approval kind.`
            }
        }
    }

    switch (request.kind) {
        case "pipeline_stage":
            await advancePipelineAfterStage(ctx, team)
            return `Approved ${request.kind} for team "${team.teamName}"; resuming.`
        case "tollgate_gate":
            if (task.type === "tollgate" && task.tollgatePhase === "produce") {
                // Pre-verify pause: dispatch the verifier for the current gate.
                const stage = task.gatedStages?.[task.currentStageIndex]
                if (stage) {
                    await startVerification(ctx, team, stage)
                } else {
                    await advanceTollgateAfterPass(ctx, team)
                }
            } else if (task.type === "tollgate" && task.tollgatePhase === "verify"
                       && task.gatedStages?.[task.currentStageIndex]?.completed !== true) {
                // H44: INVALID-retry pause (no escalateTo handler). The stage
                // is NOT completed (INVALID never completes), and the approval
                // summary said "Approve to retry verification" — re-dispatch
                // the verifier for the current gate, NOT advance to the next.
                // Pre-fix code fell through to advanceTollgateAfterPass.
                // Discriminator: PASS approvals also pause in verify phase,
                // but stage.completed === true there, so they advance.
                const stage = task.gatedStages?.[task.currentStageIndex]
                if (stage) {
                    await startVerification(ctx, team, stage)
                } else {
                    await advanceTollgateAfterPass(ctx, team)
                }
            } else {
                // Post-PASS between-gates pause: advance to the next gate.
                await advanceTollgateAfterPass(ctx, team)
            }
            return `Approved ${request.kind} for team "${team.teamName}"; resuming.`
        case "loop_done":
            await approveLoopDone(ctx, team)
            return `Approved ${request.kind} for team "${team.teamName}"; resuming.`
        case "route_decision":
            await advanceRouteAfterDecision(ctx, team)
            return `Approved ${request.kind} for team "${team.teamName}"; resuming.`
        case "arbitrate_ruling":
            if (task.type === "arbitrate" && task.arbitrationStage && !task.responses[task.arbiterMember ?? ""]) {
                // Pre-ruling pause approved: dispatch the arbiter to issue the ruling.
                const arbiter = findMember(team, task.arbiterMember ?? "")
                if (arbiter?.sessionId) {
                    await dispatchToMember(
                        ctx, arbiter, buildArbiterPrompt(task),
                        arbiter.worktreePath ?? ctx.directory, team,
                    )
                } else {
                    await finishRun(ctx, team, "arbitrate_complete:arbiter_unavailable", "failed")
                }
            } else {
                // Post-ruling pause approved: deliver the ruling.
                // H-M1: honor signoff before finishRun, matching the
                // non-HITL path in handleArbitrateIdle (line 191).
                if (await maybeTriggerSignoff(ctx, team)) {
                    return `Approved ${request.kind} for team "${team.teamName}"; signoff in progress.`
                }
                await finishRun(ctx, team, "arbitrate_complete:ruled", "idle")
            }
            return `Approved ${request.kind} for team "${team.teamName}"; resuming.`
        case "consensus_deadlock":
            await finishRun(ctx, team, "consensus_max_rounds_accepted", "idle")
            return `Approved ${request.kind} for team "${team.teamName}"; resuming.`
        case "recurse_decompose":
            await approveRecurseDecompose(ctx, team, request)
            return `Approved ${request.kind} for team "${team.teamName}"; resuming.`
        case "workflow_step":
            await advanceWorkflowStep(ctx, team)
            return `Approved ${request.kind} for team "${team.teamName}"; resuming.`
        default: {
            const _exhaustive: never = request.kind
            void _exhaustive
            return `Error: unsupported approval kind.`
        }
    }
    } catch (err) {
        // A dispatch or advance threw after the approval was already cleared
        // AND persisted. Pre-fix code restored ALL mutation state
        // (approvalStage/approvalRequest/approvalHistory) back to the pending
        // shape, but the disk already held the resolved state (saved at line
        // 90 above). On retry this let the master re-approve the SAME request,
        // re-dispatching branches that had partially completed — duplicate
        // prompts and double-advancement.
        //
        // H-13 fix: keep the approval as resolved in memory AND on disk. Only
        // restore startedAt (a pure wall-clock adjustment that is meaningless
        // without a successful dispatch). The next approve call finds
        // approvalStage=undefined and returns "no pending approval" instead
        // of re-running the dispatch.
        task.startedAt = savedStartedAt
        // MEDIUM: persist the startedAt rollback so disk and memory agree.
        try { await saveTeamStateBounded(team) } catch { /* best-effort */ }
        throw err
    }
}

/** Create an approve or reject tool definition based on the boolean `approved` flag. */
function approvalTool(ctx: PluginContext, approved: boolean): ToolDefinition {
    return tool({
        description: approved
            ? "Master-only: approve the current human approval pause and resume the orchestration."
            : "Master-only: reject the current human approval pause and apply the mode-specific rejection behavior.",
        args: {
            team_id: tool.schema.string().min(1),
            approval_id: tool.schema.string().optional(),
            feedback: tool.schema.string().max(32768).optional(),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller) return "Error: caller is not a member of this team"
            if (!caller.isMaster) {
                return approved ? "Error: team_approve is master-only" : "Error: team_reject is master-only"
            }

            let team
            try {
                team = await loadTeamState(caller.storageRoot, args.team_id, caller.leadSessionId)
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
            }

            let result = ""
            await team.mutex.runExclusive(async () => {
                const validation = validateApproval(team, args.approval_id)
                if (typeof validation === "string") {
                    result = validation
                    return
                }
                result = await applyApprovalDecision(ctx, team, { approved, feedback: args.feedback })
                await saveTeamStateBounded(team)
            })
            return result
        },
    })
}

/** Approve a pending human-approval request for the current orchestration. */
export function teamApproveTool(ctx: PluginContext): ToolDefinition {
    return approvalTool(ctx, true)
}

/** Reject a pending human-approval request for the current orchestration. */
export function teamRejectTool(ctx: PluginContext): ToolDefinition {
    return approvalTool(ctx, false)
}

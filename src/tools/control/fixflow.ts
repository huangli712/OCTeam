/**
 * team_fix_workflow tool -- master-only workflow repair. Redispatch, skip,
 * advance, reassign, or fail a busy or interrupted team_workflow run without
 * cancelling the whole team.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import type { ActiveTask, WorkflowTask } from "../../core/types.js"
import { isEnoent } from "../../core/utils.js"
import { logSwallowed } from "../../core/log.js"
import { checkWorkflowInvariants } from "../../orchestration/workflow/invariants.js"
import { activationError } from "../../state/activation.js"
import { workflowOperatorFailReason } from "../../orchestration/workflow/reasons.js"
import { getActiveWorkflowStepIndices } from "../../orchestration/workflow/dag.js"
import { finishRun } from "../../orchestration/control/completion.js"
import { recordEvent } from "../../orchestration/records/events.js"
import { advanceWorkflowStep, redispatchWorkflowStep } from "../../orchestration/workflow/engine.js"
import { resolveCallerInTeam } from "../../state/resolve.js"
import { loadTeamState, saveTeamState, type Team } from "../../state/store.js"
import { findMember } from "../support.js"

/** Workflow fix operation kind: redispatch, skip, advance, fail, or reassign. */
type FixWorkflowOp = "redispatch" | "skip" | "advance" | "fail" | "reassign"

/** Step argument: 1-based number or stable step id string. */
type WorkflowFixStepArg = number | string

/** Wraps the workflow task targeted by a fix operation. */
type WorkflowRepairTarget = {
    readonly task: WorkflowTask
}

/** Snapshot of a member's mutable state for rollback after a failed fix. */
type MemberSnapshot = {
    readonly name: string
    readonly status: Team["members"][number]["status"]
    readonly error: string | undefined
    readonly retryingSince: number | undefined
    readonly sessionId: string | undefined
    readonly turnCount: number
    readonly declaredDone: boolean | undefined
}

/** Full team snapshot (status + task + members) for atomic rollback on fix failure. */
type RepairSnapshot = {
    readonly status: Team["status"]
    readonly runnerPid: number | undefined
    readonly activeTask: ActiveTask | undefined
    readonly lastInterruptedTask: ActiveTask | undefined
    readonly members: readonly MemberSnapshot[]
}

/** Type guard: true when the task is a workflow task. */
function isWorkflowTask(task: ActiveTask | undefined): task is WorkflowTask {
    return task?.type === "workflow"
}

/** Resolve a step argument (number or id string) to a 0-based index; defaults to the first active step. */
function stepIndexFromArg(step: WorkflowFixStepArg | undefined, task: WorkflowTask): number | null {
    if (typeof step === "number") return step - 1
    if (typeof step === "string") {
        const found = task.steps?.findIndex(workflowStep => workflowStep.id === step) ?? -1
        return found >= 0 ? found : null
    }
    return task.activeStepIndices?.[0] ?? task.currentStageIndex
}

/** Check whether a step index is in the active workflow frontier. */
function isActiveWorkflowStep(task: WorkflowTask, index: number): boolean {
    return getActiveWorkflowStepIndices(task).includes(index)
}

/** Deep-clone an ActiveTask (used by snapshot/restore for rollback isolation). */
function cloneActiveTask(task: ActiveTask | undefined): ActiveTask | undefined {
    if (task === undefined) return undefined
    return structuredClone(task)
}

/** Capture a deep snapshot of the team's mutable state for rollback. */
function snapshotTeam(team: Team): RepairSnapshot {
    return {
        status: team.status,
        runnerPid: team.runnerPid,
        activeTask: cloneActiveTask(team.activeTask),
        lastInterruptedTask: cloneActiveTask(team.lastInterruptedTask),
        members: team.members.map(member => ({
            name: member.name,
            status: member.status,
            error: member.error,
            retryingSince: member.retryingSince,
            sessionId: member.sessionId,
            turnCount: member.turnCount,
            declaredDone: member.declaredDone,
        })),
    }
}

/** Restore a previously captured snapshot, reverting all mutable fields. */
function restoreSnapshot(team: Team, snapshot: RepairSnapshot): void {
    team.status = snapshot.status
    team.runnerPid = snapshot.runnerPid
    team.activeTask = cloneActiveTask(snapshot.activeTask)
    team.lastInterruptedTask = cloneActiveTask(snapshot.lastInterruptedTask)
    for (const memberState of snapshot.members) {
        const member = team.members.find(candidate => candidate.name === memberState.name)
        if (member === undefined) continue
        member.status = memberState.status
        member.error = memberState.error
        member.retryingSince = memberState.retryingSince
        member.sessionId = memberState.sessionId
        member.turnCount = memberState.turnCount
        member.declaredDone = memberState.declaredDone
    }
}

/**
 * Resolve the workflow repair target: a busy workflow, or an interrupted workflow
 * (promotes it to busy and resets errored members to idle).
 */
function workflowRepairTarget(team: Team): WorkflowRepairTarget | null {
    if (team.status === "busy" && isWorkflowTask(team.activeTask)) {
        // Reject repair while an approval is pending so workflow changes cannot
        // bypass leader review or leave an approval targeting a replaced step.
        if (team.activeTask.approvalStage !== undefined) return null
        return { task: team.activeTask }
    }
    if (team.status === "failed" && isWorkflowTask(team.lastInterruptedTask)) {
        team.activeTask = team.lastInterruptedTask
        team.status = "busy"
        // Update runnerPid so the reconciler recognizes this process as the
        // resumed workflow owner.
        team.runnerPid = process.pid
        team.lastInterruptedTask = undefined
        for (const member of team.members) {
            if (member.status !== "errored") continue
            member.status = "idle"
            member.error = undefined
            member.retryingSince = undefined
        }
        return { task: team.activeTask }
    }
    return null
}

/** Validate workflow invariants after a fix; returns an error string or null. */
function validateWorkflowAfterFix(task: WorkflowTask): string | null {
    const check = checkWorkflowInvariants(task)
    return check.ok ? null : `Error: workflow invariant violation after fix: ${check.violations.join("; ")}`
}

/** Sanitize a free-text reason into a safe reason string (alphanumeric + punctuation, max 80 chars). */
function sanitizeReason(reason: string | undefined): string {
    return reason?.trim() ? reason.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 80) : "operator_fix"
}

/** Redispatch an active workflow step, resetting its dispatch state first. */
async function applyRedispatch(
    ctx: PluginContext, team: Team, task: WorkflowTask,
    step: WorkflowFixStepArg | undefined,
): Promise<string> {
    const index = stepIndexFromArg(step, task)
    if (index === null) return "Error: workflow has no active step to redispatch"
    const workflowStep = task.steps?.[index]
    if (workflowStep === undefined) return `Error: step ${index + 1} does not exist`
    if (!isActiveWorkflowStep(task, index)) return `Error: step ${index + 1} is not in the active workflow frontier`
    if (workflowStep.completed) return `Error: step ${index + 1} is already completed`
    const invariantError = validateWorkflowAfterFix(task)
    if (invariantError !== null) return invariantError
    workflowStep.dispatchedAt = undefined
    // Abort the currently dispatched actor before redispatching
    // so the old prompt's late idle doesn't race with the new dispatch.
    const oldActorName = workflowStep.dispatchedActor
    if (oldActorName) {
        const oldActor = team.members.find(m => m.name === oldActorName)
        if (oldActor?.sessionId && oldActor.status === "running") {
            try {
                await ctx.client.session.abort({
                    path: { id: oldActor.sessionId },
                    query: { directory: oldActor.worktreePath ?? ctx.directory },
                })
            } catch (err) {
                const abortError = err instanceof Error ? err : new Error(String(err))
                // Return an error if abort fails so the previous turn cannot run
                // alongside the new dispatch and the caller can retry.
                return `Error: cannot abort previous turn for member "${oldActor.name}" before redispatch. ${abortError.message}`
            }
        }
    }
    const dispatched = await redispatchWorkflowStep(ctx, team, index)
    if (!dispatched) return `Error: step ${index + 1} cannot be redispatched`
    await saveTeamState(team)
    return `team_fix_workflow redispatched step ${index + 1}.`
}

/** Skip an active workflow step, marking it completed+skipped, then advance. */
async function applySkip(
    ctx: PluginContext, team: Team, task: WorkflowTask,
    step: WorkflowFixStepArg | undefined,
): Promise<string> {
    const index = stepIndexFromArg(step, task)
    if (index === null) return "Error: workflow has no active step to skip"
    const workflowStep = task.steps?.[index]
    if (workflowStep === undefined) return `Error: step ${index + 1} does not exist`
    if (!isActiveWorkflowStep(task, index)) return `Error: step ${index + 1} is not in the active workflow frontier`
    if (workflowStep.kind === "fanout" || workflowStep.kind === "join") {
        return `Error: step ${index + 1} marker steps cannot be skipped directly`
    }
    const invariantError = validateWorkflowAfterFix(task)
    if (invariantError !== null) return invariantError
    const oldActorName = workflowStep.dispatchedActor
        ?? (workflowStep.kind === "task"
            ? workflowStep.member
            : workflowStep.verifier ?? workflowStep.verifiers?.[0])
    if (oldActorName !== undefined) {
        const oldActor = team.members.find(member => member.name === oldActorName)
        if (oldActor?.sessionId !== undefined && ctx.client.session.abort !== undefined) {
            await ctx.client.session.abort({
                path: { id: oldActor.sessionId },
                query: { directory: oldActor.worktreePath ?? ctx.directory },
            })
        }
    }
    workflowStep.completed = true
    workflowStep.skipped = true
    workflowStep.dispatchedAt = undefined
    workflowStep.dispatchedActor = undefined
    workflowStep.correlationId = undefined
    await advanceWorkflowStep(ctx, team)
    await saveTeamState(team)
    return `team_fix_workflow skipped step ${index + 1}.`
}

/** Advance the workflow to the next step unconditionally. */
async function applyAdvance(ctx: PluginContext, team: Team, task: WorkflowTask): Promise<string> {
    const index = stepIndexFromArg(undefined, task)
    if (index === null) return "Error: workflow has no active step to advance"
    const workflowStep = task.steps?.[index]
    if (workflowStep === undefined) return `Error: step ${index + 1} does not exist`
    if (!isActiveWorkflowStep(task, index)) return `Error: step ${index + 1} is not in the active workflow frontier`
    const invariantError = validateWorkflowAfterFix(task)
    if (invariantError !== null) return invariantError
    workflowStep.completed = true
    workflowStep.dispatchedAt = undefined
    workflowStep.dispatchedActor = undefined
    workflowStep.correlationId = undefined
    await advanceWorkflowStep(ctx, team)
    await saveTeamState(team)
    return "team_fix_workflow advanced workflow."
}

/** Fail a workflow step with a sanitized reason, finishing the run with a failure status. */
async function applyFail(ctx: PluginContext, team: Team, reason: string | undefined): Promise<string> {
    const safeReason = sanitizeReason(reason)
    await finishRun(ctx, team, workflowOperatorFailReason(safeReason), "failed")
    await saveTeamState(team)
    return `team_fix_workflow failed workflow with reason ${workflowOperatorFailReason(safeReason)}.`
}

/** Orchestrate a workflow fix operation: find the repair target and dispatch the selected op. */
async function applyWorkflowFix(
    ctx: PluginContext, team: Team, op: FixWorkflowOp,
    step: WorkflowFixStepArg | undefined,
    reason: string | undefined,
    toMember: string | undefined,
): Promise<string> {
    const target = workflowRepairTarget(team)
    if (target === null) return team.activeTask === undefined && team.lastInterruptedTask === undefined
        ? `Error: team "${team.teamName}" has no active or interrupted workflow to fix`
        : "Error: active task is not a workflow"

    const result = await dispatchWorkflowFixOp(ctx, team, target.task, op, step, reason, toMember)
    if (!result.startsWith("Error:")) {
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "repaired",
            stepIndex: step === undefined ? undefined : stepIndexFromArg(step, target.task) ?? undefined,
            detail: `team_fix_workflow op=${op}${reason ? ` reason=${reason}` : ""}`,
        })
    }
    return result
}

/** Reassign a workflow step to a different team member, updating the actor and re-dispatching. */
async function applyReassign(
    ctx: PluginContext, team: Team, task: WorkflowTask,
    step: WorkflowFixStepArg | undefined,
    toMember: string | undefined,
): Promise<string> {
    if (toMember === undefined) return "Error: team_fix_workflow op='reassign' requires `to_member`"
    const index = stepIndexFromArg(step, task)
    if (index === null) return "Error: workflow has no active step to reassign"
    const workflowStep = task.steps?.[index]
    if (workflowStep === undefined) return `Error: step ${index + 1} does not exist`
    if (!isActiveWorkflowStep(task, index)) return `Error: step ${index + 1} is not in the active workflow frontier`
    if (workflowStep.kind === "fanout" || workflowStep.kind === "join") {
        return `Error: step ${index + 1} marker steps cannot be reassigned`
    }

    // Ensemble gates store the actor in `verifiers`, not the scalar `verifier`.
    // Read the primary verifier from the correct field for actor checks.
    let currentActor: string | undefined
    if (workflowStep.kind === "task") {
        currentActor = workflowStep.member
    } else if (workflowStep.kind === "gate") {
        currentActor = workflowStep.verifier ?? workflowStep.verifiers?.[0]
    }
    if (currentActor === toMember) return `Error: step ${index + 1} is already owned by "${toMember}"`
    const newMember = findMember(team, toMember)
    if (newMember === undefined) return `Error: "${toMember}" is not a team member`
    if (newMember.sessionId === undefined || newMember.status === "errored") {
        return `Error: "${toMember}" has no live session`
    }

    // Fanout branch actor uniqueness: the new actor must not already be active
    // in a sibling branch (reuses the same rule as fanout validation).
    if (workflowStep.branch !== undefined) {
        const conflict = activeBranchActorConflict(task, toMember, index)
        if (conflict !== null) return `Error: "${toMember}" is already active in branch "${conflict}"`
    }

    // Update the correct field based on step kind. For ensemble gates,
    // replace the first entry in the verifiers array (the primary verifier).
    if (workflowStep.kind === "task") {
        workflowStep.member = toMember
    } else if (workflowStep.kind === "gate") {
        if (workflowStep.verifiers !== undefined && workflowStep.verifiers.length > 0) {
            // Reject a duplicate verifier before replacing the primary entry.
            const remaining = workflowStep.verifiers.slice(1)
            if (remaining.includes(toMember)) {
                return `Error: "${toMember}" is already a verifier in this ensemble gate — reassignment would create a duplicate`
            }
            // Clear the old verifier's ensemble result so the next aggregation
            // does not count its stale vote alongside the new verifier.
            const oldVerifier = workflowStep.verifiers[0]
            if (oldVerifier && workflowStep.ensembleResults) {
                delete workflowStep.ensembleResults[oldVerifier]
            }
            workflowStep.verifiers = [toMember, ...remaining]
        } else {
            workflowStep.verifier = toMember
        }
    }
    workflowStep.dispatchedAt = undefined
    workflowStep.correlationId = undefined

    const invariantError = validateWorkflowAfterFix(task)
    if (invariantError !== null) return invariantError
    const oldActorName = workflowStep.dispatchedActor ?? currentActor
    if (oldActorName !== undefined) {
        const oldActor = team.members.find(member => member.name === oldActorName)
        if (oldActor?.sessionId !== undefined && ctx.client.session.abort !== undefined) {
            await ctx.client.session.abort({
                path: { id: oldActor.sessionId },
                query: { directory: oldActor.worktreePath ?? ctx.directory },
            })
        }
    }
    const dispatched = await redispatchWorkflowStep(ctx, team, index)
    if (!dispatched) return `Error: step ${index + 1} cannot be redispatched to "${toMember}"`
    await saveTeamState(team)
    return `team_fix_workflow reassigned step ${index + 1} to "${toMember}".`
}

/** Check whether a candidate member is already active in a sibling branch of a fanout step. */
function activeBranchActorConflict(task: WorkflowTask, candidateMember: string, excludeIndex: number): string | null {
    for (const activeIndex of getActiveWorkflowStepIndices(task)) {
        if (activeIndex === excludeIndex) continue
        const step = task.steps?.[activeIndex]
        // Check both single-verifier and ensemble fields so a candidate already
        // in an ensemble cannot take a second active role and distort vote weight
        // or response attribution.
        let actorMatches = false
        if (step?.kind === "task") {
            actorMatches = step.member === candidateMember
        } else if (step?.kind === "gate") {
            actorMatches = step.verifier === candidateMember
                || (step.verifiers?.includes(candidateMember) ?? false)
        }
        if (actorMatches && step?.branch !== undefined) return step.branch.branchId
    }
    return null
}

/** Dispatch a workflow fix operation to the appropriate handler based on op type. */
async function dispatchWorkflowFixOp(
    ctx: PluginContext, team: Team, task: WorkflowTask,
    op: FixWorkflowOp, step: WorkflowFixStepArg | undefined,
    reason: string | undefined,
    toMember: string | undefined,
): Promise<string> {
    switch (op) {
        case "redispatch":
            return await applyRedispatch(ctx, team, task, step)
        case "skip":
            return await applySkip(ctx, team, task, step)
        case "advance":
            return await applyAdvance(ctx, team, task)
        case "fail":
            return await applyFail(ctx, team, reason)
        case "reassign":
            return await applyReassign(ctx, team, task, step, toMember)
        default:
            op satisfies never
            return "Error: unsupported workflow fix operation"
    }
}

/** Repair a stuck or interrupted workflow step by redispatch, skip, advance, fail, or reassign. */
export function teamFixWorkflowTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Master-only workflow repair tool. Redispatch, skip, advance, or fail a busy "
            + "or interrupted team_workflow run without cancelling the whole team.",
        args: {
            team_id: tool.schema.string().min(1),
            op: tool.schema.enum(["redispatch", "skip", "advance", "fail", "reassign"]),
            step: tool.schema.union([
                tool.schema.number().int().min(1),
                tool.schema.string().min(1),
            ]).optional().describe(
                "1-based workflow step number or stable step id to repair. "
                + "Defaults to the first active frontier step for redispatch/skip/reassign.",
            ),
            reason: tool.schema.string().min(1).max(200).optional().describe(
                "operator reason used by op='fail'",
            ),
            to_member: tool.schema.string().min(1).optional().describe(
                "target member name for op='reassign' (must be a live team member)",
            ),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(
                ctx.storageRoot, context.sessionID, args.team_id,
                { requireActive: false },
            )
            if (!caller) return "Error: caller is not a member of this team"
            if (!caller.isMaster) return "Error: team_fix_workflow is master-only"
            let team: Team
            try {
                team = await loadTeamState(caller.storageRoot, args.team_id, caller.leadSessionId)
            } catch (err) {
                if (isEnoent(err)) return `Error: team "${args.team_id}" not found`
                logSwallowed(ctx, "loadTeamState failed (fix_workflow)", err, { team: args.team_id })
                return `Error: team "${args.team_id}" could not be loaded (state file unreadable)`
            }
            const gate = activationError(team.teamName, team.activatedAt)
            if (gate) return gate

            let result = ""
            await team.mutex.runExclusive(async () => {
                const snapshot = snapshotTeam(team)
                try {
                    result = await applyWorkflowFix(ctx, team, args.op, args.step, args.reason, args.to_member)
                    if (result.startsWith("Error:")) {
                        restoreSnapshot(team, snapshot)
                        await saveTeamState(team)
                    }
                } catch (err) {
                    // dispatch/advance can throw after workflowRepairTarget already
                    // mutated the registry-cached team. Roll cache + disk back to the
                    // snapshot, then return an error string (not throw — the OpenCode
                    // tool framework expects string returns, not thrown exceptions).
                    restoreSnapshot(team, snapshot)
                    await saveTeamState(team)
                    result = `Error: team_fix_workflow failed: ${err instanceof Error ? err.message : String(err)}`
                }
            })
            return result
        },
    })
}

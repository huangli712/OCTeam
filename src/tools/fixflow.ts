import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import type { ActiveTask, WorkflowTask } from "../core/types.js"
import { checkWorkflowInvariants } from "../orchestration/invariants.js"
import { activationError } from "../state/activation.js"
import { workflowOperatorFailReason } from "../orchestration/reasons.js"
import { getActiveWorkflowStepIndices } from "../orchestration/dag.js"
import { finishRun } from "../orchestration/summary.js"
import { recordEvent } from "../orchestration/events.js"
import { advanceWorkflowStep, redispatchWorkflowStep } from "../orchestration/workflow.js"
import { resolveCallerInTeam } from "../state/resolve.js"
import { loadTeamState, saveTeamState, type Team } from "../state/store.js"

type FixWorkflowOp = "redispatch" | "skip" | "advance" | "fail" | "reassign"
type WorkflowFixStepArg = number | string

type WorkflowRepairTarget = {
    readonly task: WorkflowTask
}

type MemberSnapshot = {
    readonly name: string
    readonly status: Team["members"][number]["status"]
    readonly error: string | undefined
    readonly retryingSince: number | undefined
    readonly sessionId: string | undefined
    readonly turnCount: number
    readonly declaredDone: boolean | undefined
}

type RepairSnapshot = {
    readonly status: Team["status"]
    readonly activeTask: ActiveTask | undefined
    readonly lastInterruptedTask: ActiveTask | undefined
    readonly members: readonly MemberSnapshot[]
}

function isWorkflowTask(task: ActiveTask | undefined): task is WorkflowTask {
    return task?.type === "workflow"
}

function stepIndexFromArg(step: WorkflowFixStepArg | undefined, task: WorkflowTask): number | null {
    if (typeof step === "number") return step - 1
    if (typeof step === "string") {
        const found = task.steps?.findIndex(workflowStep => workflowStep.id === step) ?? -1
        return found >= 0 ? found : null
    }
    return task.activeStepIndices?.[0] ?? task.currentStageIndex
}

function isActiveWorkflowStep(task: WorkflowTask, index: number): boolean {
    return getActiveWorkflowStepIndices(task).includes(index)
}

function cloneActiveTask(task: ActiveTask | undefined): ActiveTask | undefined {
    if (task === undefined) return undefined
    return structuredClone(task)
}

function snapshotTeam(team: Team): RepairSnapshot {
    return {
        status: team.status,
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

function restoreSnapshot(team: Team, snapshot: RepairSnapshot): void {
    team.status = snapshot.status
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

function workflowRepairTarget(team: Team): WorkflowRepairTarget | null {
    if (team.status === "busy" && isWorkflowTask(team.activeTask)) return { task: team.activeTask }
    if (team.status === "failed" && isWorkflowTask(team.lastInterruptedTask)) {
        team.activeTask = team.lastInterruptedTask
        team.status = "busy"
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

function validateWorkflowAfterFix(task: WorkflowTask): string | null {
    const check = checkWorkflowInvariants(task)
    return check.ok ? null : `Error: workflow invariant violation after fix: ${check.violations.join("; ")}`
}

function sanitizeReason(reason: string | undefined): string {
    return reason?.trim() ? reason.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 80) : "operator_fix"
}

async function applyRedispatch(ctx: PluginContext, team: Team, task: WorkflowTask, step: WorkflowFixStepArg | undefined): Promise<string> {
    const index = stepIndexFromArg(step, task)
    if (index === null) return "Error: workflow has no active step to redispatch"
    const workflowStep = task.steps?.[index]
    if (workflowStep === undefined) return `Error: step ${index + 1} does not exist`
    if (!isActiveWorkflowStep(task, index)) return `Error: step ${index + 1} is not in the active workflow frontier`
    if (workflowStep.completed) return `Error: step ${index + 1} is already completed`
    workflowStep.dispatchedAt = undefined
    const dispatched = await redispatchWorkflowStep(ctx, team, index)
    if (!dispatched) return `Error: step ${index + 1} cannot be redispatched`
    const invariantError = validateWorkflowAfterFix(task)
    if (invariantError !== null) return invariantError
    await saveTeamState(team)
    return `team_fix_workflow redispatched step ${index + 1}.`
}

async function applySkip(ctx: PluginContext, team: Team, task: WorkflowTask, step: WorkflowFixStepArg | undefined): Promise<string> {
    const index = stepIndexFromArg(step, task)
    if (index === null) return "Error: workflow has no active step to skip"
    const workflowStep = task.steps?.[index]
    if (workflowStep === undefined) return `Error: step ${index + 1} does not exist`
    if (!isActiveWorkflowStep(task, index)) return `Error: step ${index + 1} is not in the active workflow frontier`
    if (workflowStep.kind === "fanout" || workflowStep.kind === "join") return `Error: step ${index + 1} marker steps cannot be skipped directly`
    workflowStep.completed = true
    workflowStep.skipped = true
    workflowStep.dispatchedAt = undefined
    await advanceWorkflowStep(ctx, team)
    if (team.activeTask?.type === "workflow") {
        const invariantError = validateWorkflowAfterFix(team.activeTask)
        if (invariantError !== null) return invariantError
    }
    await saveTeamState(team)
    return `team_fix_workflow skipped step ${index + 1}.`
}

async function applyAdvance(ctx: PluginContext, team: Team): Promise<string> {
    await advanceWorkflowStep(ctx, team)
    if (team.activeTask?.type === "workflow") {
        const invariantError = validateWorkflowAfterFix(team.activeTask)
        if (invariantError !== null) return invariantError
    }
    await saveTeamState(team)
    return "team_fix_workflow advanced workflow."
}

async function applyFail(ctx: PluginContext, team: Team, reason: string | undefined): Promise<string> {
    const safeReason = sanitizeReason(reason)
    await finishRun(ctx, team, workflowOperatorFailReason(safeReason), "failed")
    await saveTeamState(team)
    return `team_fix_workflow failed workflow with reason ${workflowOperatorFailReason(safeReason)}.`
}

async function applyWorkflowFix(ctx: PluginContext, team: Team, op: FixWorkflowOp, step: WorkflowFixStepArg | undefined, reason: string | undefined, toMember: string | undefined): Promise<string> {
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

async function applyReassign(ctx: PluginContext, team: Team, task: WorkflowTask, step: WorkflowFixStepArg | undefined, toMember: string | undefined): Promise<string> {
    if (toMember === undefined) return "Error: team_fix_workflow op='reassign' requires `to_member`"
    const index = stepIndexFromArg(step, task)
    if (index === null) return "Error: workflow has no active step to reassign"
    const workflowStep = task.steps?.[index]
    if (workflowStep === undefined) return `Error: step ${index + 1} does not exist`
    if (!isActiveWorkflowStep(task, index)) return `Error: step ${index + 1} is not in the active workflow frontier`
    if (workflowStep.kind === "fanout" || workflowStep.kind === "join") return `Error: step ${index + 1} marker steps cannot be reassigned`

    const currentActor = workflowStep.kind === "task" ? workflowStep.member : workflowStep.verifier
    if (currentActor === toMember) return `Error: step ${index + 1} is already owned by "${toMember}"`
    const newMember = team.members.find(m => m.name === toMember && !m.isMaster)
    if (newMember === undefined) return `Error: "${toMember}" is not a team member`
    if (newMember.sessionId === undefined || newMember.status === "errored") return `Error: "${toMember}" has no live session`

    // Fanout branch actor uniqueness: the new actor must not already be active
    // in a sibling branch (reuses the same rule as fanout validation).
    if (workflowStep.branch !== undefined) {
        const conflict = activeBranchActorConflict(task, toMember, index)
        if (conflict !== null) return `Error: "${toMember}" is already active in branch "${conflict}"`
    }

    if (workflowStep.kind === "task") workflowStep.member = toMember
    else workflowStep.verifier = toMember
    workflowStep.dispatchedAt = undefined
    workflowStep.correlationId = undefined

    const dispatched = await redispatchWorkflowStep(ctx, team, index)
    if (!dispatched) return `Error: step ${index + 1} cannot be redispatched to "${toMember}"`
    const invariantError = validateWorkflowAfterFix(task)
    if (invariantError !== null) return invariantError
    await saveTeamState(team)
    return `team_fix_workflow reassigned step ${index + 1} to "${toMember}".`
}

function activeBranchActorConflict(task: WorkflowTask, candidateMember: string, excludeIndex: number): string | null {
    for (const activeIndex of getActiveWorkflowStepIndices(task)) {
        if (activeIndex === excludeIndex) continue
        const step = task.steps?.[activeIndex]
        const actor = step === undefined ? undefined : (step.kind === "task" ? step.member : step.verifier)
        if (actor === candidateMember && step?.branch !== undefined) return step.branch.branchId
    }
    return null
}

async function dispatchWorkflowFixOp(ctx: PluginContext, team: Team, task: WorkflowTask, op: FixWorkflowOp, step: WorkflowFixStepArg | undefined, reason: string | undefined, toMember: string | undefined): Promise<string> {
    switch (op) {
        case "redispatch":
            return await applyRedispatch(ctx, team, task, step)
        case "skip":
            return await applySkip(ctx, team, task, step)
        case "advance":
            return await applyAdvance(ctx, team)
        case "fail":
            return await applyFail(ctx, team, reason)
        case "reassign":
            return await applyReassign(ctx, team, task, step, toMember)
        default:
            op satisfies never
            return "Error: unsupported workflow fix operation"
    }
}

export function teamFixWorkflowTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Master-only workflow repair tool. Redispatch, skip, advance, or fail a busy or interrupted team_workflow run without cancelling the whole team.",
        args: {
            team_id: tool.schema.string().min(1),
            op: tool.schema.enum(["redispatch", "skip", "advance", "fail", "reassign"]),
            step: tool.schema.union([tool.schema.number().int().min(1), tool.schema.string().min(1)]).optional().describe("1-based workflow step number or stable step id to repair. Defaults to the first active frontier step for redispatch/skip/reassign."),
            reason: tool.schema.string().min(1).max(200).optional().describe("operator reason used by op='fail'"),
            to_member: tool.schema.string().min(1).optional().describe("target member name for op='reassign' (must be a live team member)"),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id, { requireActive: false })
            if (!caller) return "Error: caller is not a member of this team"
            if (!caller.isMaster) return "Error: team_fix_workflow is master-only"
            const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)
            const gate = activationError(team.teamName, team.activatedAt)
            if (gate) return gate

            let result = ""
            await team.mutex.runExclusive(async () => {
                const snapshot = snapshotTeam(team)
                result = await applyWorkflowFix(ctx, team, args.op, args.step, args.reason, args.to_member)
                if (result.startsWith("Error:")) {
                    restoreSnapshot(team, snapshot)
                    await saveTeamState(team)
                }
            })
            return result
        },
    })
}

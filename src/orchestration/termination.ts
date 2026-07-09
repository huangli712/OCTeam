/**
 * Termination checks. Enforces wall-clock timeout,
 * token budget, and member-error exit conditions. Called from processIdle after
 * each dispatch AND from the sweep timer so these conditions fire even with no
 * idle events arriving.
 */

import type { PluginContext } from "../core/context.js"
import type { WorkflowStep, WorkflowTask } from "../core/types.js"
import { getActiveWorkflowStepActors } from "./dag.js"
import type { Team } from "../state/store.js"
import { finishRun } from "./summary.js"
import { advanceWorkflowStep, redispatchWorkflowStep } from "./workflow.js"
import { markWorkflowFanoutBranchErrored } from "./fanout.js"
import {
    workflowNoSessionReason,
    workflowTimeoutStepReason,
} from "./reasons.js"

/**
 * Check the active task's termination conditions and, if met, deliver a summary
 * to the leader and tear down the active task. No-op if no active task.
 */
export async function checkTermination(ctx: PluginContext, team: Team, now = Date.now()): Promise<void> {
    const task = team.activeTask
    if (!task) return

    // Wall-clock timeout. Human approval pauses suspend wall-clock accounting;
    // team_approve/team_reject shifts startedAt by the paused duration on resume.
    if (!task.approvalStage && now - task.startedAt > task.wallClockTimeoutMs) {
        await finishRun(ctx, team, "timeout", "failed")
        return
    }

    if (task.type === "workflow" && await checkWorkflowStepTimeouts(ctx, team, task, now)) return

    // Token budget
    if (task.tokenBudget !== undefined && task.tokensUsed > task.tokenBudget) {
        await finishRun(ctx, team, "budget_exceeded", "failed")
        return
    }

    // Member turn limit: stop a runaway member. turnCount is
    // bumped at each dispatch; once it exceeds the bound the orchestration is failed.
    const overTurns = team.members.find(
        m => !m.isMaster && m.turnCount > team.bounds.maxMemberTurns,
    )
    if (overTurns) {
        await finishRun(ctx, team, `member_turn_limit:${overTurns.name}`, "failed")
        return
    }

    // Member error (tolerance-aware fail-fast). Concurrent modes (parallel/
    // delegate) tolerate up to maxErroredMembers; the barrier (handleParallelIdle)
    // / handleDelegateIdle owns succeed-with-survivors. checkTermination owns ONLY
    // the fail decisions: all-errored, or over-tolerance. Sequential modes
    // (pipeline/loop/consensus) get tolerance 0 — one active member, no survivors.
    const erroredMembers = team.members.filter(m => !m.isMaster && m.status === "errored")
    if (erroredMembers.length > 0) {
        if (task.type === "workflow") {
            const activeActors = new Set(getActiveWorkflowStepActors(task))
            for (const member of erroredMembers) {
                if (!activeActors.has(member.name)) continue
                const result = markWorkflowFanoutBranchErrored(task, member.name)
                switch (result.kind) {
                    case "within_tolerance":
                        continue
                    case "failed":
                        await finishRun(ctx, team, result.reason, "failed")
                        return
                    case "not_fanout":
                        await finishRun(ctx, team, `member_error:${member.name}:${member.error ?? "unknown"}`, "failed")
                        return
                    default:
                        result satisfies never
                }
            }
            return
        }
        // Arena scopes errored-member handling per phase:
        // erroredMembers is ALL non-master errored members, so a candidate that
        // errored WITHIN tolerance during implement still lingers here during
        // evaluate. A naive "any errored → fail" would spuriously kill a healthy
        // evaluate phase, so each phase is scoped precisely. Return after the arena
        // branch so the generic concurrent block never runs for arena.
        if (task.type === "arena") {
            if (task.arenaPhase === "evaluate") {
                // Evaluate is evaluator-strict: fail ONLY when the evaluator errored.
                // Tolerated candidate errors lingering from implement are ignored.
                if (erroredMembers.some(m => m.name === task.evaluatorMember)) {
                    await finishRun(ctx, team, "arena_failed:evaluator_error", "failed")
                }
                return
            }
            // Implement phase: candidate-count tolerance, SAME ordered branching as
            // the 2b barrier (the two MUST NOT diverge on the reason string). An
            // errored evaluator during implement is ignored here (it is live-checked
            // at start-evaluate, 2b).
            const erroredCandidates = erroredMembers.filter(m => task.candidates.includes(m.name))
            const tolerance = task.maxErroredMembers ?? 0
            const survivors = task.candidates.length - erroredCandidates.length
            if (survivors === 0) {
                await finishRun(ctx, team, "arena_failed:no_survivors", "failed")
            } else if (erroredCandidates.length > tolerance) {
                await finishRun(ctx, team, `arena_failed:member_error:${erroredCandidates[0].name}`, "failed")
            }
            // within tolerance with survivors → NO-OP; the barrier delivers survivors.
            return
        }
        const concurrent = task.type === "parallel" || task.type === "delegate" || task.type === "recurse"
        const tolerance = concurrent ? (task.maxErroredMembers ?? 0) : 0
        const survivors = team.members.filter(m => !m.isMaster).length - erroredMembers.length
        if (erroredMembers.length > tolerance || survivors === 0) {
            const first = erroredMembers[0]
            await finishRun(ctx, team, `member_error:${first.name}:${first.error ?? "unknown"}`, "failed")
            return
        }
        // within tolerance with survivors → NO-OP. The barrier delivers survivors.
    }
}

async function checkWorkflowStepTimeouts(ctx: PluginContext, team: Team, task: WorkflowTask, now: number): Promise<boolean> {
    const steps = task.steps ?? []
    const activeStepIndices = task.activeStepIndices ?? [task.currentStageIndex]
    for (const index of activeStepIndices) {
        const step = steps[index]
        if (step === undefined || step.completed || step.timeoutMs === undefined || step.dispatchedAt === undefined) continue
        if (now - step.dispatchedAt < step.timeoutMs) continue
        await handleWorkflowStepTimeout(ctx, team, task, step, index, now)
        return true
    }
    return false
}

async function handleWorkflowStepTimeout(ctx: PluginContext, team: Team, task: WorkflowTask, step: WorkflowStep, index: number, now: number): Promise<void> {
    const policy = step.onTimeout ?? "fail"
    if (step.branch !== undefined) {
        const actor = workflowStepActor(step)
        if (actor === undefined) {
            await finishRun(ctx, team, workflowTimeoutStepReason(index + 1), "failed")
            return
        }
        const result = markWorkflowFanoutBranchErrored(task, actor)
        switch (result.kind) {
            case "within_tolerance":
                await advanceWorkflowStep(ctx, team)
                return
            case "failed":
                await finishRun(ctx, team, result.reason, "failed")
                return
            case "not_fanout":
                await finishRun(ctx, team, workflowTimeoutStepReason(index + 1), "failed")
                return
            default:
                result satisfies never
                return
        }
    }
    switch (policy) {
        case "fail":
            await finishRun(ctx, team, workflowTimeoutStepReason(index + 1), "failed")
            return
        case "skip":
            step.completed = true
            step.skipped = true
            step.dispatchedAt = undefined
            await advanceWorkflowStep(ctx, team)
            return
        case "retry": {
            step.timeoutAttempts = (step.timeoutAttempts ?? 0) + 1
            if (step.timeoutAttempts > (step.maxTimeoutRetries ?? 0)) {
                await finishRun(ctx, team, workflowTimeoutStepReason(index + 1), "failed")
                return
            }
            step.dispatchedAt = undefined
            if (!await redispatchWorkflowStep(ctx, team, index)) {
                await finishRun(ctx, team, workflowNoSessionReason(workflowStepActor(step)), "failed")
            }
            step.dispatchedAt = now
            return
        }
        default:
            policy satisfies never
    }
}

function workflowStepActor(step: WorkflowStep): string | undefined {
    switch (step.kind) {
        case "task":
            return step.dispatchedActor ?? step.member
        case "gate":
            return step.dispatchedActor ?? step.verifier
        case "fanout":
        case "join":
            return undefined
        default:
            step.kind satisfies never
            return undefined
    }
}

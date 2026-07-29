/**
 * Termination checks. Enforces wall-clock timeout,
 * token budget, and member-error exit conditions. Called from processIdle after
 * each dispatch AND from the sweep timer so these conditions fire even with no
 * idle events arriving.
 */

import type { PluginContext } from "../../core/context.js"
import type { WorkflowStep, WorkflowTask } from "../../core/types.js"
import { getActiveWorkflowStepActors } from "../workflow/dag.js"
import type { Team } from "../../state/store.js"
import { finishRun } from "../control/completion.js"
import { advanceWorkflowStep, redispatchWorkflowStep } from "../workflow/engine.js"
import { markWorkflowFanoutBranchErrored } from "../workflow/fanout.js"
import {
    workflowNoSessionReason,
    workflowTimeoutStepReason,
} from "../workflow/reasons.js"
import { nonMasterMembers } from "../../tools/support.js"

/**
 * Check the active task's termination conditions and, if met, deliver a summary
 * to the leader and tear down the active task. No-op if no active task.
 */
export async function checkTermination(
    ctx: PluginContext,
    team: Team,
    now = Date.now(),
): Promise<void> {
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
        // H7: if signoff is in progress, the signoff handler owns errored-
        // reviewer handling (signoff.ts excludes errored reviewers from
        // quorum). Pre-fix code let the generic task-type handler fire first
        // — for non-workflow tasks, a single reviewer error would terminate
        // the ENTIRE run, bypassing signoff's peer-quorum tolerance.
        if (task.signoffStage) return
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
            // Implement phase: candidate-count tolerance. The reason strings here
            // MUST match handleArenaIdle's barrier branching — divergence would
            // confuse the leader with different failure reasons for the same
            // condition. An errored evaluator during implement is ignored here
            // (it is live-checked when the evaluate phase starts).
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
        const concurrent = task.type === "parallel" || task.type === "delegate" || task.type === "recurse" || task.type === "quorum"
        const tolerance = concurrent ? (task.maxErroredMembers ?? 0) : 0
        // For quorum, scope error/survivor counts to task.participants so
        // non-participant errored members do not consume the tolerance budget.
        // survivors = relevant members NOT in errored state.
        // Tolerance-0 sequential modes fail on the FIRST error, so a stale
        // errored member from a prior stage cannot exist (the run would have
        // already terminated).
        const relevantErrored = task.type === "quorum" && task.participants
            ? erroredMembers.filter(m => task.participants!.includes(m.name))
            : erroredMembers
        const relevantTotal = task.type === "quorum" && task.participants
            ? task.participants!.length
            : nonMasterMembers(team).length
        const survivors = relevantTotal - relevantErrored.length
        if (relevantErrored.length > tolerance || survivors === 0) {
            const first = relevantErrored[0] ?? erroredMembers[0]
            await finishRun(ctx, team, `member_error:${first.name}:${first.error ?? "unknown"}`, "failed")
            return
        }
        // within tolerance with survivors → NO-OP. The barrier delivers survivors.
    }
}

/**
 * Check each active workflow step for timeout expiration. If any step timed
 * out, delegate to handleWorkflowStepTimeout and return true so the caller
 * skips the remaining generic checks (a timeout already ended or advanced
 * the run). Returns false when no timeout fired.
 */
async function checkWorkflowStepTimeouts(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    now: number,
): Promise<boolean> {
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

/**
 * Handle a single workflow step's timeout. Fanout-branch steps isolate the
 * timed-out actor via markWorkflowFanoutBranchErrored; linear steps apply the
 * step's on_timeout policy (fail / skip / retry).
 */
async function handleWorkflowStepTimeout(
    ctx: PluginContext,
    team: Team,
    task: WorkflowTask,
    step: WorkflowStep,
    index: number,
    now: number,
): Promise<void> {
    const policy = step.onTimeout ?? "fail"
    if (step.branch !== undefined) {
        const actor = workflowTimeoutStepActor(step)
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
                await finishRun(ctx, team, workflowNoSessionReason(workflowTimeoutStepActor(step)), "failed")
                return
            }
            step.dispatchedAt = now
            return
        }
        default:
            policy satisfies never
    }
}

/**
 * Resolve the actor name for a workflow step in the timeout context.
 *
 * Differs from the general-purpose workflowStepActor (dag.ts): join is
 * deliberately treated as no-actor (returns undefined), because a join is a
 * convergence point — on timeout the run should fail directly rather than
 * treat the reducer as a branch member to mark errored.
 */
function workflowTimeoutStepActor(step: WorkflowStep): string | undefined {
    switch (step.kind) {
        case "task":
            return step.dispatchedActor ?? step.member
        case "gate":
            return step.dispatchedActor ?? step.verifier
        case "fanout":
        case "join":
            return undefined
        default:
            step satisfies never
            return undefined
    }
}

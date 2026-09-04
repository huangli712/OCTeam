/**
 * approval_after on a workflow gate pauses BEFORE
 * the gate is marked completed.
 *
 * Bug: handleGatePass (verdict.ts:347) calls maybePauseAfterWorkflowStep
 * BEFORE resetStepAfterCompletion (verdict.ts:373). When approval is
 * requested, the function returns early — the gate step is NOT marked
 * completed. After the master approves, applyApprovalDecision calls
 * advanceWorkflowStep, which sees the un-completed gate as the active
 * step and re-processes it. In a linear workflow the verifier is
 * re-dispatched; in a DAG workflow the stale dispatchedAt keeps the step
 * waiting forever.
 *
 * Constraint: an earlier guard requires resetStepAfterCompletion NOT to run
 * before the gotoIdx === -2 (unevaluable where) check, because a completed
 * gate is skipped by the idle router, deadlocking the retry_verifier path.
 * However, approval_after is validator-guaranteed incompatible with
 * on_*_goto (see verdict.ts:345-346 comment), so the gotoIdx === -2 branch
 * is unreachable when maybePauseAfterWorkflowStep fires. It is therefore
 * safe to mark the gate completed before the approval pause.
 *
 * Fix: move resetStepAfterCompletion to BEFORE maybePauseAfterWorkflowStep,
 * but only on the approval_after path (when step.approvalAfter is set).
 * The general gate-PASS path (no approval_after) retains that ordering.
 */
import { describe, expect, test } from "bun:test"

import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import type { WorkflowStep } from "../src/core/types.js"
import { makeCtx, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js"

const PASS_V = '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>'

function memberByName(team: ReturnType<typeof makeTeam>, name: string) {
    const m = team.members.find(c => c.name === name)
    if (!m) throw new Error(`Missing fixture member: ${name}`)
    return m
}

describe("approval_after marks gate completed before pausing", () => {
    test("gate with approvalAfter is marked completed when pause fires", async () => {
        const calls: DispatchCall[] = []
        const steps: WorkflowStep[] = [
            { kind: "task", member: "alice", task: "do work", completed: true, output: "done" },
            {
                kind: "gate",
                verifier: "bob",
                criteria: "quality check",
                onFail: "fail",
                approvalAfter: true,
                completed: false,
            },
            { kind: "task", member: "erin", task: "final step", completed: false },
        ]
        const task = makeWorkflowTask({
            steps,
            currentStageIndex: 1,
            responses: { alice: "done", bob: PASS_V },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "erin", sessionId: "ses_erin" },
            ],
        })
        const ctx = makeCtx({ outputs: { ses_bob: PASS_V }, calls })

        // bob idles with a PASS verdict → handleGatePass → approval pause.
        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob")

        // The approval must have been requested.
        expect(task.approvalStage).toBeDefined()
        expect(task.approvalRequest?.kind).toBe("workflow_step")

        // The gate step MUST be marked completed BEFORE the pause.
        // On UNFIXED code: step.completed is false (resetStepAfterCompletion
        // runs after maybePauseAfterWorkflowStep, which returned early).
        // On FIXED code: step.completed is true.
        expect(task.steps![1].completed).toBe(true)

        // dispatchedAt must be cleared so advanceWorkflowStep after approval
        // does not see a stale dispatch marker.
        expect(task.steps![1].dispatchedAt).toBeUndefined()
    })

    test("gate WITHOUT approvalAfter still defers completion past gotoIdx check", async () => {
        // Control: gates without approvalAfter must retain the original
        // ordering (reset only after the gotoIdx === -2 check). This test
        // confirms the approval_after fix does not regress it.
        const calls: DispatchCall[] = []
        const steps: WorkflowStep[] = [
            { kind: "task", member: "alice", task: "do work", completed: true, output: "done" },
            {
                kind: "gate",
                verifier: "bob",
                criteria: "quality check",
                onFail: "fail",
                // No approvalAfter — the original ordering applies.
                completed: false,
            },
            { kind: "task", member: "erin", task: "final step", completed: false },
        ]
        const task = makeWorkflowTask({
            steps,
            currentStageIndex: 1,
            responses: { alice: "done", bob: PASS_V },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "erin", sessionId: "ses_erin" },
            ],
        })
        const ctx = makeCtx({ outputs: { ses_bob: PASS_V }, calls })

        await processIdle(ctx, team, memberByName(team, "bob"), "ses_bob")

        // No approval pause (no approvalAfter).
        expect(task.approvalStage).toBeUndefined()
        // Gate completed and advanced to erin.
        expect(task.steps![1].completed).toBe(true)
        expect(calls.some(c => c.sessionId === "ses_erin")).toBe(true)
    })
})

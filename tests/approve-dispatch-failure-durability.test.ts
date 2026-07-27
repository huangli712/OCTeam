/**
 * H-13 regression: applyApprovalDecision must keep the approval resolved in
 * memory AND on disk when the post-resolution dispatch throws. Pre-fix code
 * restored approvalStage/approvalRequest back to the pending shape in the
 * catch block, but the disk already held the resolved state. On retry the
 * master re-approved the SAME request, re-dispatching branches that had
 * partially completed — duplicate prompts and double-advancement.
 *
 * Fix: catch block restores only startedAt (a pure wall-clock adjustment
 * that is meaningless without a successful dispatch). approvalStage /
 * approvalRequest stay undefined (resolved), so the next approve call finds
 * no pending approval and returns "no pending approval" instead of
 * re-running the dispatch.
 */
import { describe, expect, test } from "bun:test"

import { applyApprovalDecision } from "../src/tools/control/approve.js"
import type { ActiveTask } from "../src/core/types.js"
import { makeCtx, makeTeam, tmpRoot } from "./helpers.js"

describe("H-13: approval resolution stays durable across dispatch failure", () => {
    test("dispatch failure leaves approvalStage cleared (resolved), not reverted to pending", async () => {
        // Build a team with a pending approval pause. Use the workflow_step
        // approval kind — it calls advanceWorkflowStep which dispatches the
        // next task step. We make that dispatch throw by installing a
        // promptAsync that rejects.
        const task: ActiveTask = {
            type: "workflow",
            startedAt: Date.now() - 1000,
            wallClockTimeoutMs: 300_000,
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            responses: {},
            stages: [],
            currentStageIndex: 0,
            decisionHistory: [],
            decisionParseFailures: 0,
            runId: "r-h13",
            signoffPolicy: "none",
            humanApproval: true,
            approvalStage: true,
            approvalRequest: {
                id: "approval-h13",
                kind: "workflow_step",
                stage: 0,
                requestedAt: Date.now() - 500,
                summary: "approve to advance",
            },
            steps: [
                { kind: "task", member: "alice", task: "next work", completed: false } as never,
            ],
        } as ActiveTask
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const throwingPromptAsync = async (): Promise<never> => {
            throw new Error("synthesized dispatch failure")
        }
        const ctx = makeCtx({
            storageRoot: tmpRoot("h13-approve"),
            promptAsync: throwingPromptAsync as never,
        })

        // applyApprovalDecision should throw because the dispatch fails.
        await expect(applyApprovalDecision(ctx, team, {
            id: "approval-h13",
            approved: true,
        })).rejects.toThrow(/synthesized dispatch failure/)

        // H-13 contract: approvalStage / approvalRequest stay CLEARED. The
        // master cannot re-approve the same request because it is no longer
        // pending. Pre-fix: these reverted to the saved pending values.
        expect(task.approvalStage).toBeUndefined()
        expect(task.approvalRequest).toBeUndefined()

        // A second applyApprovalDecision call returns the "no pending" error
        // rather than re-running the dispatch (which would duplicate prompts).
        const secondResult = await applyApprovalDecision(ctx, team, {
            id: "approval-h13",
            approved: true,
        })
        expect(secondResult).toMatch(/no pending human approval/i)
    })
})

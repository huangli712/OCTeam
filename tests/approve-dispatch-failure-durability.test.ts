/**
 * Approval resolution semantics on dispatch failure.
 *
 * Dispatch failure now leaves approvalStage as PENDING so the master can
 * retry. Earlier code cleared approvalStage on failure, which permanently
 * stuck the run (no way to re-approve after a transient dispatch error).
 * The original duplicate-dispatch concern is now mitigated by the
 * dispatchedActor/dispatchedAt idempotency guard in the workflow engine: a
 * re-approve after a failed dispatch finds the step already marked
 * dispatched and skips the duplicate promptAsync call.
 *
 * This test matches the current contract: approval stays pending after a
 * dispatch failure, and a second approve attempt re-tries the dispatch
 * (not "no pending" as in the earlier behavior).
 */
import { describe, expect, test } from "bun:test"

import { applyApprovalDecision } from "../src/tools/control/approve.js"
import type { ActiveTask } from "../src/core/types.js"
import { makeCtx, makeTeam, tmpRoot } from "./helpers.js"

describe("approval resolution stays durable across dispatch failure", () => {
    test("dispatch failure leaves approval pending for retry", async () => {
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
            approved: true,
        })).rejects.toThrow(/synthesized dispatch failure/)

        // Contract: approvalStage / approvalRequest stay PENDING so the
        // master can retry after a transient dispatch failure. Earlier code
        // cleared these, permanently sticking the run.
        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest).toBeDefined()

        // A second applyApprovalDecision re-tries the dispatch (not "no
        // pending" — the approval is still pending for retry).
        await expect(applyApprovalDecision(ctx, team, {
            approved: true,
        })).rejects.toThrow(/synthesized dispatch failure/)
    })
})

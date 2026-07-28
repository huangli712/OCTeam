/**
 * HIGH-B regression: when a member idles with fresh output AND has unread
 * mailbox messages, the handler MUST run BEFORE the wake-hint short-circuit.
 * Pre-fix code returned early on unread > 0, leaving the just-captured output
 * in task.responses[member]. The next turn (triggered by wake-hint) captures
 * the mailbox reply content and OVERWRITES task.responses[member], so the
 * handler reads the wrong content.
 *
 * The reduce stage is the most visible victim: reducer's output is in
 * task.responses[reducer] (not a side-channel like signoff), and
 * handleReduceIdle uses it directly as the reduced result.
 */
import { describe, expect, test } from "bun:test"

import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import { writeRawInboxLine } from "./helpers.js"
import type { ActiveTask, WorkflowTask } from "../src/core/types.js"
import { makeCtx, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js"

describe("HIGH-B: handler runs before wake-hint when capturedNew=true", () => {
    test("reduce-stage reducer with unread mailbox: handler processes output before wake-hint overwrites", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            type: "parallel",
            mode: "cooperative",
            reduceStage: true,
            reducerMember: "alice",
            reducePolicy: "summary",
            responses: { bob: "bob work", carol: "carol work" },
        } as unknown as Partial<WorkflowTask>) as unknown as ActiveTask
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        })

        // Seed an unread message in alice's inbox so countUnreadMessages > 0.
        await writeRawInboxLine(team.directory, "alice", JSON.stringify({
            version: 1, id: "msg-1", from: "bob", to: "alice",
            kind: "message", body: "mailbox reply (not reduce output)",
            timestamp: Date.now(), deliveryStatus: "pending",
        }))

        // Alice produces the reduce output and idles. Her output is "REDUCED RESULT".
        const ctx = makeCtx({
            outputs: { ses_alice: "REDUCED RESULT" },
            calls,
        })

        await processIdle(ctx, team, team.members[0], "ses_alice")

        // HIGH-B contract: handleReduceIdle MUST have run with the correct
        // output. The run should complete (finishRun) with the reduced result.
        // Pre-fix: wake-hint returned early, handler never ran, task stayed
        // busy with reduceStage=true, and the next turn would overwrite
        // task.responses[alice] with "mailbox reply (not reduce output)".
        expect(team.status).toBe("idle") // finishRun sets status to "idle" on success
        expect(team.activeTask).toBeUndefined() // finishRun clears activeTask
        // The reduced result should be present in the run record / delivery.
        // We verify via the dispatch calls: the leader should have received
        // the reduced result, not the mailbox reply.
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("REDUCED RESULT")
        expect(leaderCall!.text).not.toContain("mailbox reply")
    })
})

/**
 * Regression: maybeRequestApproval must rollback the in-memory
 * approvalStage/approvalRequest when saveTeamState fails. Pre-fix code set
 * those fields, called saveTeamState, and let any throw propagate — the
 * team was left with activeTask.approvalStage=true in memory but no pause
 * on disk. The orchestrator then idled indefinitely because the task looked
 * paused but team_resume had nothing to resume.
 *
 * The fix wraps saveTeamState in try/catch: on failure, the in-memory pause
 * fields are cleared and the original error is re-thrown.
 */
import { describe, expect, test } from "bun:test"

import { maybeRequestApproval } from "../src/orchestration/control/approval.js"
import type { ActiveTask } from "../src/core/types.js"
import { makeCtx, makeTeam, tmpRoot } from "./helpers.js"

describe("maybeRequestApproval rolls back pause on save failure", () => {
    test("saveTeamState failure clears approvalStage/approvalRequest in memory", async () => {
        // Build a team whose state save will fail. We sabotage state.json
        // with a symlink so atomicWrite refuses (its leaf-symlink guard).
        const { rmSync, symlinkSync, writeFileSync } = await import("node:fs")
        const path = await import("node:path")
        const root = tmpRoot("h30-approval")
        const task: ActiveTask = {
            type: "parallel",
            startedAt: Date.now(),
            wallClockTimeoutMs: 300_000,
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            responses: {},
            stages: [],
            currentStageIndex: 0,
            decisionHistory: [],
            decisionParseFailures: 0,
            runId: "r-h30",
            humanApproval: true,
        } as ActiveTask
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
            directory: root,
        })
        // Sabotage state.json: replace it with a symlink → atomicWrite refuses.
        const sp = path.join(root, "state.json")
        rmSync(sp, { force: true })
        const outside = path.join(root, "outside.json")
        writeFileSync(outside, "{}")
        symlinkSync(outside, sp)

        const ctx = makeCtx({ storageRoot: root })

        // maybeRequestApproval should throw because saveTeamState fails.
        await expect(maybeRequestApproval(ctx, team, {
            kind: "workflow_step",
            stage: 0,
            summary: "approve to advance",
        })).rejects.toThrow(/symlink/i)

        // Contract: the in-memory pause fields MUST be cleared so the
        // orchestrator does not idle on a phantom pause. Pre-fix: these stayed
        // set, stranding the team.
        expect(task.approvalStage).toBeUndefined()
        expect(task.approvalRequest).toBeUndefined()
    })

    test("control: successful save leaves pause fields set", async () => {
        const root = tmpRoot("h30-approval-clean")
        const task: ActiveTask = {
            type: "parallel",
            startedAt: Date.now(),
            wallClockTimeoutMs: 300_000,
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            responses: {},
            stages: [],
            currentStageIndex: 0,
            decisionHistory: [],
            decisionParseFailures: 0,
            runId: "r-h30-clean",
            humanApproval: true,
        } as ActiveTask
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
            directory: root,
        })
        const ctx = makeCtx({ storageRoot: root })

        const paused = await maybeRequestApproval(ctx, team, {
            kind: "workflow_step",
            stage: 0,
            summary: "approve to advance",
        })

        expect(paused).toBe(true)
        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest).toBeDefined()
    })
})

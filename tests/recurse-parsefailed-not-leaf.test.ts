/**
 * Recurse marks rejected decomposition as a
 * successful leaf.
 *
 * Bug: handleRecurseIdle (recurse.ts:204-253) sets canDecompose based on
 * several conditions including `!dec.parseFailed`. When canDecompose is
 * false for ANY reason — parseFailed, too deep, too many subtasks, over
 * maxTasks — the else branch (line 242-253) treats the task as a leaf and
 * marks it completed with the member's output. This means a member who
 * emitted a MALFORMED <decompose> block (parseFailed=true) has its raw
 * output silently accepted as the task's final result — a false success.
 *
 * The cases where leaf-finalization IS correct:
 *   - No <decompose> tag at all (member solved directly)
 *   - Empty output (placeholder result)
 *
 * The cases where leaf-finalization is WRONG:
 *   - dec.parseFailed === true (malformed <decompose>)
 *   - depth >= maxDepth (decomposition rejected by cap)
 *   - dec.subtasks.length > maxSubtasks (too many subtasks)
 *   - tasks + subtasks > maxTasks (over task limit)
 *
 * Fix: when canDecompose is false due to parseFailed, re-dispatch the
 * member with feedback (like loop's parse-failure retry). The structural
 * caps (depth/subtasks/maxTasks) are harder — for now, log an event so
 * the false-success is observable. The parseFailed case is the most
 * dangerous (member explicitly tried to decompose but formatted it wrong).
 */
import { describe, expect, test } from "bun:test"

import { handleRecurseIdle } from "../src/orchestration/modes/recurse.js"
import { createTask, updateTask } from "../src/state/tasks.js"
import type { RecurseTask } from "../src/core/types.js"
import { makeCtx, makeTeam, type DispatchCall } from "./helpers.js"

function makeRecurseTask(opts: Partial<RecurseTask> = {}): RecurseTask {
    return {
        type: "recurse",
        startedAt: 0,
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        ...opts,
    } as RecurseTask
}

describe("recurse parseFailed decomposition NOT marked as completed leaf", () => {
    test("malformed <decompose> → task NOT completed, member re-dispatched with feedback", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeRecurseTask({
            responses: { alice: '<decompose>{"subtasks":[{"subject":""}]}</decompose>' },
        })
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice", status: "idle" }],
        })
        // alice claims a task.
        const t = await createTask(team.directory, { subject: "work", description: "do X" })
        await updateTask(team.directory, t.id, { status: "claimed", owner: "alice" })

        await team.mutex.runExclusive(async () => {
            await handleRecurseIdle(ctx, team, team.members[0])
        })

        // On UNFIXED code: task marked completed with the malformed output.
        // On FIXED code: task stays claimed/pending, alice re-dispatched.
        const after = await import("../src/state/tasks.js").then(m => m.getTask(team.directory, t.id))
        expect(after?.status).not.toBe("completed")
        // alice should have been re-dispatched with feedback.
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(true)
    })

    test("no <decompose> tag (direct solve) → completed leaf (control)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeRecurseTask({
            responses: { alice: "Here is the solution: 42" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice", status: "idle" }],
        })
        const t = await createTask(team.directory, { subject: "work", description: "do X" })
        await updateTask(team.directory, t.id, { status: "claimed", owner: "alice" })

        await team.mutex.runExclusive(async () => {
            await handleRecurseIdle(ctx, team, team.members[0])
        })

        const after = await import("../src/state/tasks.js").then(m => m.getTask(team.directory, t.id))
        expect(after?.status).toBe("completed")
        expect(after?.result).toContain("42")
    })
})

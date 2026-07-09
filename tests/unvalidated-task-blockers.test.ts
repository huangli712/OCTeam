/**
 * Regression test for confirmed finding "unvalidated-task-blockers".
 *
 * Bug: src/tools/task.ts:38 accepts arbitrary blocked_by strings
 * (tool.schema.array(tool.schema.string()) — no UUID format or existence
 * validation), and task.ts:81 persists them verbatim via createTask.
 * src/orchestration/delegate.ts:62 then requires every blocker to match a
 * completed task:
 *   t.blockedBy.every(id => tasks.find(x => x.id === id)?.status === "completed")
 * When a blocker ID is a typo or non-existent, tasks.find() returns undefined,
 * undefined?.status === "completed" is false → the blocker is NEVER satisfied
 * → the task is permanently unclaimable. In delegate mode this wedges the
 * team into a deadlock (all members idle, no claimable tasks).
 *
 * Fix: validate each blocked_by entry is a well-formed UUID AND references an
 * existing task, rejecting the creation if any entry fails.
 *
 * This test creates a task with a bogus blocked_by entry (a typo'd ID that
 * matches no task), then asserts:
 *   1. The creation is REJECTED (the fix should validate blockers).
 *   2. (harm demonstration) If created, the task is permanently unclaimable —
 *      delegate.ts:58-62 never considers it claimable because the bogus blocker
 *      never resolves to a completed task.
 *
 * On UNFIXED code: the creation succeeds (assertion 1 FAILS). On FIXED code:
 * the creation is rejected (assertion 1 PASSES).
 */

import { afterEach, describe, expect, test } from "bun:test"

import type { ToolContext } from "@opencode-ai/plugin"
import { teamTaskCreateTool } from "../src/tools/task.js"
import { createTask, getTask, listAllTasks } from "../src/state/tasks.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { indexMember, unindexSession } from "../src/state/resolve.js"
import { makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"


const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("unvalidated task blockers (finding: unvalidated-task-blockers)", () => {
    test("team_task_create with a non-existent blocked_by entry must be rejected", async () => {
        const root = tmpRoot("task-blockers")
        const leadSid = "ses_task_blockers"
        const aliceSid = "ses_task_blockers_alice"
        tracked.push(aliceSid)

        const alice = makeMember("alice", aliceSid)
        await initTeamState(root, makeState("alpha", leadSid, [alice]), leadSid)
        const team = await loadTeamState(root, "alpha", leadSid)
        indexMember(aliceSid, "alpha", "alice", leadSid, root)

        // Create one real completed task to use as a legit blocker.
        const realTask = await createTask(team.directory, { subject: "real", description: "d" })

        // --- Attempt to create a task with a BOGUS blocker (typo'd UUID that
        //     matches no task). Also mix in the legit one to show the bogus
        //     entry is the problem, not the array itself. ---
        const tool = teamTaskCreateTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            {
                team_id: "alpha",
                subject: "blocked-task",
                description: "depends on a typo'd task",
                blocked_by: [realTask.id, "00000000-0000-0000-0000-nonexist01"],
            },
            { sessionID: aliceSid } as unknown as ToolContext,
        )

        // --- ASSERT 1: creation must be REJECTED ---
        // On UNFIXED code: task.ts:81 persists the bogus blocker verbatim →
        // creation succeeds → result contains "Task created" → FAIL.
        // On FIXED code: validation rejects the non-existent blocker → result
        // contains "Error" → PASS.
        expect(result).toMatch(/Error:.*blocked_by|Error:.*blocker|Error:.*not.*found/i)
        expect(result).not.toMatch(/Task created/i)
    })

    test("harm: a task persisted with a bogus blocker is permanently unclaimable", async () => {
        // Directly demonstrates the downstream harm at delegate.ts:62 even if
        // the creation-bypass above were somehow worked around. We persist a
        // task with a bogus blocker via createTask (the internal API the tool
        // calls), then verify delegate's claimability predicate never passes.
        const root = tmpRoot("task-blockers-harm")
        const leadSid = "ses_task_blockers_harm"

        const alice = makeMember("alice")
        await initTeamState(root, makeState("alpha", leadSid, [alice]), leadSid)
        const team = await loadTeamState(root, "alpha", leadSid)

        // Persist a task with a bogus blocker (simulates what the unfixed
        // team_task_create allows through).
        await createTask(team.directory, {
            subject: "wedged",
            description: "blocked by a non-existent task",
            blockedBy: ["00000000-0000-0000-0000-nonexist01"],
        })

        // Load all tasks and apply delegate.ts:58-62's claimability predicate
        // directly: pending AND every blocker resolves to a completed task.
        const allTasks = await listAllTasks(team.directory)
        const claimable = allTasks.filter(
            t =>
                t.status === "pending"
                && t.blockedBy.every(id => allTasks.find(x => x.id === id)?.status === "completed"),
        )

        // The wedged task must NOT appear in claimable — but it IS pending,
        // so it sits forever in the task list without being claimable.
        // On UNFIXED code: the task exists but is unclaimable (0 claimable
        // despite 1 pending task) — the deadlock condition delegate.ts:69
        // would fire.
        expect(claimable).toHaveLength(0)

        // Confirm the task exists and is pending — it's not deleted, just
        // permanently stuck. This IS the harm: an unclaimable task wedges
        // delegate mode.
        const wedged = allTasks.find(t => t.subject === "wedged")
        expect(wedged).toBeDefined()
        expect(wedged!.status).toBe("pending")
        expect(wedged!.blockedBy).toContain("00000000-0000-0000-0000-nonexist01")
    })
})

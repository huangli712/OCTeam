/**
 * Regression test for confirmed finding "recurse-root-task-cap-bypass".
 *
 * Bug: src/tools/recurse.ts:60 calls createTask() to seed the root task
 * WITHOUT first checking that the shared task list has room under
 * team.bounds.maxTasks. The buildTask callback runs inside startOrchestration
 * (shared.ts:239) BEFORE any maxTasks guard. So starting recurse when the
 * shared task list is already at the cap creates one task OVER the limit.
 *
 * Contrast: team_task_create (task.ts:54) DOES check live tasks against
 * maxTasks before creating. recurse.ts bypasses that check entirely — it calls
 * createTask directly, not through the team_task_create tool.
 *
 * Fix: before createTask at recurse.ts:60, count live tasks via listAllTasks
 * and reject if `liveTasks >= team.bounds.maxTasks`.
 *
 * This test activates the team (required by startOrchestration), pre-fills the
 * shared task list to exactly maxTasks, then starts recurse, and asserts the
 * total never exceeds the cap. On UNFIXED code the root task is created → total
 * = maxTasks + 1 → FAIL. On FIXED code the creation is rejected → total stays
 * at maxTasks → PASS.
 */

import { afterEach, describe, expect, test } from "bun:test"

import type { ToolContext } from "@opencode-ai/plugin"
import { teamRecurseTool } from "../src/tools/recurse.js"
import { createTask, listAllTasks } from "../src/state/tasks.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { indexMasterTeam, indexMember, setActiveTeam, unindexSession } from "../src/state/resolve.js"
import { makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("recurse root task cap bypass (finding: recurse-root-task-cap-bypass)", () => {
    test("starting recurse when the task list is full must not exceed maxTasks", async () => {
        const root = tmpRoot("recurse-cap")
        const leadSid = "ses_recurse_cap"
        const aliceSid = "ses_recurse_cap_alice"
        tracked.push(leadSid, aliceSid)

        // --- Team with maxTasks=2, one member with a live session. ---
        const alice = makeMember("alice", aliceSid)
        const state = makeState("alpha", leadSid, [alice], Date.now()) // activatedAt = now
        state.bounds.maxTasks = 2
        await initTeamState(root, state, leadSid)
        const team = await loadTeamState(root, "alpha", leadSid)
        indexMasterTeam(leadSid, "alpha", leadSid, root, team.directory)
        setActiveTeam(leadSid, team.directory)
        indexMember(aliceSid, "alpha", "alice", leadSid, root)

        // --- Pre-fill the shared task list to exactly maxTasks (2). ---
        await createTask(team.directory, { subject: "seed-1", description: "d1" })
        await createTask(team.directory, { subject: "seed-2", description: "d2" })
        const liveBefore = (await listAllTasks(team.directory)).filter(t => t.status !== "deleted").length
        expect(liveBefore).toBe(2)

        // --- Start recurse. buildTask (recurse.ts:60) calls createTask for the
        //     root task WITHOUT checking maxTasks. ---
        const tool = teamRecurseTool(makeCtx({ storageRoot: root, promptAsync: async () => {} }))
        await tool.execute(
            {
                team_id: "alpha",
                task: "decompose and solve X",
                decomposer: "alice",
            },
            { sessionID: leadSid } as unknown as ToolContext,
        )

        // --- ASSERT: total live tasks must NOT exceed maxTasks (2) ---
        // On UNFIXED code: recurse.ts:60 creates the root task → 3 live → FAIL.
        // On FIXED code: rejected before createTask → 2 live → PASS.
        const liveAfter = (await listAllTasks(team.directory)).filter(t => t.status !== "deleted").length
        expect(liveAfter).toBeLessThanOrEqual(state.bounds.maxTasks)
    })
})

/**
 * Regression test for confirmed finding "task-create-limit-race".
 *
 * Bug: src/tools/task.ts:51 counts live tasks via listAllTasks() and
 * src/tools/task.ts:72 calls createTask() — these two operations are NOT
 * covered by a shared lock. Two concurrent team_task_create calls can both
 * read the same live-task count, both pass the maxTasks check, and both
 * create a task — bypassing team.bounds.maxTasks.
 *
 * createTask (state/tasks.ts:122) does a bare atomicWrite with no lock;
 * listAllTasks (tasks.ts:148) does a bare readdir. Neither is wrapped by
 * claimMutexPath or any team-level lock. Only claimTask (tasks.ts:233)
 * serializes under claimMutexPath — task creation does not.
 *
 * Fix: wrap the count + create sequence in a shared lock (e.g.
 * withLock(claimMutexPath(teamDirectory), ...)) so the check-then-act is
 * atomic across concurrent callers.
 *
 * This test sets maxTasks=2, pre-creates 1 task (boundary), fires two
 * concurrent team_task_create calls, and asserts the total never exceeds 2.
 * On UNFIXED code both reads see 1, both pass `1 >= 2`, both create → 3
 * tasks → FAIL. On FIXED code the shared lock serializes them: the second
 * caller sees 2 live tasks, is rejected → total stays 2 → PASS.
 */

import { afterEach, describe, expect, test } from "bun:test"

import type { ToolContext } from "@opencode-ai/plugin"
import { teamTaskCreateTool } from "../src/tools/task.js"
import { createTask, listAllTasks } from "../src/state/tasks.js"
import { initTeamState } from "../src/state/store.js"
import { indexMember, unindexSession } from "../src/state/resolve.js"
import { makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"


const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("task-create limit race (finding: task-create-limit-race)", () => {
    test("two concurrent team_task_create calls must not bypass maxTasks", async () => {
        const root = tmpRoot("task-limit-race")
        const leadSid = "ses_tlr_lead"
        const aliceSid = "ses_tlr_alice"
        tracked.push(aliceSid)

        // --- Team with maxTasks=2 and one indexed member ---
        const alice = makeMember("alice", aliceSid)
        const state = makeState("alpha", leadSid, [alice])
        state.bounds.maxTasks = 2
        await initTeamState(root, state, leadSid)
        const teamDir = `${root}/${leadSid}/teams/alpha`
        indexMember(aliceSid, "alpha", "alice", leadSid, root)

        // --- Pre-create 1 task so we're at the boundary (1 live, 1 allowed) ---
        await createTask(teamDir, { subject: "seed", description: "seed task" })
        expect((await listAllTasks(teamDir)).filter(t => t.status !== "deleted").length).toBe(1)

        // --- Fire two concurrent team_task_create calls. Both:
        //   1. resolveCallerInTeam (async, yields)
        //   2. loadTeamState (async, yields)
        //   3. listAllTasks → readdir → sees 1 live task (async, yields)
        //   4. pass `1 >= 2` → false (limit not reached)
        //   5. createTask → atomicWrite (async, yields)
        // Neither step 3→5 is under a shared lock, so both proceed past the
        // check before either write lands.
        const tool = teamTaskCreateTool(makeCtx({ storageRoot: root }))
        const [res1, res2] = await Promise.all([
            tool.execute(
                { team_id: "alpha", subject: "task-A", description: "desc-A" },
                { sessionID: aliceSid } as unknown as ToolContext,
            ),
            tool.execute(
                { team_id: "alpha", subject: "task-B", description: "desc-B" },
                { sessionID: aliceSid } as unknown as ToolContext,
            ),
        ])

        // --- ASSERT: total live tasks must NOT exceed maxTasks (2) ---
        // On UNFIXED code: both created → 3 live tasks → FAIL.
        // On FIXED code: one rejected → 2 live tasks → PASS.
        const liveTasks = (await listAllTasks(teamDir)).filter(t => t.status !== "deleted")
        expect(liveTasks.length).toBeLessThanOrEqual(2)
    })
})

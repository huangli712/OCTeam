/**
 * Coverage-gap tests for src/tools/task.ts — error paths in teamTaskCreateTool
 * and teamTaskUpdateTool that task-tools.test.ts doesn't reach:
 *   - team not found (line 46)
 *   - invalid blocked_by format (line 79)
 *   - non-existent blocked_by reference (line 81)
 *   - TaskAlreadyClaimedError (line 156-157)
 *   - MemberHoldsActiveTaskError (lines 159-161)
 */
import { afterAll, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import { teamTaskCreateTool, teamTaskUpdateTool } from "../src/tools/task.js"
import { initTeamState, invalidateTeam } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { createTask, listAllTasks } from "../src/state/tasks.js"
import { cleanupTmpRoots, makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

function makeCtx(storageRoot: string): PluginContext {
    return { storageRoot, scope: "project" } as unknown as PluginContext
}

async function setupTeam(root: string, sid: string, members = [makeMember("alice", "ses_task_alice")]) {
    const state = makeState("alpha", sid, members, Date.now())
    const team = await initTeamState(root, state, sid)
    await rebuildSessionIndex(root, `${root}__user_unused`)
    return team
}

describe("team_task_create: validation errors", () => {
    test("team not found → error", async () => {
        const root = tmpRoot("tc-404")
        const sid = "ses_tc_404"
        await setupTeam(root, sid)
        // Use a different storage root so resolveCallerInTeam's master lookup
        // succeeds (via the index) but the tool's loadTeamState fails.
        const emptyRoot = tmpRoot("tc-404-empty")
        const result = await teamTaskCreateTool(makeCtx(emptyRoot)).execute(
            { team_id: "alpha", subject: "test", description: "d" },
            makeToolContext(sid),
        )
        expect(result).toContain("not found")
        invalidateTeam(`${root}/${sid}/teams/alpha`)
        unindexSession(sid)
    })

    test("invalid blocked_by ID format → error", async () => {
        const root = tmpRoot("tc-bad-id")
        const sid = "ses_tc_bad_id"
        const team = await setupTeam(root, sid)
        const result = await teamTaskCreateTool(makeCtx(root)).execute(
            { team_id: "alpha", subject: "test", description: "d", blocked_by: ["not-a-uuid"] },
            makeToolContext(sid),
        )
        expect(result).toContain("not a valid task ID")
        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("blocked_by references non-existent task → error", async () => {
        const root = tmpRoot("tc-noexist")
        const sid = "ses_tc_noexist"
        const team = await setupTeam(root, sid)
        const result = await teamTaskCreateTool(makeCtx(root)).execute(
            { team_id: "alpha", subject: "test", description: "d", blocked_by: ["12345678-1234-1234-1234-123456789abc"] },
            makeToolContext(sid),
        )
        expect(result).toContain("does not match an existing task")
        invalidateTeam(team.directory)
        unindexSession(sid)
    })
})

describe("team_task_update: claim errors", () => {
    test("claim already-claimed task → TaskAlreadyClaimedError", async () => {
        const root = tmpRoot("tu-already")
        const sid = "ses_tu_already"
        const team = await setupTeam(root, sid, [
            makeMember("alice", "ses_tu_a"),
            makeMember("bob", "ses_tu_b"),
        ])
        // Create a task and have alice claim it.
        const task = await createTask(team.directory, { subject: "s", description: "d" })
        await teamTaskUpdateTool(makeCtx(root)).execute(
            { team_id: "alpha", task_id: task.id, status: "claimed" },
            makeToolContext("ses_tu_a"),
        )
        // Bob tries to claim the same task.
        const result = await teamTaskUpdateTool(makeCtx(root)).execute(
            { team_id: "alpha", task_id: task.id, status: "claimed" },
            makeToolContext("ses_tu_b"),
        )
        expect(result).toContain("already claimed")
        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession("ses_tu_a")
        unindexSession("ses_tu_b")
    })

    test("claim when member holds another active task → MemberHoldsActiveTaskError", async () => {
        const root = tmpRoot("tu-holds")
        const sid = "ses_tu_holds"
        const team = await setupTeam(root, sid, [makeMember("alice", "ses_tu_holds_a")])
        // Create two tasks.
        const task1 = await createTask(team.directory, { subject: "t1", description: "d" })
        const task2 = await createTask(team.directory, { subject: "t2", description: "d" })
        // Alice claims task1.
        await teamTaskUpdateTool(makeCtx(root)).execute(
            { team_id: "alpha", task_id: task1.id, status: "claimed" },
            makeToolContext("ses_tu_holds_a"),
        )
        // Alice tries to claim task2 without completing task1.
        const result = await teamTaskUpdateTool(makeCtx(root)).execute(
            { team_id: "alpha", task_id: task2.id, status: "claimed" },
            makeToolContext("ses_tu_holds_a"),
        )
        expect(result).toContain("already holds")
        expect(result).toContain("complete it")
        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession("ses_tu_holds_a")
    })
})

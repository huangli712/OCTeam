import { afterEach, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import {
    teamTaskCreateTool,
    teamTaskGetTool,
    teamTaskListTool,
    teamTaskUpdateTool,
} from "../src/tools/task.js"
import { createTask } from "../src/state/tasks.js"
import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"
import type { RecurseTask } from "../src/core/types.js"

function makeCtx(storageRoot: string): PluginContext {
    return { storageRoot, scope: "project" } as unknown as PluginContext
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

async function setupTeam(root: string, sid: string, members = [makeMember("alice")]): Promise<void> {
    await initTeamState(root, makeState("alpha", sid, members, Date.now()), sid)
    await rebuildSessionIndex(root, `${root}__unused`)
}

async function setupTeamDir(root: string, sid: string, members = [makeMember("alice")]): Promise<string> {
    await setupTeam(root, sid, members)
    const team = await loadTeamState(root, "alpha", sid)
    return team.directory
}

// ---------------------------------------------------------------------------
// team_task_create
// ---------------------------------------------------------------------------
describe("team_task_create (tool layer)", () => {
    test("master creates a task → success", async () => {
        const root = tmpRoot("ttc-create")
        const sid = "ses_ttc_create"
        tracked.push(sid)
        await setupTeam(root, sid)
        const result = await teamTaskCreateTool(makeCtx(root)).execute(
            { team_id: "alpha", subject: "fix bug", description: "fix the login bug" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("Task created")
        expect(result).toContain("fix bug")
    })

    test("member can also create tasks (cooperative access)", async () => {
        const root = tmpRoot("ttc-member")
        const masterSid = "ses_ttc_master"
        const memberSid = "ses_ttc_member"
        tracked.push(masterSid, memberSid)
        await setupTeam(root, masterSid, [makeMember("alice", memberSid)])
        const result = await teamTaskCreateTool(makeCtx(root)).execute(
            { team_id: "alpha", subject: "fix bug", description: "desc" },
            { sessionID: memberSid } as any,
        )
        // Members can create tasks — it's cooperative.
        expect(result).toContain("Task created")
    })
})

// ---------------------------------------------------------------------------
// team_task_list
// ---------------------------------------------------------------------------
describe("team_task_list (tool layer)", () => {
    test("empty → no tasks", async () => {
        const root = tmpRoot("ttl-empty")
        const sid = "ses_ttl_empty"
        tracked.push(sid)
        await setupTeam(root, sid)
        const result = await teamTaskListTool(makeCtx(root)).execute(
            { team_id: "alpha" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("No tasks")
    })

    test("after creating tasks → lists them with status", async () => {
        const root = tmpRoot("ttl-list")
        const sid = "ses_ttl_list"
        tracked.push(sid)
        const dir = await setupTeamDir(root, sid)
        const t1 = await createTask(dir, { subject: "t1", description: "d1" })
        await createTask(dir, { subject: "t2", description: "d2" })
        const result = await teamTaskListTool(makeCtx(root)).execute(
            { team_id: "alpha" },
            { sessionID: sid } as any,
        )
        expect(result).toContain(t1.id)
        expect(result).toContain("[pending]")
        expect(result).toContain("t1")
        expect(result).toContain("t2")
    })
})

// ---------------------------------------------------------------------------
// team_task_update
// ---------------------------------------------------------------------------
describe("team_task_update (tool layer)", () => {
    test("member claims a pending task → success", async () => {
        const root = tmpRoot("ttu-claim")
        const masterSid = "ses_ttu_master"
        const memberSid = "ses_ttu_alice"
        tracked.push(masterSid, memberSid)
        const dir = await setupTeamDir(root, masterSid, [makeMember("alice", memberSid)])
        const t = await createTask(dir, { subject: "t1", description: "d" })
        const result = await teamTaskUpdateTool(makeCtx(root)).execute(
            { team_id: "alpha", task_id: t.id, status: "claimed" },
            { sessionID: memberSid } as any,
        )
        expect(result).toContain("Claimed")
    })

    test("non-owner updating → rejected with ownership error", async () => {
        const root = tmpRoot("ttu-owner")
        const masterSid = "ses_ttu_master2"
        const aliceSid = "ses_ttu_alice2"
        const bobSid = "ses_ttu_bob"
        tracked.push(masterSid, aliceSid, bobSid)
        const dir = await setupTeamDir(root, masterSid, [
            makeMember("alice", aliceSid),
            makeMember("bob", bobSid),
        ])
        const t = await createTask(dir, { subject: "t1", description: "d" })
        // Alice claims the task.
        await teamTaskUpdateTool(makeCtx(root)).execute(
            { team_id: "alpha", task_id: t.id, status: "claimed" },
            { sessionID: aliceSid } as any,
        )
        // Bob tries to mark it completed → rejected.
        const result = await teamTaskUpdateTool(makeCtx(root)).execute(
            { team_id: "alpha", task_id: t.id, status: "completed" },
            { sessionID: bobSid } as any,
        )
        expect(result).toContain("Error")
        expect(result).toContain("owner")
    })

    test("master can update any task regardless of owner", async () => {
        const root = tmpRoot("ttu-master")
        const masterSid = "ses_ttu_master3"
        const aliceSid = "ses_ttu_alice3"
        tracked.push(masterSid, aliceSid)
        const dir = await setupTeamDir(root, masterSid, [makeMember("alice", aliceSid)])
        const t = await createTask(dir, { subject: "t1", description: "d" })
        // Alice claims it.
        await teamTaskUpdateTool(makeCtx(root)).execute(
            { team_id: "alpha", task_id: t.id, status: "claimed" },
            { sessionID: aliceSid } as any,
        )
        // Master completes it (bypasses owner check).
        const result = await teamTaskUpdateTool(makeCtx(root)).execute(
            { team_id: "alpha", task_id: t.id, status: "completed" },
            { sessionID: masterSid } as any,
        )
        expect(result).toContain("updated to completed")
    })
})

// ---------------------------------------------------------------------------
// team_task_get
// ---------------------------------------------------------------------------
describe("team_task_get (tool layer)", () => {
    test("existing task → returns details", async () => {
        const root = tmpRoot("ttg-get")
        const sid = "ses_ttg_get"
        tracked.push(sid)
        const dir = await setupTeamDir(root, sid)
        const t = await createTask(dir, { subject: "t1", description: "desc1" })
        const result = await teamTaskGetTool(makeCtx(root)).execute(
            { team_id: "alpha", task_id: t.id },
            { sessionID: sid } as any,
        )
        expect(result).toContain("t1")
        expect(result).toContain("pending")
    })

    test("non-existing task → error", async () => {
        const root = tmpRoot("ttg-404")
        const sid = "ses_ttg_404"
        tracked.push(sid)
        await setupTeam(root, sid)
        const result = await teamTaskGetTool(makeCtx(root)).execute(
            { team_id: "alpha", task_id: "00000000-0000-0000-0000-000000000000" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("not found")
    })
})


// ---------------------------------------------------------------------------
// team_task_create under recurse mode (regression: manual create produces
// duplicate tasks; orchestrator should own subtask creation via <decompose>)
// ---------------------------------------------------------------------------
describe("team_task_create (recurse-mode guard)", () => {
    test("rejected when team.activeTask.type === 'recurse'", async () => {
        const root = tmpRoot("ttc-recurse-blocked")
        const sid = "ses_ttc_recurse_blocked"
        tracked.push(sid)
        await setupTeam(root, sid)
        // Set an active recurse task so the guard fires.
        const team = await loadTeamState(root, "alpha", sid)
        team.activeTask = {
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
        } as RecurseTask
        await saveTeamState(team)

        const result = await teamTaskCreateTool(makeCtx(root)).execute(
            { team_id: "alpha", subject: "sub-a", description: "do A" },
            { sessionID: sid } as any,
        )
        // Guard rejects with a clear explanation pointing to <decompose>.
        expect(result).toContain("Error")
        expect(result).toContain("recurse mode")
        expect(result).toContain("disabled")
        expect(result).toContain("<decompose>")
        // No task was created.
        const after = await loadTeamState(root, "alpha", sid)
        const tasks = await import("../src/state/tasks.js").then(m => m.listAllTasks(after.directory))
        expect(tasks).toHaveLength(0)
    })

    test("still allowed under delegate/other modes (no false positive)", async () => {
        const root = tmpRoot("ttc-delegate-ok")
        const sid = "ses_ttc_delegate_ok"
        tracked.push(sid)
        await setupTeam(root, sid)
        // activeTask is undefined (no orchestration running) — create allowed.
        const result = await teamTaskCreateTool(makeCtx(root)).execute(
            { team_id: "alpha", subject: "freeform", description: "any" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("Task created")
    })
})

import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import type { ActiveTask } from "../src/core/types.js"
import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import { teamResumeTool } from "../src/tools/control/resume.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeTask, makeToolContext, tmpRoot } from './helpers.js';
import fs from "node:fs/promises"
import { createTask, listAllTasks, updateTask } from "../src/state/tasks.js"
import { processIdle } from "../src/orchestration/lifecycle/idle.js"

afterAll(cleanupTmpRoots)

/** Build a failed team with lastInterruptedTask, indexed for master resolution. */
async function setupFailed(
    root: string,
    sid: string,
    task: ActiveTask | null,
    members: ReturnType<typeof makeMember>[],
): Promise<ReturnType<typeof loadTeamState>> {
    const state = makeState("alpha", sid, members, Date.now())
    state.status = "failed"
    await initTeamState(root, state, sid)
    const team = await loadTeamState(root, "alpha", sid)
    if (task) {
        await team.mutex.runExclusive(async () => {
            team.lastInterruptedTask = task
            await saveTeamState(team)
        })
    }
    await rebuildSessionIndex(root, `${root}__unused`)
    return team
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("team_resume", () => {
    test("(a) parallel: alice complete, bob incomplete → only bob re-dispatched", async () => {
        const root = tmpRoot("resume-a")
        const sid = "ses_resume_a"
        tracked.push(sid)
        const task = makeTask({ responses: { alice: "done" } })
        await setupFailed(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const calls: string[] = []
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req: { path: { id: string } }) => { calls.push(req.path.id) } })
        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(res).toContain("Resumed parallel")
        expect(res).not.toContain("team_fix_workflow")
        expect(calls).toEqual(["ses_bob"])
    })

    test("workflow resume message points to progress and repair tools", async () => {
        const root = tmpRoot("resume-workflow-guidance")
        const sid = "ses_resume_workflow_guidance"
        tracked.push(sid)
        const task = makeTask({
            type: "workflow",
            activeStepIndices: [0],
            steps: [{ kind: "task", id: "impl", member: "alice", task: "resume workflow", completed: false }],
        })
        await setupFailed(root, sid, task, [makeMember("alice", "ses_alice")])
        const calls: string[] = []
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req: { path: { id: string } }) => { calls.push(req.path.id) } })

        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        expect(res).toContain("Resumed workflow")
        expect(res).toContain("team_progress")
        expect(res).toContain("team_fix_workflow")
        expect(calls).toEqual(["ses_alice"])
    })

    test("(c) errored member reset then re-dispatched", async () => {
        const root = tmpRoot("resume-c")
        const sid = "ses_resume_c"
        tracked.push(sid)
        const task = makeTask()
        const alice = makeMember("alice", "ses_alice")
        alice.status = "errored"
        alice.error = "crashed"
        const team = await setupFailed(root, sid, task, [alice])
        const calls: string[] = []
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req: { path: { id: string } }) => { calls.push(req.path.id) } })
        await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(team.members[0].error).toBeUndefined()
        expect(team.members[0].status).toBe("running")
        expect(calls).toEqual(["ses_alice"])
    })

    test("(h) parallel zero-dispatch → handleParallelIdle re-drives barrier [MAJOR-A]", async () => {
        const root = tmpRoot("resume-h")
        const sid = "ses_resume_h"
        tracked.push(sid)
        const task = makeTask({ responses: { alice: "x", bob: "y" } })
        const team = await setupFailed(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const calls: string[] = []
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req: { path: { id: string } }) => { calls.push(req.path.id) } })
        await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        // handleParallelIdle → deliverSummaryToLeader → promptAsync to leader
        expect(calls).toEqual([sid])
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
    })

    test("(i) Phase 2 throw → rollback restores checkpoint [MAJOR-B]", async () => {
        const root = tmpRoot("resume-i")
        const sid = "ses_resume_i"
        tracked.push(sid)
        const task = makeTask()
        // alice has NO sessionId → ensureMembersReady spawn → readTeamSpec fails
        const team = await setupFailed(root, sid, task, [
            makeMember("alice"), // no sessionId
        ])
        const ctx = makeCtx({ storageRoot: root, promptAsync: async () => {} })
        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(res).toContain("resume failed")
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        expect(team.lastInterruptedTask).toBeDefined()
    })

    test("(j) require_done_ack: response present but !declaredDone → re-dispatched [MAJOR-C]", async () => {
        const root = tmpRoot("resume-j")
        const sid = "ses_resume_j"
        tracked.push(sid)
        const task = makeTask({
            requireDoneAck: true,
            responses: { alice: "output" },
        })
        const alice = makeMember("alice", "ses_alice")
        alice.declaredDone = false
        await setupFailed(root, sid, task, [alice])
        const calls: string[] = []
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req: { path: { id: string } }) => { calls.push(req.path.id) } })
        await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        // Re-dispatched despite having a response — completion = declaredDone.
        expect(calls).toEqual(["ses_alice"])
    })

    test("(b) pipeline: advanceToStage uses responses[] context (no .md read) [O3]", async () => {
        const root = tmpRoot("resume-b")
        const sid = "ses_resume_b"
        tracked.push(sid)
        const task = makeTask({
            type: "pipeline",
            stages: [
                { member: "alice", task: "do A", completed: true },
                { member: "bob", task: "do B", completed: false },
            ],
            currentStageIndex: 1,
            responses: { alice: "ALICE_UPSTREAM_OUTPUT" },
        })
        await setupFailed(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        let bobPrompt = ""
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req: { path: { id: string }; body: { parts: Array<{ text: string }> } }) => { if (req.path.id === "ses_bob") bobPrompt = req.body.parts[0].text } })
        await teamResumeTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))
        expect(bobPrompt).toContain("ALICE_UPSTREAM_OUTPUT")
    })

    test("(d) Phase 1 does NOT commit activeTask [O1 BLOCKER]", async () => {
        const root = tmpRoot("resume-d")
        const sid = "ses_resume_d"
        tracked.push(sid)
        const task = makeTask() // no responses → bob dispatched (triggers promptAsync)
        const team = await setupFailed(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const captured: unknown[] = []
        const ctx = makeCtx({ storageRoot: root, promptAsync: async () => {
            // Disk state during Phase 3 dispatch. After C5 (dispatch
            // atomicity), the FIRST dispatch saves state immediately, so
            // subsequent dispatches see activeTask on disk. The FIRST
            // dispatch's promptAsync must still see Phase 1 state (no
            // activeTask) because C5's save runs AFTER promptAsync resolves.
            const raw = await fs.readFile(`${team.directory}/state.json`, "utf8")
            captured.push(JSON.parse(raw).activeTask)
        } })
        await teamResumeTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))
        // #10: with dispatch atomicity fix, dispatchToMember now persists
        // state BEFORE promptAsync (not after). So the first promptAsync call
        // SHOULD see activeTask on disk — Phase 3 set it and dispatchToMember
        // saved it before sending. The test verifies this new correct ordering.
        expect(captured[0]).toBeDefined()
    })

    test("(e) processIdle with no activeTask → no summary (O1 absorption)", async () => {
        const root = tmpRoot("resume-e")
        const sid = "ses_resume_e"
        tracked.push(sid)
        const team = await setupFailed(root, sid, null, [makeMember("alice", "ses_alice")])
        let delivered = false
        const ctx = makeCtx({ storageRoot: root, promptAsync: async () => { delivered = true } })
        await processIdle(ctx, team, team.members[0], team.members[0].sessionId!)
        expect(delivered).toBe(false)
    })

    test("(f) token_budget override applied", async () => {
        const root = tmpRoot("resume-f")
        const sid = "ses_resume_f"
        tracked.push(sid)
        const task = makeTask({ tokensUsed: 1000, tokenBudget: 500 })
        const team = await setupFailed(root, sid, task, [makeMember("alice", "ses_alice")])
        const ctx = makeCtx({ storageRoot: root, promptAsync: async () => {} })
        await teamResumeTool(ctx).execute(
            { team_id: "alpha", token_budget: 5000 },
            makeToolContext(sid),
        )
        expect(team.activeTask?.tokenBudget).toBe(5000)
    })

    test("(g) delegate: claimed + in_progress → pending [O8]", async () => {
        const root = tmpRoot("resume-g")
        const sid = "ses_resume_g"
        tracked.push(sid)
        const task = makeTask({ type: "delegate" })
        const team = await setupFailed(root, sid, task, [makeMember("alice", "ses_alice")])
        const dir = team.directory
        const t1 = await createTask(dir, { subject: "claimed", description: "x" })
        const t2 = await createTask(dir, { subject: "inprogress", description: "y" })
        const t3 = await createTask(dir, { subject: "pending", description: "z" })
        await updateTask(dir, t1.id, { status: "claimed", owner: "alice" })
        await updateTask(dir, t2.id, { status: "in_progress", owner: "alice" })
        const ctx = makeCtx({ storageRoot: root, promptAsync: async () => {} })
        await teamResumeTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))
        const after = await listAllTasks(dir)
        const byId = (id: string) => after.find(t => t.id === id)!.status
        expect(byId(t1.id)).toBe("pending")
        expect(byId(t2.id)).toBe("pending")
        expect(byId(t3.id)).toBe("pending")
    })

    test("(h2) consensus zero-dispatch → handleConsensusIdle re-drives [MAJOR-A]", async () => {
        const root = tmpRoot("resume-h2")
        const sid = "ses_resume_h2"
        tracked.push(sid)
        const task = makeTask({
            type: "consensus",
            topic: "debate",
            currentRound: 1,
            maxRounds: 1,
            responses: { alice: "agree", bob: "disagree" },
        })
        const team = await setupFailed(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const calls: string[] = []
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req: { path: { id: string } }) => { calls.push(req.path.id) } })
        await teamResumeTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))
        expect(calls).toEqual([sid])
        expect(team.status).toBe("failed")
    })

    test("(i2) Phase 3 post-commit throw → active-reset rollback [MAJOR-B]", async () => {
        const root = tmpRoot("resume-i2")
        const sid = "ses_resume_i2"
        tracked.push(sid)
        const task = makeTask()
        const team = await setupFailed(root, sid, task, [makeMember("alice", "ses_alice")])
        const ctx = makeCtx({ storageRoot: root, promptAsync: async () => { throw new Error("dead session") } })
        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(res).toContain("resume failed")
        expect(team.activeTask).toBeUndefined()
        expect(team.status).toBe("failed")
        expect(team.lastInterruptedTask).toBeDefined()
    })

    test("(k) no checkpoint → clear error", async () => {
        const root = tmpRoot("resume-k")
        const sid = "ses_resume_k"
        tracked.push(sid)
        await setupFailed(root, sid, null, [makeMember("alice", "ses_alice")])
        const ctx = makeCtx({ storageRoot: root, promptAsync: async () => {} })
        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(res).toContain("no interrupted task")
    })
})

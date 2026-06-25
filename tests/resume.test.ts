import { afterEach, describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask } from "../src/core/types.js"
import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import { teamResumeTool } from "../src/tools/resume.js"
import { rebuildSessionIndex, unindexSession } from "../src/core/utils.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

// --- helpers ---

function makeCtx(
    root: string,
    promptAsync: (req: unknown) => Promise<void>,
): PluginContext {
    return {
        storageRoot: root,
        scope: "project",
        directory: "/app",
        client: {
            app: { log: mock(async () => {}) },
            session: {
                abort: mock(async () => {}),
                promptAsync: mock(promptAsync),
                messages: mock(async () => ({ data: [] })),
            },
        },
    } as unknown as PluginContext
}

function makeTask(overrides: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
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
        ...overrides,
    } as ActiveTask
}

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
        const ctx = makeCtx(root, async (req: any) => {
            calls.push(req.path.id)
        })
        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            { sessionID: sid } as any,
        )
        expect(res).toContain("Resumed parallel")
        expect(calls).toEqual(["ses_bob"])
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
        const ctx = makeCtx(root, async (req: any) => {
            calls.push(req.path.id)
        })
        await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            { sessionID: sid } as any,
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
        const ctx = makeCtx(root, async (req: any) => {
            calls.push(req.path.id)
        })
        await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            { sessionID: sid } as any,
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
        const ctx = makeCtx(root, async () => {})
        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            { sessionID: sid } as any,
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
        const ctx = makeCtx(root, async (req: any) => {
            calls.push(req.path.id)
        })
        await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            { sessionID: sid } as any,
        )
        // Re-dispatched despite having a response — completion = declaredDone.
        expect(calls).toEqual(["ses_alice"])
    })

    test("(k) no checkpoint → clear error", async () => {
        const root = tmpRoot("resume-k")
        const sid = "ses_resume_k"
        tracked.push(sid)
        await setupFailed(root, sid, null, [makeMember("alice", "ses_alice")])
        const ctx = makeCtx(root, async () => {})
        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            { sessionID: sid } as any,
        )
        expect(res).toContain("no interrupted task")
    })
})

import { afterAll, describe, expect, test } from "bun:test"

import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import { createTask, updateTask } from "../src/state/tasks.js"
import type { ActiveTask, Task } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { makeCtx, makeTeam, cleanupTmpRoots, type DispatchCall } from "./helpers.js"

afterAll(cleanupTmpRoots)

// --- fixtures (delegate execution path) ---



function makeDelegateTask(opts: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "delegate",
        startedAt: Date.now(),
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
        signoffPolicy: "none",
        ...opts,
    } as ActiveTask
}

/** Seed a task into the team store, optionally setting owner/status/blockers. */
async function seedTask(
    team: Team,
    opts: { subject?: string; description?: string; status?: Task["status"]; owner?: string; blockedBy?: string[] },
): Promise<Task> {
    const t = await createTask(team.directory, {
        subject: opts.subject ?? "task",
        description: opts.description ?? "do it",
        blockedBy: opts.blockedBy,
    })
    if (opts.owner || opts.status) {
        await updateTask(team.directory, t.id, {
            owner: opts.owner,
            status: opts.status ?? "claimed",
        })
    }
    return t
}

// --- termination tail (runDelegateStyleTail via processIdle) ---

describe("handleDelegateIdle (via processIdle): termination tail", () => {
    test("all tasks complete -> delivers delegate_complete and idles", async () => {
        const calls: DispatchCall[] = []
        const team = makeTeam({
            activeTask: makeDelegateTask(),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        await seedTask(team, { subject: "done", description: "x", status: "completed" })

        await processIdle(makeCtx({ calls, status: async () => ({ data: {} }) }), team, team.members[0], "ses_alice")

        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("delegate_complete")
    })

    test("no claimable tasks with all members idle -> delegate_deadlock failure", async () => {
        const calls: DispatchCall[] = []
        const team = makeTeam({
            activeTask: makeDelegateTask(),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        // A pending task blocked by an incomplete (never-completing) dependency.
        const blocker = await seedTask(team, { subject: "blocker", description: "x", status: "in_progress" })
        await seedTask(team, {
            subject: "stuck",
            description: "x",
            status: "pending",
            blockedBy: [blocker.id],
        })

        await processIdle(makeCtx({ calls, status: async () => ({ data: {} }) }), team, team.members[0], "ses_alice")

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("delegate_deadlock")
    })

    test("no claimable tasks, cached idle, but live session running -> NOT deadlock (wake-hint cross-check)", async () => {
        // Regression: a member woken by a wake-hint (promptAsync) has its
        // OpenCode session actually running, but member.status lags at "idle".
        // The cross-check against ctx.client.session.status must prevent a
        // false-positive deadlock verdict while the member is still working.
        const calls: DispatchCall[] = []
        const team = makeTeam({
            activeTask: makeDelegateTask(),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const blocker = await seedTask(team, { subject: "blocker", description: "x", status: "in_progress" })
        await seedTask(team, {
            subject: "stuck",
            description: "x",
            status: "pending",
            blockedBy: [blocker.id],
        })

        // Override makeCtx to report alice's session as "running" (wake-hint path).
        const ctx = makeCtx({ calls, status: async () => ({ data: {} }) })
        ;(ctx.client.session as { status: unknown }).status = async () => ({
            data: { ses_alice: { type: "running" } },
        })

        await processIdle(ctx, team, team.members[0], "ses_alice")

        // Not a deadlock — alice is actually running. Run stays live.
        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
        // No deadlock summary delivered to the leader.
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeUndefined()
    })

    test("a claimable task with an idle member -> re-prompts that member (run stays live)", async () => {
        const calls: DispatchCall[] = []
        const team = makeTeam({
            activeTask: makeDelegateTask(),
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        await seedTask(team, { subject: "available", description: "x", status: "pending" })

        await processIdle(makeCtx({ calls, status: async () => ({ data: {} }) }), team, team.members[0], "ses_alice")

        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
        // The idle member is nudged toward the claimable task.
        const aliceCall = calls.find(c => c.sessionId === "ses_alice")
        expect(aliceCall).toBeDefined()
        expect(aliceCall!.text).toContain("task(s) available")
    })
})

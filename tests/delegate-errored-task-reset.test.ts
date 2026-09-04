/**
 * Delegate does not reset errored members' tasks
 * before the claimable filter, causing false deadlock.
 *
 * Bug: runDelegateStyleTail (delegate.ts:75-117) filters claimable tasks as
 * `status === "pending"`. An errored member's task is at "claimed" or
 * "in_progress" — NOT pending — so it's excluded from claimable. The
 * deadlock check at line 86 then sees claimable.length === 0 AND all members
 * idle/errored → finishRun(deadlock). The task is never handed to a
 * surviving member.
 *
 * recurse.ts:184-197 DOES reset errored members' tasks to pending, but
 * delegate.ts does NOT. The shared tail (runDelegateStyleTail) lacks this
 * step.
 *
 * Fix: at the top of runDelegateStyleTail, reset errored members' claimed/
 * in_progress tasks to pending BEFORE the claimable filter. This lets
 * surviving idle members pick them up instead of declaring deadlock.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { chmod } from "node:fs/promises"

import type { PluginContext } from "../src/core/context.js"
import { runDelegateStyleTail } from "../src/orchestration/modes/delegate.js"
import { initTeamState } from "../src/state/store.js"
import { createTask, updateTask } from "../src/state/tasks.js"
import { tasksDir } from "../src/state/paths.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"
import type { ActiveTask } from "../src/core/types.js"
import { mock } from "bun:test"

afterAll(cleanupTmpRoots)

function delegateTask(runId: string): ActiveTask {
    return {
        type: "delegate",
        mode: "cooperative",
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
        runId,
    }
}

describe("delegate resets errored members' tasks before deadlock check", () => {
    test("errored member's claimed task is reset to pending and re-dispatched", async () => {
        const root = tmpRoot("h40-errored-reset")
        const alice = makeMember("alice", "ses_a")
        const bob = makeMember("bob", "ses_b")

        const promptCalls: string[] = []
        const ctx: PluginContext = {
            storageRoot: root,
            scope: "project",
            directory: "/app",
            client: {
                app: { log: mock(async () => {}) },
                session: {
                    abort: mock(async () => {}),
                    promptAsync: mock(async (req: { path: { id: string } }) => {
                        promptCalls.push(req.path.id)
                    }),
                    messages: mock(async () => ({ data: [] })),
                    status: mock(async () => ({ data: [] })),
                },
            },
        } as unknown as PluginContext

        const team = await initTeamState(
            root,
            makeState("h40-team", "ses_master", [alice, bob], Date.now()),
            "ses_master",
        )
        const dir = team.directory

        await team.mutex.runExclusive(async () => {
            team.activeTask = delegateTask("run-h40")

            // alice claims a task, then errors mid-work.
            const t = await createTask(dir, { subject: "work", description: "do X" })
            await updateTask(dir, t.id, { status: "claimed", owner: "alice" })
            team.members[0].status = "errored"
            team.members[0].error = "crashed"
            team.members[1].status = "idle"

            // bob (the surviving idle member) triggers the tail.
            await runDelegateStyleTail(ctx, team, team.members[1], "delegate", () => "reprompt")
        })

        // On UNFIXED code: claimable is empty (alice's task is "claimed" not
        // "pending"), all members idle/errored → deadlock → team.status="failed".
        // On FIXED code: alice's task is reset to pending, bob is dispatched.
        expect(team.status).not.toBe("failed")
        // bob should have been dispatched toward the reclaimed task.
        expect(promptCalls).toContain("ses_b")
    })

    test("non-CAS task release errors are rethrown", async () => {
        const root = tmpRoot("delegate-release-error")
        const alice = makeMember("alice", "ses_a_error")
        const bob = makeMember("bob", "ses_b_error")
        const team = await initTeamState(
            root,
            makeState("release-error-team", "ses_master_error", [alice, bob], Date.now()),
            "ses_master_error",
        )
        team.activeTask = delegateTask("run-release-error")

        const task = await createTask(team.directory, { subject: "work", description: "do X" })
        await updateTask(team.directory, task.id, { status: "claimed", owner: "alice" })
        team.members[0].status = "errored"
        team.members[1].status = "idle"

        const directory = tasksDir(team.directory)
        await chmod(directory, 0o500)
        let releaseError: unknown
        try {
            try {
                await runDelegateStyleTail(
                    makeCtx({ calls: [] }), team, team.members[1], "delegate", () => "reprompt",
                )
            } catch (error) {
                if (!(error instanceof Error)) throw error
                releaseError = error
            }
        } finally {
            await chmod(directory, 0o700)
        }
        expect(releaseError).toBeInstanceOf(Error)
    })
})

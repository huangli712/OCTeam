/**
 * Delegate cooldown can permanently strand
 * claimable tasks.
 *
 * Bug: runDelegateStyleTail filters idle members by NOTIFY_COOLDOWN_MS.
 * When every idle member is still in cooldown, idleMembers is empty.
 * The function returns without dispatching anyone AND without scheduling
 * a re-trigger. Since all members are already idle (no new idle event will
 * fire), the claimable tasks sit forever until the global wall-clock
 * timeout.
 *
 * Fix: when every idle member is in cooldown, bypass the filter and
 * dispatch the member notified longest ago (its cooldown is closest to
 * expiry). This is rare (requires all members to have been notified
 * within the cooldown window), so the rate-limiting purpose of the
 * cooldown is preserved in the common case.
 */
import { afterAll, describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import { runDelegateStyleTail } from "../src/orchestration/modes/delegate.js"
import { initTeamState } from "../src/state/store.js"
import { createTask } from "../src/state/tasks.js"
import { cleanupTmpRoots, makeMember, makeState, tmpRoot } from "./helpers.js"
import type { ActiveTask } from "../src/core/types.js"

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

describe("delegate cooldown must not permanently strand claimable tasks", () => {
    test("all idle members in cooldown → dispatch anyway to avoid stall", async () => {
        const root = tmpRoot("c16-stall")
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
                },
            },
        } as unknown as PluginContext

        const team = await initTeamState(
            root,
            makeState("c16-team", "ses_master", [alice, bob], Date.now()),
            "ses_master",
        )
        const dir = team.directory

        await team.mutex.runExclusive(async () => {
            team.activeTask = delegateTask("run-c16")

            // Create a claimable task (pending, no blockers).
            await createTask(dir, { subject: "work", description: "do X" })

            // Both members idle, both just notified (in cooldown).
            team.members[0].status = "idle"
            team.members[0].lastNotifiedAt = Date.now()
            team.members[1].status = "idle"
            team.members[1].lastNotifiedAt = Date.now()

            // alice just idled → runDelegateStyleTail runs.
            await runDelegateStyleTail(ctx, team, team.members[0], "delegate", () => "reprompt")
        })

        // On UNFIXED code: idleMembers is empty (both in cooldown), no
        // dispatch → promptCalls.length === 0 → test FAILS.
        // On FIXED code: bypass cooldown, dispatch one member.
        expect(promptCalls.length).toBeGreaterThan(0)
    })

    test("normal case: member NOT in cooldown still dispatched first", async () => {
        const root = tmpRoot("c16-normal")
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
                },
            },
        } as unknown as PluginContext

        const team = await initTeamState(
            root,
            makeState("c16-normal-team", "ses_master", [alice, bob], Date.now()),
            "ses_master",
        )
        const dir = team.directory

        await team.mutex.runExclusive(async () => {
            team.activeTask = delegateTask("run-c16-normal")

            await createTask(dir, { subject: "work", description: "do X" })

            // alice NOT in cooldown (never notified), bob in cooldown.
            team.members[0].status = "idle"
            team.members[0].lastNotifiedAt = undefined
            team.members[1].status = "idle"
            team.members[1].lastNotifiedAt = Date.now()

            await runDelegateStyleTail(ctx, team, team.members[0], "delegate", () => "reprompt")
        })

        // alice (not in cooldown) dispatched — cooldown filter still works.
        expect(promptCalls).toContain("ses_a")
    })
})

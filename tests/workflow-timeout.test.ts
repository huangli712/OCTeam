import { describe, expect, test } from "bun:test"

import type { MemberState, WorkflowStep, WorkflowTask } from "../src/core/types.js"
import { checkTermination } from "../src/orchestration/termination.js"
import { processIdle } from "../src/orchestration/idle.js"
import type { Team } from "../src/state/store.js"

import { makeCtx, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js"
const NOW = 1_700_000_000_000



function member(team: Team, name: string): MemberState {
    const found = team.members.find(candidate => candidate.name === name)
    if (found === undefined) throw new Error(`Missing member ${name}`)
    return found
}

describe("workflow step timeout policy", () => {
    test("fails a linear workflow when an active step exceeds timeout_ms", async () => {
        // Given
        const task = makeWorkflowTask({
            activeStepIndices: [0],
            steps: [{ kind: "task", member: "alice", task: "slow", completed: false, timeoutMs: 1000, dispatchedAt: NOW - 2000 }],
        })
        const team = makeTeam({ activeTask: task, members: [{ name: "alice", sessionId: "ses_alice" }] })
        const ctx = makeCtx({ calls: [] })

        // When
        await checkTermination(ctx, team, NOW)

        // Then
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
    })

    test("redispatches a timed-out step until max_timeout_retries is exhausted", async () => {
        // Given
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            activeStepIndices: [0],
            steps: [{ kind: "task", member: "alice", task: "retry slow", completed: false, timeoutMs: 1000, onTimeout: "retry", maxTimeoutRetries: 1, timeoutAttempts: 0, dispatchedAt: NOW - 2000 }],
        })
        const team = makeTeam({ activeTask: task, members: [{ name: "alice", sessionId: "ses_alice" }] })
        const ctx = makeCtx({ calls })

        // When
        await checkTermination(ctx, team, NOW)

        // Then
        expect(team.status).toBe("busy")
        expect(team.activeTask).toBe(task)
        expect(task.steps?.[0]?.timeoutAttempts).toBe(1)
        expect(task.steps?.[0]?.dispatchedAt).toBe(NOW)
        expect(calls).toContainEqual({ sessionId: "ses_alice", text: "retry slow" })

        // When
        await checkTermination(ctx, team, NOW + 2000)

        // Then
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
    })

    test("skips a timed-out linear step and advances to the next step", async () => {
        // Given
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            activeStepIndices: [0],
            steps: [
                { kind: "task", member: "alice", task: "optional", completed: false, timeoutMs: 1000, onTimeout: "skip", dispatchedAt: NOW - 2000 },
                { kind: "task", member: "bob", task: "continue", completed: false },
            ],
        })
        const team = makeTeam({ activeTask: task, members: [{ name: "alice", sessionId: "ses_alice" }, { name: "bob", sessionId: "ses_bob" }] })
        const ctx = makeCtx({ calls })

        // When
        await checkTermination(ctx, team, NOW)

        // Then
        expect(task.steps?.[0]?.completed).toBe(true)
        expect(task.steps?.[0]?.skipped).toBe(true)
        expect(task.activeStepIndices).toEqual([1])
        expect(calls).toContainEqual({ sessionId: "ses_bob", text: expect.stringContaining("continue") })
    })

    test("times out only the active fanout branch within max_errored tolerance", async () => {
        // Given
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            activeStepIndices: [1, 2],
            steps: [
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "tests"],
                        branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }],
                        joinIndex: 3,
                        maxErrored: 1,
                    },
                },
                { kind: "task", member: "alice", task: "api", completed: false, timeoutMs: 1000, dispatchedAt: NOW - 2000, branch: { fanoutIndex: 0, branchId: "api", branchIndex: 0, joinIndex: 3 } },
                { kind: "task", member: "bob", task: "tests", completed: false, branch: { fanoutIndex: 0, branchId: "tests", branchIndex: 1, joinIndex: 3 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2], maxErrored: 1 } },
                { kind: "task", member: "carol", task: "integrate survivors", completed: false },
            ],
        })
        const team = makeTeam({ activeTask: task, members: [{ name: "alice", sessionId: "ses_alice" }, { name: "bob", sessionId: "ses_bob" }, { name: "carol", sessionId: "ses_carol" }] })
        const ctx = makeCtx({ outputs: { ses_bob: "tests output", ses_carol: "downstream output" }, calls })

        // When
        await checkTermination(ctx, team, NOW)
        await processIdle(ctx, team, member(team, "bob"), "ses_bob")

        // Then
        expect(team.status).toBe("busy")
        expect(task.steps?.[1]?.skipped).toBe(true)
        expect(task.steps?.[3]?.join?.erroredBranchIds).toEqual(["api"])
        expect(task.steps?.[3]?.completed).toBe(true)
    })

    test("uses the dispatched fallback actor when a fanout branch times out", async () => {
        // Given: the api branch was dispatched to bob as alice's fallback.
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            activeStepIndices: [1, 2],
            steps: [
                {
                    kind: "fanout",
                    completed: true,
                    fanout: {
                        branchIds: ["api", "tests"],
                        branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }],
                        joinIndex: 3,
                        maxErrored: 1,
                    },
                },
                { kind: "task", member: "alice", fallbackMember: "bob", task: "api", completed: false, timeoutMs: 1000, dispatchedAt: NOW - 2000, dispatchedActor: "bob", branch: { fanoutIndex: 0, branchId: "api", branchIndex: 0, joinIndex: 3 } },
                { kind: "task", member: "carol", task: "tests", completed: false, branch: { fanoutIndex: 0, branchId: "tests", branchIndex: 1, joinIndex: 3 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2], maxErrored: 1 } },
                { kind: "task", member: "dave", task: "integrate survivors", completed: false },
            ],
        })
        const team = makeTeam({ activeTask: task, members: [{ name: "alice" }, { name: "bob", sessionId: "ses_bob" }, { name: "carol", sessionId: "ses_carol" }, { name: "dave", sessionId: "ses_dave" }] })
        const ctx = makeCtx({ outputs: { ses_carol: "tests output", ses_dave: "downstream output" }, calls })

        // When: the fallback-dispatched branch times out.
        await checkTermination(ctx, team, NOW)
        await processIdle(ctx, team, member(team, "carol"), "ses_carol")

        // Then: the api branch is degraded, not the workflow as a whole.
        expect(team.status).toBe("busy")
        expect(task.steps?.[1]?.skipped).toBe(true)
        expect(task.steps?.[3]?.join?.erroredBranchIds).toEqual(["api"])
        expect(task.steps?.[3]?.completed).toBe(true)
        expect(calls.some(call => call.sessionId === "ses_dave")).toBe(true)
    })
})

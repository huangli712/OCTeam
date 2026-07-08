import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask, MemberState, WorkflowStep, WorkflowTask } from "../src/core/types.js"
import { checkTermination } from "../src/orchestration/termination.js"
import { processIdle } from "../src/orchestration/handlers.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { Team } from "../src/state/store.js"

const NOW = 1_700_000_000_000
type DispatchCall = { readonly sessionId: string; readonly text: string }

function makeCtx(outputs: Record<string, string> = {}, calls: DispatchCall[] = []): PluginContext {
    return {
        storageRoot: mkdtempSync(join(tmpdir(), "octeam-wf-timeout-root-")),
        scope: "project",
        directory: "/app",
        client: {
            session: {
                messages: async ({ path }: { path: { id: string } }) => {
                    const text = outputs[path.id] ?? ""
                    return {
                        data: [
                            { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
                            ...(text ? [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }] : []),
                        ],
                    }
                },
                promptAsync: async (args: { readonly path: { readonly id: string }; readonly body: { readonly parts: readonly [{ readonly text: string }] } }) => {
                    calls.push({ sessionId: args.path.id, text: args.body.parts[0].text })
                    return { data: {} }
                },
            },
        },
    } as unknown as PluginContext
}

function makeWorkflowTask(fields: Partial<WorkflowTask> & { readonly steps: WorkflowStep[] }): WorkflowTask {
    return {
        type: "workflow",
        startedAt: NOW,
        wallClockTimeoutMs: Number.MAX_SAFE_INTEGER,
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
        ...fields,
    } as WorkflowTask
}

function makeTeam(activeTask: ActiveTask, members: Array<Partial<MemberState> & Pick<MemberState, "name">>): Team {
    return {
        version: 1,
        teamRunId: "timeout-test-run",
        teamName: "timeout-test-team",
        status: "busy",
        leadSessionId: "ses_lead",
        members: members.map(member => ({
            name: member.name,
            sessionId: member.sessionId,
            status: member.status ?? "idle",
            initialized: member.initialized ?? true,
            turnCount: member.turnCount ?? 0,
            isMaster: member.isMaster,
            error: member.error,
        })),
        bounds: {
            maxMembers: 8,
            maxParallelMembers: 4,
            maxMessagesPerRun: 100,
            maxWallClockMinutes: 30,
            maxMemberTurns: 50,
            maxTasks: 200,
            messagePayloadMaxBytes: 32768,
            messageUnreadMaxBytes: 1048576,
        },
        createdAt: NOW,
        activeTask,
        mutex: new AsyncMutex(),
        directory: mkdtempSync(join(tmpdir(), "octeam-wf-timeout-")),
    } as unknown as Team
}

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
        const team = makeTeam(task, [{ name: "alice", sessionId: "ses_alice" }])
        const ctx = makeCtx()

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
        const team = makeTeam(task, [{ name: "alice", sessionId: "ses_alice" }])
        const ctx = makeCtx({}, calls)

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
        const team = makeTeam(task, [{ name: "alice", sessionId: "ses_alice" }, { name: "bob", sessionId: "ses_bob" }])
        const ctx = makeCtx({}, calls)

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
        const team = makeTeam(task, [{ name: "alice", sessionId: "ses_alice" }, { name: "bob", sessionId: "ses_bob" }, { name: "carol", sessionId: "ses_carol" }])
        const ctx = makeCtx({ ses_bob: "tests output", ses_carol: "downstream output" }, calls)

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
        const team = makeTeam(task, [{ name: "alice" }, { name: "bob", sessionId: "ses_bob" }, { name: "carol", sessionId: "ses_carol" }, { name: "dave", sessionId: "ses_dave" }])
        const ctx = makeCtx({ ses_carol: "tests output", ses_dave: "downstream output" }, calls)

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

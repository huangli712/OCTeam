/**
 * Workflow handler execution tests (TDD RED→GREEN for Wave 2 T2).
 *
 * Mirrors the pipeline-exec.test.ts stub-ctx harness: makeCtx captures member
 * outputs and records promptAsync dispatches; makeTeam/buildWorkflowTask fixture
 * the state. Drives the handler via processIdle (the real idle entry point) so
 * identity validation (getExpectedMember), output capture, and dispatch all run.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { processIdle } from "../src/orchestration/handlers.js"
import type { ActiveTask, MemberState, WorkflowStep, WorkflowTask } from "../src/core/types.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { Team } from "../src/state/store.js"
import type { PluginContext } from "../src/core/context.js"

type DispatchCall = { sessionId: string; text: string }

function makeCtx(outputs: Record<string, string>, calls: DispatchCall[] = []): PluginContext {
    return {
        directory: "/app",
        client: {
            session: {
                messages: async ({ path }: { path: { id: string } }) => {
                    const text = outputs[path.id] ?? ""
                    return {
                        data: [
                            { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
                            ...(text
                                ? [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }]
                                : []),
                        ],
                    }
                },
                promptAsync: async (args: any) => {
                    calls.push({ sessionId: args.path.id, text: args.body.parts[0].text })
                    return { data: {} }
                },
            },
        },
    } as unknown as PluginContext
}

function makeWorkflowTask(opts: Partial<WorkflowTask> & { steps: WorkflowStep[] }): WorkflowTask {
    return {
        type: "workflow",
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
    } as WorkflowTask
}

function makeTeam(opts: {
    activeTask?: ActiveTask
    members?: Array<Partial<MemberState> & Pick<MemberState, "name">>
}): Team {
    const members: MemberState[] = (opts.members ?? []).map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: m.initialized ?? true,
        turnCount: m.turnCount ?? 0,
        sessionId: m.sessionId,
        agent: m.agent,
        isMaster: m.isMaster,
    }))
    return {
        version: 1,
        teamRunId: "test-run",
        teamName: "test-team",
        status: "busy",
        leadSessionId: "ses_lead",
        members,
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
        createdAt: 0,
        activeTask: opts.activeTask,
        mutex: new AsyncMutex(),
        directory: mkdtempSync(join(tmpdir(), "octeam-wf-")),
    } as unknown as Team
}

const PASS_VERDICT = '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>'
const FAIL_VERDICT = '<verdict>{"result":"FAIL","rationale":"wrong","diff":"off by one"}</verdict>'

describe("handleWorkflowIdle (via processIdle): task steps", () => {
    test("a non-final task step completes -> advances and dispatches the next task with upstream context", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do step 1", completed: false },
                { kind: "task", member: "bob", task: "do step 2", completed: false },
            ],
            currentStageIndex: 0,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ ses_alice: "alice's step-1 result" }, calls)

        await processIdle(ctx, team, team.members[0], "ses_alice")

        expect(task.steps![0].completed).toBe(true)
        expect(task.currentStageIndex).toBe(1)
        const bobCall = calls.find(c => c.sessionId === "ses_bob")
        expect(bobCall).toBeDefined()
        expect(bobCall!.text).toContain("do step 2")
        expect(bobCall!.text).toContain("alice's step-1 result")
        expect(team.members.find(m => m.name === "bob")!.status).toBe("running")
        expect(team.activeTask).toBeDefined()
    })

    test("the final task step completes -> delivers workflow_complete and idles", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [{ kind: "task", member: "alice", task: "the only step", completed: false }],
            currentStageIndex: 0,
        })
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice" }],
        })
        const ctx = makeCtx({ ses_alice: "final workflow output" }, calls)

        await processIdle(ctx, team, team.members[0], "ses_alice")

        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("workflow_complete")
    })

    test("a stray idle from a non-current member does NOT advance the workflow", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "step 1", completed: false },
                { kind: "task", member: "bob", task: "step 2", completed: false },
            ],
            currentStageIndex: 0,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ ses_bob: "bob jumped ahead" }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.currentStageIndex).toBe(0)
        expect(task.steps![0].completed).toBe(false)
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)
        expect(team.activeTask).toBeDefined()
    })
})

describe("handleWorkflowIdle (via processIdle): gate steps", () => {
    test("a gate PASS -> marks the gate complete and advances to the next task", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true },
                { kind: "gate", verifier: "bob", criteria: "passes tests", onFail: "retry", maxRetries: 0, attempts: 0, completed: false },
                { kind: "task", member: "carol", task: "follow-up work", completed: false },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice's work output" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        })
        const ctx = makeCtx({ ses_bob: PASS_VERDICT }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.steps![1].completed).toBe(true)
        expect(task.steps![1].verdict).toBe("PASS")
        expect(task.currentStageIndex).toBe(2)
        const carolCall = calls.find(c => c.sessionId === "ses_carol")
        expect(carolCall).toBeDefined()
        expect(carolCall!.text).toContain("follow-up work")
    })

    test("the final gate PASS -> delivers workflow_complete", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true },
                { kind: "gate", verifier: "bob", criteria: "passes tests", onFail: "fail", maxRetries: 0, attempts: 0, completed: false },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice's work output" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ ses_bob: PASS_VERDICT }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("workflow_complete")
    })

    test("a gate FAIL with onFail='fail' -> fails the run immediately", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true },
                { kind: "gate", verifier: "bob", criteria: "passes tests", onFail: "fail", maxRetries: 0, attempts: 0, completed: false },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice's work output" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ ses_bob: FAIL_VERDICT }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("workflow_failed")
    })

    test("a gate FAIL with onFail='retry' retries the preceding task, then fails on exhaust", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true },
                { kind: "gate", verifier: "bob", criteria: "passes tests", onFail: "retry", maxRetries: 1, attempts: 0, completed: false },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice's work output" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        // First FAIL: within retries (attempts 0 -> 1, maxRetries 1) -> re-dispatch alice.
        let ctx = makeCtx({ ses_bob: FAIL_VERDICT }, calls)
        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.steps![1].attempts).toBe(1)
        expect(task.steps![0].completed).toBe(false)
        expect(task.currentStageIndex).toBe(0)
        const retryCall = calls.find(c => c.sessionId === "ses_alice")
        expect(retryCall).toBeDefined()
        expect(retryCall!.text).toContain("Gate FAILED")
        expect(team.activeTask).toBeDefined()

        // alice re-runs the task -> completes again -> advances back to the gate.
        ctx = makeCtx({ ses_alice: "alice's revised output" }, calls)
        await processIdle(ctx, team, team.members[0], "ses_alice")
        expect(task.currentStageIndex).toBe(1)

        // Second FAIL: attempts 1 -> 2 > maxRetries 1 -> fail the run.
        ctx = makeCtx({ ses_bob: FAIL_VERDICT }, calls)
        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("workflow_failed")
    })

    test("a gate verdict that fails to parse -> fails the run", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true },
                { kind: "gate", verifier: "bob", criteria: "passes tests", onFail: "retry", maxRetries: 2, attempts: 0, completed: false },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice's work output" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ ses_bob: "I cannot decide, no verdict tag" }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("workflow_failed")
    })
})

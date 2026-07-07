/**
 * Workflow handler execution tests (TDD RED→GREEN for Wave 2 T2).
 *
 * Mirrors the pipeline-exec.test.ts stub-ctx harness: makeCtx captures member
 * outputs and records promptAsync dispatches; makeTeam/buildWorkflowTask fixture
 * the state. Drives the handler via processIdle (the real idle entry point) so
 * identity validation (getExpectedMember), output capture, and dispatch all run.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { processIdle } from "../src/orchestration/handlers.js"
import { advanceWorkflowStep } from "../src/orchestration/workflow.js"
import { readRunEvents } from "../src/orchestration/runs.js"
import type { ActiveTask, MemberState, WorkflowStep, WorkflowTask } from "../src/core/types.js"
import { waitUntil } from "../src/core/utils.js"
import { runEventsPath } from "../src/state/paths.js"
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
const INVALID_VERDICT = '<verdict>{"result":"INVALID","rationale":"cannot run tests","diff":""}</verdict>'
const HIGH_SCORE_PASS_VERDICT = '<verdict>{"result":"PASS","rationale":"excellent","diff":"","score":9,"confidence":0.9}</verdict>'
const LOW_SCORE_PASS_VERDICT = '<verdict>{"result":"PASS","rationale":"barely","diff":"","score":5,"confidence":0.5}</verdict>'
const HIGH_SEVERITY_FAIL_VERDICT = '<verdict>{"result":"FAIL","rationale":"risky","diff":"fix risk","score":4,"issues":[{"severity":"high","message":"risk"}]}</verdict>'

async function waitForEvent(directory: string, runId: string, kind: string): Promise<void> {
    const p = runEventsPath(directory, runId)
    await waitUntil(
        () => existsSync(p) && readFileSync(p, "utf8").includes(`"kind":"${kind}"`),
        { timeoutMs: 2000, pollMs: 10 },
    )
}

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
        expect(task.steps![0].output).toContain("alice's step-1 result")
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

    test("a later task step receives the prior step's own output snapshot", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "draft", completed: true, output: "step-1 snapshot" },
                { kind: "task", member: "bob", task: "polish", completed: false },
            ],
            currentStageIndex: 0,
            responses: { alice: "latest alice response should not be used" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({}, calls)

        await advanceWorkflowStep(ctx, team)

        const bobCall = calls.find(c => c.sessionId === "ses_bob")
        expect(bobCall).toBeDefined()
        expect(bobCall!.text).toContain("step-1 snapshot")
        expect(bobCall!.text).not.toContain("latest alice response should not be used")
    })

    test("a missing next-step session fails explicitly instead of stalling", async () => {
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
                { name: "bob" },
            ],
        })
        const ctx = makeCtx({ ses_alice: "done" }, calls)

        await processIdle(ctx, team, team.members[0], "ses_alice")

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("workflow_failed:no_session:bob")
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
        await waitForEvent(team.directory, task.runId!, "retry")
        const events = await readRunEvents(team.directory, task.runId!)
        const retryEvent = events.find(e => e.kind === "retry")
        expect(retryEvent?.stage).toBe(1)
        expect(retryEvent?.detail).toContain("workflow step 2")
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

    test("a gate verdict that fails to parse -> fails the run as workflow_invalid", async () => {
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
        expect(leaderCall!.text).toContain("workflow_invalid")
    })

    test("a gate INVALID verdict does not retry the target producer", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true, output: "alice output" },
                { kind: "gate", verifier: "bob", criteria: "passes tests", onFail: "retry", maxRetries: 2, attempts: 0, completed: false },
            ],
            currentStageIndex: 1,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ ses_bob: INVALID_VERDICT }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(team.status).toBe("failed")
        expect(task.steps![1].attempts).toBe(0)
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("workflow_invalid")
    })

    test("a gate target_step verifies the selected previous task step", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "draft", completed: true, output: "selected step output" },
                { kind: "task", member: "carol", task: "other", completed: true, output: "nearest task output" },
                { kind: "gate", verifier: "bob", targetStepIndex: 0, criteria: "check draft", completed: false },
            ],
            currentStageIndex: 2,
            responses: { alice: "latest alice response", carol: "latest carol response" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        })
        const ctx = makeCtx({}, calls)

        await advanceWorkflowStep(ctx, team)

        const bobCall = calls.find(c => c.sessionId === "ses_bob")
        expect(bobCall).toBeDefined()
        expect(bobCall!.text).toContain("workflow step 1")
        expect(bobCall!.text).toContain("selected step output")
        expect(bobCall!.text).not.toContain("nearest task output")
        expect(bobCall!.text).not.toContain("latest alice response")
    })

    test("on_invalid=retry_verifier re-dispatches the verifier then fails on exhaust", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true, output: "alice output" },
                { kind: "gate", verifier: "bob", criteria: "passes tests", onFail: "fail", onInvalid: "retry_verifier", maxInvalidRetries: 1, invalidAttempts: 0, completed: false },
            ],
            currentStageIndex: 1,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        // First INVALID: within retries (0 -> 1) -> re-dispatch bob, NOT alice.
        let ctx = makeCtx({ ses_bob: INVALID_VERDICT }, calls)
        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.steps![1].invalidAttempts).toBe(1)
        expect(task.steps![0].completed).toBe(true)
        expect(task.currentStageIndex).toBe(1)
        const reverifyCall = calls.find(c => c.sessionId === "ses_bob")
        expect(reverifyCall).toBeDefined()
        expect(reverifyCall!.text).toContain("could not be evaluated")
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)
        expect(team.activeTask).toBeDefined()

        // Second INVALID: 1 -> 2 > maxInvalidRetries 1 -> fail as workflow_invalid.
        ctx = makeCtx({ ses_bob: INVALID_VERDICT }, calls)
        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("workflow_invalid")
    })

    test("on_invalid=escalate forces a human-approval pause even without humanApproval", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true, output: "alice output" },
                { kind: "gate", verifier: "bob", criteria: "passes tests", onFail: "fail", onInvalid: "escalate", completed: false },
                { kind: "task", member: "carol", task: "follow-up", completed: false },
            ],
            currentStageIndex: 1,
            humanApproval: false,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        })
        const ctx = makeCtx({ ses_bob: INVALID_VERDICT }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        // Forced pause: the gate is marked complete (so approve will advance),
        // an approval request was emitted to the leader, and carol was NOT dispatched yet.
        expect(task.steps![1].completed).toBe(true)
        expect(task.approvalStage).toBe(true)
        expect(task.approvalRequest?.kind).toBe("workflow_step")
        expect(calls.some(c => c.sessionId === "ses_lead" && c.text.includes("could not be evaluated"))).toBe(true)
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(false)
        expect(team.activeTask).toBeDefined()
    })

    test("a gate target_step with a string id verifies the named task step", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", id: "design", member: "alice", task: "draft", completed: true, output: "design output" },
                { kind: "task", member: "carol", task: "tests", completed: true, output: "tests output" },
                { kind: "gate", id: "verify-design", verifier: "bob", targetStepIndex: 0, criteria: "design ok", completed: false },
            ],
            currentStageIndex: 2,
            responses: { alice: "latest alice", carol: "latest carol" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        })
        const ctx = makeCtx({}, calls)

        await advanceWorkflowStep(ctx, team)

        const bobCall = calls.find(c => c.sessionId === "ses_bob")
        expect(bobCall).toBeDefined()
        expect(bobCall!.text).toContain("design output")
        expect(bobCall!.text).not.toContain("tests output")
    })

    test("a gate with where score asks the verifier to emit score/confidence", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "impl", completed: true, output: "impl" },
                { kind: "gate", verifier: "bob", criteria: "ok", onPassGoto: 3, where: { kind: "score_gte", value: 8 }, jumpCount: 0, completed: false },
                { kind: "task", member: "carol", task: "premium", completed: false },
            ],
            currentStageIndex: 1,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        })
        const ctx = makeCtx({}, calls)

        await advanceWorkflowStep(ctx, team)

        const bobCall = calls.find(c => c.sessionId === "ses_bob")
        expect(bobCall).toBeDefined()
        expect(bobCall!.text).toContain("score")
        expect(bobCall!.text).toContain("confidence")
    })

    test("a gate without where does not request structured fields", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "impl", completed: true, output: "impl" },
                { kind: "gate", verifier: "bob", criteria: "ok", completed: false },
            ],
            currentStageIndex: 1,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({}, calls)

        await advanceWorkflowStep(ctx, team)

        const bobCall = calls.find(c => c.sessionId === "ses_bob")
        expect(bobCall).toBeDefined()
        expect(bobCall!.text).not.toContain("structured score")
        expect(bobCall!.text).not.toContain("structured issues")
    })

    test("a multi-target gate verifies all selected task outputs", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", id: "api", member: "alice", task: "api", completed: true, output: "api output" },
                { kind: "task", id: "tests", member: "carol", task: "tests", completed: true, output: "tests output" },
                { kind: "task", id: "docs", member: "dave", task: "docs", completed: true, output: "docs output" },
                { kind: "gate", verifier: "bob", targetStepIndices: [0, 2], criteria: "api and docs agree", completed: false },
            ],
            currentStageIndex: 3,
            responses: { alice: "latest api", carol: "latest tests", dave: "latest docs" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
            ],
        })
        const ctx = makeCtx({}, calls)

        await advanceWorkflowStep(ctx, team)

        const bobCall = calls.find(c => c.sessionId === "ses_bob")
        expect(bobCall).toBeDefined()
        expect(bobCall!.text).toContain("workflow steps 1, 3")
        expect(bobCall!.text).toContain("[Step 1 output from alice]")
        expect(bobCall!.text).toContain("api output")
        expect(bobCall!.text).toContain("[Step 3 output from dave]")
        expect(bobCall!.text).toContain("docs output")
        expect(bobCall!.text).not.toContain("tests output")
        expect(bobCall!.text).not.toContain("latest api")
    })

    test("a multi-target gate FAIL retry resets from the earliest target", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "api", completed: true, output: "api output" },
                { kind: "task", member: "carol", task: "tests", completed: true, output: "tests output" },
                { kind: "task", member: "dave", task: "docs", completed: true, output: "docs output" },
                { kind: "gate", verifier: "bob", targetStepIndices: [0, 2], criteria: "all consistent", onFail: "retry", maxRetries: 1, attempts: 0, completed: false },
            ],
            currentStageIndex: 3,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
            ],
        })
        const ctx = makeCtx({ ses_bob: FAIL_VERDICT }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.steps![0].completed).toBe(false)
        expect(task.steps![1].completed).toBe(false)
        expect(task.steps![2].completed).toBe(false)
        expect(task.currentStageIndex).toBe(0)
        const aliceCall = calls.find(c => c.sessionId === "ses_alice")
        expect(aliceCall).toBeDefined()
        expect(aliceCall!.text).toContain("Gate FAILED")
        expect(aliceCall!.text).toContain("api")
    })
})

describe("handleWorkflowIdle (via processIdle): conditional jumps", () => {
    test("on_pass_goto forward skips intermediate steps", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "build", completed: true, output: "build output" },
                { kind: "gate", verifier: "bob", criteria: "build ok", onPassGoto: 3, jumpCount: 0, completed: false },
                { kind: "task", member: "carol", task: "polish", completed: false },
                { kind: "task", member: "dave", task: "package", completed: false },
            ],
            currentStageIndex: 1,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
            ],
        })
        const ctx = makeCtx({ ses_bob: PASS_VERDICT }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.steps![1].jumpCount).toBe(1)
        expect(task.steps![2].completed).toBe(true)
        expect(task.steps![2].skipped).toBe(true)
        expect(task.currentStageIndex).toBe(3)
        const daveCall = calls.find(c => c.sessionId === "ses_dave")
        expect(daveCall).toBeDefined()
        expect(daveCall!.text).toContain("package")
        expect(daveCall!.text).toContain("[Workflow jump: on_pass]")
        expect(daveCall!.text).toContain("Verdict: PASS")
        expect(daveCall!.text).toContain("Rationale: ok")
        // carol was skipped, never dispatched
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(false)
    })

    test("on_fail_goto backward resets and re-dispatches the target", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "impl", completed: true, output: "first impl" },
                { kind: "gate", verifier: "bob", criteria: "ok", onFail: "fail", onFailGoto: 0, jumpCount: 0, completed: false },
            ],
            currentStageIndex: 1,
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

        expect(task.steps![1].jumpCount).toBe(1)
        expect(task.steps![0].completed).toBe(false)
        expect(task.steps![0].output).toBeUndefined()
        expect(task.currentStageIndex).toBe(0)
        const aliceCall = calls.find(c => c.sessionId === "ses_alice")
        expect(aliceCall).toBeDefined()
        expect(aliceCall!.text).toContain("impl")
        expect(aliceCall!.text).toContain("[Workflow jump: on_fail]")
        expect(aliceCall!.text).toContain("Verdict: FAIL")
        expect(aliceCall!.text).toContain("Rationale: wrong")
        expect(aliceCall!.text).toContain("Diff: off by one")
        expect(team.activeTask).toBeDefined()
    })

    test("on_invalid_goto jumps instead of terminating", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "impl", completed: true, output: "impl output" },
                { kind: "gate", verifier: "bob", criteria: "ok", onInvalid: "fail", onInvalidGoto: 2, jumpCount: 0, completed: false },
                { kind: "task", member: "carol", task: "fallback", completed: false },
            ],
            currentStageIndex: 1,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        })
        const ctx = makeCtx({ ses_bob: INVALID_VERDICT }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.steps![1].jumpCount).toBe(1)
        expect(task.currentStageIndex).toBe(2)
        const carolCall = calls.find(c => c.sessionId === "ses_carol")
        expect(carolCall).toBeDefined()
        expect(carolCall!.text).toContain("fallback")
        expect(carolCall!.text).toContain("[Workflow jump: on_invalid:INVALID]")
        expect(carolCall!.text).toContain("Verdict: INVALID")
        expect(carolCall!.text).toContain("Rationale: cannot run tests")
        expect(team.activeTask).toBeDefined()
    })

    test("max_jumps exceeded terminates as workflow_failed:jump_limit", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "impl", completed: true, output: "impl" },
                { kind: "gate", verifier: "bob", criteria: "ok", onFail: "fail", onFailGoto: 0, maxJumps: 1, jumpCount: 1, completed: false },
            ],
            currentStageIndex: 1,
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
        expect(leaderCall!.text).toContain("workflow_failed:jump_limit")
    })

    test("on_pass_goto with where only jumps when the structured score matches", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "impl", completed: true, output: "impl" },
                { kind: "gate", verifier: "bob", criteria: "ok", onPassGoto: 3, where: { kind: "score_gte", value: 8 }, jumpCount: 0, completed: false },
                { kind: "task", member: "carol", task: "fallback polish", completed: false },
                { kind: "task", member: "dave", task: "premium polish", completed: false },
            ],
            currentStageIndex: 1,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
            ],
        })
        const ctx = makeCtx({ ses_bob: HIGH_SCORE_PASS_VERDICT }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.steps![1].score).toBe(9)
        expect(task.steps![1].confidence).toBe(0.9)
        expect(task.currentStageIndex).toBe(3)
        expect(task.steps![2].skipped).toBe(true)
        const daveCall = calls.find(c => c.sessionId === "ses_dave")
        expect(daveCall).toBeDefined()
        expect(daveCall!.text).toContain("premium polish")
        expect(daveCall!.text).toContain("when:score_gte")
    })

    test("on_pass_goto with where falls back to linear advance when the score does not match", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "impl", completed: true, output: "impl" },
                { kind: "gate", verifier: "bob", criteria: "ok", onPassGoto: 3, where: { kind: "score_gte", value: 8 }, jumpCount: 0, completed: false },
                { kind: "task", member: "carol", task: "fallback polish", completed: false },
                { kind: "task", member: "dave", task: "premium polish", completed: false },
            ],
            currentStageIndex: 1,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
            ],
        })
        const ctx = makeCtx({ ses_bob: LOW_SCORE_PASS_VERDICT }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.currentStageIndex).toBe(2)
        expect(calls.some(c => c.sessionId === "ses_dave")).toBe(false)
        const carolCall = calls.find(c => c.sessionId === "ses_carol")
        expect(carolCall).toBeDefined()
        expect(carolCall!.text).toContain("fallback polish")
    })

    test("on_fail_goto with where jumps on high-severity issues", async () => {
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "impl", completed: true, output: "impl" },
                { kind: "gate", verifier: "bob", criteria: "ok", onFail: "fail", onFailGoto: 0, where: { kind: "has_issue_severity", value: "high" }, jumpCount: 0, completed: false },
            ],
            currentStageIndex: 1,
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({ ses_bob: HIGH_SEVERITY_FAIL_VERDICT }, calls)

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.steps![1].issues).toEqual([{ severity: "high", message: "risk" }])
        expect(task.currentStageIndex).toBe(0)
        const aliceCall = calls.find(c => c.sessionId === "ses_alice")
        expect(aliceCall).toBeDefined()
        expect(aliceCall!.text).toContain("when:has_issue_severity")
    })
})

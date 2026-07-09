import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask, MemberState, WorkflowStep, WorkflowTask } from "../src/core/types.js"
import { advanceWorkflowStep, handleWorkflowIdle } from "../src/orchestration/workflow.js"
import { processIdle } from "../src/orchestration/handlers.js"
import { readRunEvents } from "../src/orchestration/runs.js"
import { waitUntil } from "../src/core/utils.js"
import { runEventsPath } from "../src/state/paths.js"
import { existsSync, readFileSync } from "node:fs"
import { rebuildSessionIndex } from "../src/state/resolve.js"
import { AsyncMutex } from "../src/state/locks.js"
import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import type { Team } from "../src/state/store.js"
import { makeMember, makeState, makeToolContext } from "./helpers.js"
import { teamFixWorkflowTool } from "../src/tools/fixflow.js"

const PASS_VERDICT = '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>'

type DispatchCall = { readonly sessionId: string; readonly text: string }

function makeCtx(root: string, outputs: Record<string, string> = {}, calls: DispatchCall[] = []): PluginContext {
    return {
        storageRoot: root,
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

function makeWorkflowTask(steps: WorkflowStep[]): WorkflowTask {
    return {
        type: "workflow",
        startedAt: Date.now(),
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
        steps,
    } as WorkflowTask
}

function makeTeam(root: string, task: ActiveTask, members: MemberState[]): Team {
    return {
        version: 1,
        teamRunId: "wf-event-run",
        teamName: "wf-event-team",
        status: "busy",
        leadSessionId: "ses_lead",
        members,
        bounds: {
            maxMembers: 8, maxParallelMembers: 4, maxMessagesPerRun: 100, maxWallClockMinutes: 30,
            maxMemberTurns: 50, maxTasks: 200, messagePayloadMaxBytes: 32768, messageUnreadMaxBytes: 1048576,
        },
        createdAt: Date.now(),
        activeTask: task,
        mutex: new AsyncMutex(),
        directory: root,
    } as unknown as Team
}

async function waitForEventKind(directory: string, runId: string, kind: string): Promise<void> {
    const path = runEventsPath(directory, runId)
    await waitUntil(
        () => existsSync(path) && readFileSync(path, "utf8").includes(`"kind":"${kind}"`),
        { timeoutMs: 2000, pollMs: 10 },
    )
}

describe("workflow run event schema + correlation id", () => {
    test("a task step dispatch and capture share a correlationId and carry stepIndex", async () => {
        // Given
        const root = mkdtempSync(join(tmpdir(), "octeam-wf-evroot-"))
        const task = makeWorkflowTask([{ kind: "task", member: "alice", task: "do work", completed: false }])
        const team = makeTeam(root, task, [{ name: "alice", sessionId: "ses_alice", initialized: true, turnCount: 0, status: "idle" }])
        const ctx = makeCtx(root, { ses_alice: "alice output" })

        // When: advance dispatches step 0 (sets step.correlationId), then alice's idle captures it.
        await advanceWorkflowStep(ctx, team)
        await processIdle(ctx, team, team.members[0], "ses_alice")
        await waitForEventKind(root, task.runId!, "captured")

        // Then: the workflow-specific captured event carries stepIndex and the
        // correlationId assigned at dispatch time (the generic capture event has
        // no stepIndex; filter for the workflow one).
        const events = await readRunEvents(root, task.runId!)
        const captured = events.find(e => e.kind === "captured" && e.stepIndex === 0)
        expect(captured).toBeDefined()
        expect(captured?.correlationId).toBeDefined()
    })

    test("a gate verdict event carries stepIndex and the dispatch correlationId", async () => {
        // Given
        const root = mkdtempSync(join(tmpdir(), "octeam-wf-evroot2-"))
        const task = makeWorkflowTask([
            { kind: "task", member: "alice", task: "produce", completed: false },
            { kind: "gate", verifier: "bob", criteria: "ok", attempts: 0, completed: false },
        ])
        const team = makeTeam(root, task, [
            { name: "alice", sessionId: "ses_alice", initialized: true, turnCount: 0, status: "idle" },
            { name: "bob", sessionId: "ses_bob", initialized: true, turnCount: 0, status: "idle" },
        ])
        const ctx = makeCtx(root, { ses_alice: "produced", ses_bob: PASS_VERDICT })

        // When: dispatch alice -> alice produces -> dispatch bob gate -> bob verdicts.
        await advanceWorkflowStep(ctx, team)
        await processIdle(ctx, team, team.members[0], "ses_alice")
        await waitForEventKind(root, task.runId!, "dispatched")
        await processIdle(ctx, team, team.members[1], "ses_bob")
        await waitForEventKind(root, task.runId!, "verdict")

        // Then
        const events = await readRunEvents(root, task.runId!)
        const gateDispatch = events.find(e => e.kind === "dispatched" && e.member === "bob")
        const verdict = events.find(e => e.kind === "verdict")
        expect(gateDispatch?.stepIndex).toBe(1)
        expect(verdict?.stepIndex).toBe(1)
        expect(verdict?.correlationId).toBe(gateDispatch?.correlationId)
    })

    test("team_fix_workflow records a repaired event on a successful op", async () => {
        // Given
        const root = mkdtempSync(join(tmpdir(), "octeam-wf-repaired-"))
        const masterSid = "ses_wf_repaired_master"
        const task = makeWorkflowTask([
            { kind: "task", member: "alice", task: "optional", completed: false },
            { kind: "task", member: "bob", task: "continue", completed: false },
        ])
        await initTeamState(root, makeState("alpha", masterSid, [
            makeMember("alice", "ses_wf_repaired_alice"),
            makeMember("bob", "ses_wf_repaired_bob"),
        ], Date.now()), masterSid)
        const team = await loadTeamState(root, "alpha", masterSid)
        await team.mutex.runExclusive(async () => {
            team.status = "busy"
            team.activeTask = task
            await saveTeamState(team)
        })
        await rebuildSessionIndex(root, `${root}__unused`)
        const calls: DispatchCall[] = []

        // When
        const result = await teamFixWorkflowTool(makeCtx(root, {}, calls)).execute(
            { team_id: "alpha", op: "skip", step: 1 },
            makeToolContext(masterSid),
        )

        // Then
        expect(result).toContain("skipped step 1")
        await waitForEventKind(team.directory, task.runId!, "repaired")
        const events = await readRunEvents(team.directory, task.runId!)
        const repaired = events.find(e => e.kind === "repaired")
        expect(repaired?.stepIndex).toBe(0)
        expect(repaired?.detail).toContain("op=skip")
    })
})

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { WorkflowStep, WorkflowTask } from "../src/core/types.js"
import { advanceWorkflowStep } from "../src/orchestration/workflow/engine.js";
import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import { readRunEvents } from "../src/orchestration/records/runs.js"
import { waitUntil } from "../src/core/utils.js"
import { runEventsPath } from "../src/state/paths.js"
import { existsSync, readFileSync } from "node:fs"
import { rebuildSessionIndex } from "../src/state/resolve.js"
import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import { makeCtx, makeMember, makeState, makeTeam, makeToolContext, makeWorkflowTask as sharedMakeWorkflowTask, type DispatchCall } from "./helpers.js"
import { teamFixWorkflowTool } from "../src/tools/control/fixflow.js"

const PASS_VERDICT = '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>'



function makeWorkflowTask(steps: WorkflowStep[]): WorkflowTask {
    return sharedMakeWorkflowTask({
        steps,
        wallClockTimeoutMs: Number.MAX_SAFE_INTEGER,
    })
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
        const team = makeTeam({ directory: root, activeTask: task, members: [{ name: "alice", sessionId: "ses_alice", initialized: true, turnCount: 0, status: "idle" }] })
        const ctx = makeCtx({ storageRoot: root, outputs: { ses_alice: "alice output" }, calls: [] })

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
        const team = makeTeam({ directory: root, activeTask: task, members: [
            { name: "alice", sessionId: "ses_alice", initialized: true, turnCount: 0, status: "idle" },
            { name: "bob", sessionId: "ses_bob", initialized: true, turnCount: 0, status: "idle" },
        ]})
        const ctx = makeCtx({ storageRoot: root, outputs: { ses_alice: "produced", ses_bob: PASS_VERDICT }, calls: [] })

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
        const result = await teamFixWorkflowTool(makeCtx({ storageRoot: root, calls })).execute(
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

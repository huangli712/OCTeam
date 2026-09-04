/**
 * Regression test: a forward goto must not silently dispatch a task
 * whose explicit `inputs` reference skipped steps.
 *
 * Bug: src/orchestration/workflow/engine.ts applyJump handles forward jumps
 * by marking intermediate steps as completed+skipped. The upstream-context
 * builder (workflow/upstream.ts) then iterates `inputs` and silently skips
 * any candidate where `!s?.completed`. So a task dispatched after a forward
 * goto that skipped one of its declared `inputs` receives an EMPTY upstream
 * context — the task runs without the data its author declared as required.
 *
 * Author intent: `inputs: [3]` is an explicit declaration that step 3's
 * output is required. A forward goto that skips step 3 violates this
 * declaration; the run must surface a clear error rather than silently
 * producing work product without its declared dependencies.
 *
 * Fix: at dispatch time (after a forward jump, or any time we dispatch a
 * task whose `inputs` are declared), verify every input index points to a
 * step that completed NON-SKIPPED. If any input is skipped or missing,
 * finish the run with a deterministic "missing declared input" error
 * instead of dispatching an under-supplied task.
 */

import { afterAll, describe, expect, test } from "bun:test"

import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import type { WorkflowGateStep, WorkflowStep } from "../src/core/types.js"
import { cleanupTmpRoots, makeCtx, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js"

function gateStepAt(steps: readonly WorkflowStep[] | undefined, index: number): WorkflowGateStep {
    const step = steps?.[index]
    if (step?.kind !== "gate") throw new Error(`Expected gate step at index ${index}`)
    return step
}

afterAll(cleanupTmpRoots)

const PASS_VERDICT =
    '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>'

describe("forward goto cannot skip target's explicit inputs", () => {
    test("forward goto to a task whose inputs were skipped fails the run with a clear error", async () => {
        const calls: DispatchCall[] = []
        // Steps: 0 task (alice) -> 1 gate (bob) on_pass_goto:3 -> 2 task (carol, skipped) -> 3 task (dave, inputs:[2])
        // Gate at step 1 jumps forward to step 3, skipping step 2. Step 3
        // declares inputs:[2] — the skipped step. Pre-fix: step 3 dispatches
        // with empty upstream; post-fix: the run fails with a clear error.
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "build",
                    completed: true,
                    output: "build output",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "build ok",
                    onPassGoto: 3,
                    jumpCount: 0,
                    completed: false,
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "polish",
                    completed: false,
                },
                {
                    kind: "task",
                    member: "dave",
                    task: "package (depends on polish)",
                    inputs: [2], // declares dependency on step 2 (carol)
                    completed: false,
                },
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
        const ctx = makeCtx({ outputs: { ses_bob: PASS_VERDICT }, calls: calls })

        await processIdle(ctx, team, team.members[1], "ses_bob")

        // The forward jump happened.
        expect(gateStepAt(task.steps, 1).jumpCount).toBe(1)
        // Step 2 is marked skipped.
        expect(task.steps![2].completed).toBe(true)
        expect(task.steps![2].skipped).toBe(true)

        // Fix: dave (step 3) MUST NOT be dispatched because his declared
        // input (step 2) was skipped. Either:
        //   - the run finishes with a "missing declared input" error, OR
        //   - dave is never called.
        // Pre-fix: dave IS dispatched with empty upstream (BAD).
        const daveCall = calls.find(c => c.sessionId === "ses_dave")
        expect(daveCall).toBeUndefined()

        // The run should be terminated (no longer busy).
        expect(team.status).not.toBe("busy")
    })

    test("control: forward goto to a task whose inputs were NOT skipped dispatches normally", async () => {
        const calls: DispatchCall[] = []
        // Steps: 0 task (alice) -> 1 gate (bob) on_pass_goto:3 -> 2 task (carol, skipped) -> 3 task (dave, inputs:[0])
        // Step 3 declares inputs:[0] (alice, completed). Step 2 is skipped
        // but is NOT in dave's inputs. dave SHOULD be dispatched normally.
        const task = makeWorkflowTask({
            steps: [
                {
                    kind: "task",
                    member: "alice",
                    task: "build",
                    completed: true,
                    output: "build output",
                },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "build ok",
                    onPassGoto: 3,
                    jumpCount: 0,
                    completed: false,
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "polish (optional)",
                    completed: false,
                },
                {
                    kind: "task",
                    member: "dave",
                    task: "package (depends on build only)",
                    inputs: [0], // declares dependency on step 0 (alice, completed)
                    completed: false,
                },
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
        const ctx = makeCtx({ outputs: { ses_bob: PASS_VERDICT }, calls: calls })

        await processIdle(ctx, team, team.members[1], "ses_bob")

        expect(task.currentStageIndex).toBe(3)
        const daveCall = calls.find(c => c.sessionId === "ses_dave")
        expect(daveCall).toBeDefined()
        // Dave's prompt should include alice's output (his declared input).
        expect(daveCall!.text).toContain("build output")
    })
})

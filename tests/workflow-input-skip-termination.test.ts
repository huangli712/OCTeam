/**
 * Regression: when dispatchTaskStep's input guard calls finishRun (because
 * a declared input was skipped), the run is terminated. The pre-fix code
 * returned plain false, which the fanout advance path interpreted as
 * "actor unavailable inside a tolerance fanout" → markWorkflowFanoutBranchErrored
 * → "degraded" → advance continues dispatching OTHER branches against the
 * already-terminated run.
 *
 * The fix: at every dispatchTaskStep call site that handles false, detect
 * team.activeTask !== task (run terminated) and bail before invoking
 * handleWorkflowDispatchUnavailable.
 */
import { describe, expect, test } from "bun:test"

import { advanceWorkflowStep } from "../src/orchestration/workflow/engine.js"
import type { WorkflowTask, WorkflowStep } from "../src/core/types.js"
import { makeCtx, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js"

describe("input-skipped termination in a tolerance fanout", () => {
    test("advance does not dispatch later branches after input-guard finishRun", async () => {
        // Layout: tolerance fanout with three branches, processed in index order.
        //   0: fanout (maxErrored=2)
        //   1: task bob-pre (branch b1) — completed+skipped (forward goto)
        //   2: task bob     (branch b1) — declares inputs:[1] → input guard
        //                                fires finishRun on dispatch attempt
        //   3: task carol   (branch b2) — independent, ready in same iteration
        //   4: task dave    (branch b3) — independent, ready in same iteration
        //   5: join
        //
        // Contract: after bob's input guard terminates the run, carol and
        // dave MUST NOT be dispatched. Pre-fix advance would have degraded
        // through handleWorkflowDispatchUnavailable and kept dispatching.
        //
        // We sort ready indices so bob (index 2) is attempted before carol (3)
        // and dave (4). alice is omitted to keep the ready list ordered.
        const calls: DispatchCall[] = []
        const task: WorkflowTask = makeWorkflowTask({
            steps: [
                {
                    kind: "fanout",
                    completed: false,
                    fanout: {
                        branchIds: ["b1", "b2", "b3"],
                        branchRanges: [
                            { startIndex: 1, endIndex: 2 },
                            { startIndex: 3, endIndex: 3 },
                            { startIndex: 4, endIndex: 4 },
                        ],
                        joinIndex: 5,
                        maxErrored: 2,
                        joinPolicy: "all",
                    },
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "bob skipped pre",
                    completed: true,
                    skipped: true,
                    branch: { fanoutIndex: 0, branchId: "b1", branchIndex: 0, joinIndex: 5 },
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "bob main needs pre",
                    completed: false,
                    inputs: [1], // declares dependency on the skipped step
                    branch: { fanoutIndex: 0, branchId: "b1", branchIndex: 1, joinIndex: 5 },
                },
                {
                    kind: "task",
                    member: "carol",
                    task: "carol independent work",
                    completed: false,
                    branch: { fanoutIndex: 0, branchId: "b2", branchIndex: 0, joinIndex: 5 },
                },
                {
                    kind: "task",
                    member: "dave",
                    task: "dave independent work",
                    completed: false,
                    branch: { fanoutIndex: 0, branchId: "b3", branchIndex: 0, joinIndex: 5 },
                },
                {
                    kind: "join",
                    completed: false,
                    join: { joinPolicy: "all", joinIndex: 5, branchIds: ["b1", "b2", "b3"] },
                },
            ] as unknown as WorkflowStep[],
            activeStepIndices: [2, 3, 4],
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
                { name: "dave", sessionId: "ses_dave" },
            ],
        })
        const ctx = makeCtx({ calls })

        await advanceWorkflowStep(ctx, team)

        // Run MUST be terminated by the input guard.
        expect(team.activeTask).toBeUndefined()
        // Bob (the input violator) MUST NOT have been dispatched — the guard
        // fires before dispatchToMember.
        const bobDispatch = calls.find(c => c.sessionId === "ses_bob")
        expect(bobDispatch).toBeUndefined()
        // The contract: NO step processed AFTER bob's termination may
        // dispatch. Carol (index 3) and dave (index 4) come after bob (2).
        // Pre-fix: handleWorkflowDispatchUnavailable returned "degraded" and
        // the loop kept going, dispatching carol and possibly dave.
        // Post-fix: the activeTask check bails the loop immediately.
        const carolDispatch = calls.find(c => c.sessionId === "ses_carol")
        expect(carolDispatch).toBeUndefined()
        const daveDispatch = calls.find(c => c.sessionId === "ses_dave")
        expect(daveDispatch).toBeUndefined()
    })
})

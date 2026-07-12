import { describe, expect, test } from "bun:test"

import type { WorkflowStep, WorkflowTask } from "../src/core/types.js"
import {
    getActiveWorkflowStepIndices,
    isWorkflowJoinSatisfied,
    readyWorkflowStepIndices,
    validateWorkflowDag,
} from "../src/orchestration/workflow/dag.js"

function workflowTask(fields: {
    readonly currentStageIndex: number
    readonly steps: WorkflowStep[]
    readonly activeStepIndices?: number[]
}): WorkflowTask {
    return {
        type: "workflow",
        startedAt: 0,
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: fields.currentStageIndex,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: "workflow-dag-test",
        signoffPolicy: "none",
        steps: fields.steps,
        ...(fields.activeStepIndices === undefined ? {} : { activeStepIndices: fields.activeStepIndices }),
    }
}

function fanoutWorkflowSteps(fields: {
    readonly apiCompleted: boolean
    readonly testsCompleted: boolean
}): WorkflowStep[] {
    return [
        {
            kind: "fanout",
            completed: true,
            fanout: {
                branchIds: ["api", "tests"],
                branchRanges: [
                    { startIndex: 1, endIndex: 1 },
                    { startIndex: 2, endIndex: 2 },
                ],
                joinIndex: 3,
                maxErrored: 0,
            },
        },
        {
            kind: "task",
            member: "alice",
            task: "Build the API change",
            completed: fields.apiCompleted,
            branch: {
                fanoutIndex: 0,
                branchId: "api",
                branchIndex: 0,
                joinIndex: 3,
            },
        },
        {
            kind: "task",
            member: "bob",
            task: "Build the test change",
            completed: fields.testsCompleted,
            branch: {
                fanoutIndex: 0,
                branchId: "tests",
                branchIndex: 1,
                joinIndex: 3,
            },
        },
        {
            kind: "join",
            completed: false,
            join: {
                fanoutIndex: 0,
                branchTailIndices: [1, 2],
                maxErrored: 0,
            },
        },
    ]
}

describe("workflow DAG helpers", () => {
    test("uses activeStepIndices as the frontier source of truth when present", () => {
        // Given
        const task = workflowTask({
            currentStageIndex: 1,
            activeStepIndices: [2, 4],
            steps: [
                { kind: "task", member: "alice", task: "one", completed: false },
                { kind: "task", member: "bob", task: "two", completed: false },
            ],
        })

        // When
        const indices = getActiveWorkflowStepIndices(task)

        // Then
        expect(indices).toEqual([2, 4])
    })

    test("falls back to currentStageIndex for legacy workflow state", () => {
        // Given
        const task = workflowTask({
            currentStageIndex: 1,
            steps: [
                { kind: "task", member: "alice", task: "one", completed: true },
                { kind: "task", member: "bob", task: "two", completed: false },
            ],
        })

        // When
        const indices = getActiveWorkflowStepIndices(task)

        // Then
        expect(indices).toEqual([1])
    })

    test("returns one ready step for a linear workflow", () => {
        // Given
        const task = workflowTask({
            currentStageIndex: 1,
            steps: [
                { kind: "task", member: "alice", task: "one", completed: true },
                { kind: "gate", verifier: "bob", criteria: "review", completed: false },
            ],
        })

        // When
        const ready = readyWorkflowStepIndices(task)

        // Then
        expect(ready).toEqual([1])
    })

    test("expands a fanout marker into all branch heads", () => {
        // Given
        const task = workflowTask({
            currentStageIndex: 0,
            activeStepIndices: [0],
            steps: fanoutWorkflowSteps({ apiCompleted: false, testsCompleted: false }),
        })

        // When
        const ready = readyWorkflowStepIndices(task)

        // Then
        expect(ready).toEqual([1, 2])
    })

    test("expanding a fanout marker does not mutate marker completion", () => {
        // Given
        const steps = fanoutWorkflowSteps({ apiCompleted: false, testsCompleted: false })
        const fanout = steps[0]
        if (fanout === undefined) {
            throw new Error("Missing fanout fixture step")
        }
        fanout.completed = false
        const task = workflowTask({
            currentStageIndex: 0,
            activeStepIndices: [0],
            steps,
        })

        // When
        const ready = readyWorkflowStepIndices(task)

        // Then
        expect(ready).toEqual([1, 2])
        expect(fanout.completed).toBe(false)
    })

    test("satisfies a join only after every required branch tail is terminal", () => {
        // Given
        const waitingSteps = fanoutWorkflowSteps({ apiCompleted: true, testsCompleted: false })
        const satisfiedSteps = fanoutWorkflowSteps({ apiCompleted: true, testsCompleted: true })
        const waitingJoin = waitingSteps[3]
        const satisfiedJoin = satisfiedSteps[3]

        // When
        const waiting = isWorkflowJoinSatisfied(waitingSteps, waitingJoin)
        const satisfied = isWorkflowJoinSatisfied(satisfiedSteps, satisfiedJoin)

        // Then
        expect(waiting).toBe(false)
        expect(satisfied).toBe(true)
    })

    test("rejects recursive fanout inside a branch range", () => {
        // Given
        const steps: WorkflowStep[] = [
            {
                kind: "fanout",
                completed: true,
                fanout: {
                    branchIds: ["api"],
                    branchRanges: [{ startIndex: 1, endIndex: 2 }],
                    joinIndex: 3,
                    maxErrored: 0,
                },
            },
            {
                kind: "fanout",
                completed: true,
                branch: {
                    fanoutIndex: 0,
                    branchId: "api",
                    branchIndex: 0,
                    joinIndex: 3,
                },
                fanout: {
                    branchIds: ["nested"],
                    branchRanges: [{ startIndex: 2, endIndex: 2 }],
                    joinIndex: 3,
                    maxErrored: 0,
                },
            },
            {
                kind: "task",
                member: "alice",
                task: "nested branch",
                completed: false,
                branch: {
                    fanoutIndex: 1,
                    branchId: "nested",
                    branchIndex: 0,
                    joinIndex: 3,
                },
            },
            {
                kind: "join",
                completed: false,
                join: {
                    fanoutIndex: 0,
                    branchTailIndices: [2],
                    maxErrored: 0,
                },
            },
        ]

        // When
        const result = validateWorkflowDag(steps)

        // Then
        expect(result).toEqual({ ok: false, reason: "recursive_fanout:1" })
    })
})

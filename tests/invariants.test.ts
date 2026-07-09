import { describe, expect, test } from "bun:test"

import type { WorkflowStep, WorkflowTask } from "../src/core/types.js"
import { checkWorkflowInvariants } from "../src/orchestration/invariants.js"

function workflowTask(fields: {
    readonly steps: WorkflowStep[]
    readonly currentStageIndex?: number
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
        currentStageIndex: fields.currentStageIndex ?? 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: "workflow-invariants-test",
        signoffPolicy: "none",
        steps: fields.steps,
        ...(fields.activeStepIndices === undefined ? {} : { activeStepIndices: fields.activeStepIndices }),
    }
}

function fanoutSteps(fields: {
    readonly apiCompleted: boolean
    readonly testCompleted: boolean
    readonly joinCompleted: boolean
    readonly erroredBranchIds?: readonly string[]
    readonly survivorBranchIds?: readonly string[]
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
                maxErrored: 1,
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
            completed: fields.testCompleted,
            branch: {
                fanoutIndex: 0,
                branchId: "tests",
                branchIndex: 1,
                joinIndex: 3,
            },
        },
        {
            kind: "join",
            completed: fields.joinCompleted,
            join: {
                fanoutIndex: 0,
                branchTailIndices: [1, 2],
                maxErrored: 1,
                ...(fields.erroredBranchIds === undefined ? {} : { erroredBranchIds: fields.erroredBranchIds }),
                ...(fields.survivorBranchIds === undefined ? {} : { survivorBranchIds: fields.survivorBranchIds }),
            },
        },
    ]
}

function expectViolations(task: WorkflowTask): readonly string[] {
    const result = checkWorkflowInvariants(task)
    if (result.ok) throw new Error("Expected workflow invariant violations")
    return result.violations
}

describe("workflow runtime invariants", () => {
    test("accepts a valid fanout runtime state and leaves it unchanged", () => {
        // Given
        const task = workflowTask({
            currentStageIndex: 3,
            activeStepIndices: [3],
            steps: fanoutSteps({
                apiCompleted: true,
                testCompleted: false,
                joinCompleted: false,
                erroredBranchIds: ["tests"],
                survivorBranchIds: ["api"],
            }),
        })
        const before = structuredClone(task)

        // When
        const result = checkWorkflowInvariants(task)

        // Then
        expect(result).toEqual({ ok: true })
        expect(task).toEqual(before)
    })

    test("rejects active frontier indices that are unsorted, duplicated, out of bounds, or already completed", () => {
        // Given
        const task = workflowTask({
            activeStepIndices: [1, 0, 0, 4],
            steps: [
                { kind: "task", member: "alice", task: "done", completed: true },
                { kind: "task", member: "bob", task: "next", completed: false },
            ],
        })

        // When
        const violations = expectViolations(task)

        // Then
        expect(violations).toContain("active[1]: index 0 is not sorted after 1")
        expect(violations).toContain("active[1]: step 0 is completed")
        expect(violations).toContain("active[2]: index 0 is not sorted after 0")
        expect(violations).toContain("active[2]: duplicate index 0")
        expect(violations).toContain("active[3]: index 4 out of bounds")
    })

    test("rejects skipped steps that are not completed", () => {
        // Given
        const task = workflowTask({
            steps: [
                { kind: "task", member: "alice", task: "skipped", completed: false, skipped: true },
            ],
        })

        // When
        const violations = expectViolations(task)

        // Then
        expect(violations).toContain("step 0: skipped requires completed")
    })

    test("rejects gate targets that are not previous task steps or use the verifier as target member", () => {
        // Given
        const task = workflowTask({
            steps: [
                { kind: "task", member: "alice", task: "produce", completed: true },
                { kind: "gate", verifier: "alice", criteria: "review", targetStepIndex: 0, completed: false },
                { kind: "gate", verifier: "carol", criteria: "review", targetStepIndex: 1, completed: false },
            ],
        })

        // When
        const violations = expectViolations(task)

        // Then
        expect(violations).toContain("step 1: verifier matches target 0 member")
        expect(violations).toContain("step 2: target 1 is not a previous task step")
    })

    test("rejects branch metadata that disagrees with its fanout range", () => {
        // Given
        const steps = fanoutSteps({ apiCompleted: false, testCompleted: false, joinCompleted: false })
        const branchStep = steps[1]
        if (branchStep === undefined) throw new Error("Missing branch fixture step")
        branchStep.branch = {
            fanoutIndex: 0,
            branchId: "tests",
            branchIndex: 0,
            joinIndex: 3,
        }
        const task = workflowTask({ activeStepIndices: [1], steps })

        // When
        const violations = expectViolations(task)

        // Then
        expect(violations).toContain("step 1: branchIndex 0 maps to branch api, not tests")
        expect(violations).toContain("step 1: index is outside branch range 2-2")
    })

    test("rejects completed joins when branch tails are not terminal within tolerance", () => {
        // Given
        const task = workflowTask({
            currentStageIndex: 3,
            steps: fanoutSteps({
                apiCompleted: true,
                testCompleted: false,
                joinCompleted: true,
                erroredBranchIds: ["other"],
            }),
        })

        // When
        const violations = expectViolations(task)

        // Then
        expect(violations).toContain("step 3: errored branch other is not in fanout")
        expect(violations).toContain("step 3: completed join has non-terminal branch tests")
    })

    test("rejects fanout ranges that overlap, escape bounds, or reach the join", () => {
        // Given
        const task = workflowTask({
            activeStepIndices: [0],
            steps: [
                {
                    kind: "fanout",
                    completed: false,
                    fanout: {
                        branchIds: ["api", "tests"],
                        branchRanges: [
                            { startIndex: 1, endIndex: 2 },
                            { startIndex: 2, endIndex: 3 },
                        ],
                        joinIndex: 3,
                        maxErrored: 0,
                    },
                },
                {
                    kind: "task",
                    member: "alice",
                    task: "Build the API change",
                    completed: false,
                    branch: { fanoutIndex: 0, branchId: "api", branchIndex: 0, joinIndex: 3 },
                },
                {
                    kind: "task",
                    member: "bob",
                    task: "Build the test change",
                    completed: false,
                    branch: { fanoutIndex: 0, branchId: "tests", branchIndex: 1, joinIndex: 3 },
                },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [2, 2], maxErrored: 0 } },
            ],
        })

        // When
        const violations = expectViolations(task)

        // Then
        expect(violations).toContain("step 0: branch range 1 overlaps 0")
        expect(violations).toContain("step 0: branch range 1 must end before join 3")
    })

    test("rejects retry and jump counters beyond the terminal attempt allowance", () => {
        // Given
        const task = workflowTask({
            steps: [
                { kind: "task", member: "alice", task: "produce", completed: true },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "review",
                    targetStepIndex: 0,
                    maxRetries: 1,
                    attempts: 3,
                    maxInvalidRetries: 0,
                    invalidAttempts: 2,
                    maxTimeoutRetries: 1,
                    timeoutAttempts: 3,
                    maxJumps: 1,
                    jumpCount: 3,
                    completed: false,
                },
            ],
        })

        // When
        const violations = expectViolations(task)

        // Then
        expect(violations).toContain("step 1: attempts 3 exceeds cap 1")
        expect(violations).toContain("step 1: invalidAttempts 2 exceeds cap 0")
        expect(violations).toContain("step 1: timeoutAttempts 3 exceeds cap 1")
        expect(violations).toContain("step 1: jumpCount 3 exceeds cap 1")
    })
})

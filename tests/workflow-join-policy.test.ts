import { describe, expect, test } from "bun:test"

import type { MemberState, WorkflowStep, WorkflowTask } from "../src/core/types.js"
import { checkTermination } from "../src/orchestration/lifecycle/termination.js"
import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import { advanceWorkflowStep } from "../src/orchestration/workflow/engine.js"
import { makeCtx, makeTeam, makeWorkflowTask as sharedMakeWorkflowTask, type DispatchCall } from "./helpers.js"

import type { Team } from "../src/state/store.js"


function makeWorkflowTask(steps: WorkflowStep[], activeStepIndices: number[]): WorkflowTask {
    return sharedMakeWorkflowTask({
        steps,
        activeStepIndices,
        currentStageIndex: activeStepIndices[0] ?? 0,
        wallClockTimeoutMs: Number.MAX_SAFE_INTEGER,
    })
}


function member(team: Team, name: string): MemberState {
    const found = team.members.find(c => c.name === name)
    if (found === undefined) throw new Error(`Missing ${name}`)
    return found
}

describe("workflow join policy runtime semantics", () => {
    test("join_policy='required_branches' joins when a required branch survives and an optional branch errors", async () => {
        // Given: fanout with required_branches=["api"]; qa is optional.
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask(
            [
                { kind: "fanout", completed: true, fanout: { branchIds: ["api", "qa"], branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }], joinIndex: 3, maxErrored: 0, joinPolicy: "required_branches", requiredBranchIds: ["api"] } },
                { kind: "task", member: "alice", task: "api", completed: false, branch: { fanoutIndex: 0, branchId: "api", branchIndex: 0, joinIndex: 3 } },
                { kind: "task", member: "bob", task: "qa", completed: false, branch: { fanoutIndex: 0, branchId: "qa", branchIndex: 1, joinIndex: 3 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2], maxErrored: 0, joinPolicy: "required_branches", requiredBranchIds: ["api"] } },
                { kind: "task", member: "carol", task: "ship", completed: false },
            ],
            [1, 2],
        )
        const team = makeTeam({ activeTask: task, members: [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
            { name: "carol", sessionId: "ses_carol" },
        ]})
        const ctx = makeCtx({ outputs: { ses_alice: "api output", ses_carol: "downstream" }, calls })

        // When: qa branch errors (optional), api branch succeeds.
        const qaMember = member(team, "bob")
        qaMember.status = "errored"
        qaMember.error = "qa outage"
        await checkTermination(ctx, team) // marks qa branch errored
        await processIdle(ctx, team, member(team, "alice"), "ses_alice")

        // Then: join completes (api is required and survived), downstream dispatched.
        expect(task.steps?.[3]?.completed).toBe(true)
        expect(task.activeStepIndices).toEqual([4])
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(true)
    })

    test("join_policy='required_branches' fails fast when a required branch errors", async () => {
        // Given: required_branches=["api"]; api errors.
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask(
            [
                { kind: "fanout", completed: true, fanout: { branchIds: ["api", "qa"], branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }], joinIndex: 3, maxErrored: 0, joinPolicy: "required_branches", requiredBranchIds: ["api"] } },
                { kind: "task", member: "alice", task: "api", completed: false, branch: { fanoutIndex: 0, branchId: "api", branchIndex: 0, joinIndex: 3 } },
                { kind: "task", member: "bob", task: "qa", completed: false, branch: { fanoutIndex: 0, branchId: "qa", branchIndex: 1, joinIndex: 3 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2], maxErrored: 0, joinPolicy: "required_branches", requiredBranchIds: ["api"] } },
            ],
            [1, 2],
        )
        const team = makeTeam({ activeTask: task, members: [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
        ]})
        const ctx = makeCtx({ calls })

        // When: api (required) errors.
        const apiMember = member(team, "alice")
        apiMember.status = "errored"
        apiMember.error = "api outage"
        await checkTermination(ctx, team)

        // Then: workflow fails immediately.
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
    })

    test("useSurvivors lets join_policy='all' continue with surviving branch outputs", async () => {
        // Given: strict all policy with an explicit survivor override.
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask(
            [
                { kind: "fanout", completed: true, fanout: { branchIds: ["api", "qa"], branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }], joinIndex: 3, maxErrored: 0, joinPolicy: "all", useSurvivors: true } },
                { kind: "task", member: "alice", task: "api", completed: false, branch: { fanoutIndex: 0, branchId: "api", branchIndex: 0, joinIndex: 3 } },
                { kind: "task", member: "bob", task: "qa", completed: false, branch: { fanoutIndex: 0, branchId: "qa", branchIndex: 1, joinIndex: 3 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2], maxErrored: 0, joinPolicy: "all", useSurvivors: true } },
                { kind: "task", member: "carol", task: "ship", completed: false },
            ],
            [1, 2],
        )
        const team = makeTeam({ activeTask: task, members: [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
            { name: "carol", sessionId: "ses_carol" },
        ]})
        const ctx = makeCtx({ outputs: { ses_alice: "api output" }, calls })

        // When: qa errors but api succeeds.
        member(team, "bob").status = "errored"
        await checkTermination(ctx, team)
        await processIdle(ctx, team, member(team, "alice"), "ses_alice")

        // Then: all would normally fail on the error, but useSurvivors joins api only.
        expect(task.steps?.[3]?.completed).toBe(true)
        expect(task.steps?.[3]?.join?.erroredBranchIds).toEqual(["qa"])
        expect(task.steps?.[3]?.join?.joinedOutput).toContain("api output")
        expect(task.steps?.[3]?.join?.joinedOutput).not.toContain("qa")
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(true)
    })

    test("join_policy='quorum' joins once the quorum threshold of branches survives", async () => {
        // Given: 3 branches, quorum 0.5 => need 2 survivors.
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask(
            [
                { kind: "fanout", completed: true, fanout: { branchIds: ["a", "b", "c"], branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }, { startIndex: 3, endIndex: 3 }], joinIndex: 4, maxErrored: 0, joinPolicy: "quorum", quorum: 0.5 } },
                { kind: "task", member: "alice", task: "a", completed: false, branch: { fanoutIndex: 0, branchId: "a", branchIndex: 0, joinIndex: 4 } },
                { kind: "task", member: "bob", task: "b", completed: false, branch: { fanoutIndex: 0, branchId: "b", branchIndex: 1, joinIndex: 4 } },
                { kind: "task", member: "carol", task: "c", completed: false, branch: { fanoutIndex: 0, branchId: "c", branchIndex: 2, joinIndex: 4 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2, 3], maxErrored: 0, joinPolicy: "quorum", quorum: 0.5 } },
            ],
            [1, 2, 3],
        )
        const team = makeTeam({ activeTask: task, members: [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
            { name: "carol", sessionId: "ses_carol" },
        ]})
        const ctx = makeCtx({ outputs: { ses_alice: "a out", ses_bob: "b out" }, calls })

        // When: 2 of 3 branches survive (c errors), meeting quorum.
        const cMember = member(team, "carol")
        cMember.status = "errored"
        cMember.error = "c outage"
        await checkTermination(ctx, team) // marks c errored
        await processIdle(ctx, team, member(team, "alice"), "ses_alice")
        await processIdle(ctx, team, member(team, "bob"), "ses_bob")

        // Then: join completes (2 survivors >= ceil(0.5 * 3) = 2).
        expect(task.steps?.[4]?.completed).toBe(true)
    })

    test("join_policy='quorum' fails when survivors drop below the threshold", async () => {
        // Given: 3 branches, quorum 0.5 => need 2 survivors.
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask(
            [
                { kind: "fanout", completed: true, fanout: { branchIds: ["a", "b", "c"], branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }, { startIndex: 3, endIndex: 3 }], joinIndex: 4, maxErrored: 0, joinPolicy: "quorum", quorum: 0.5 } },
                { kind: "task", member: "alice", task: "a", completed: false, branch: { fanoutIndex: 0, branchId: "a", branchIndex: 0, joinIndex: 4 } },
                { kind: "task", member: "bob", task: "b", completed: false, branch: { fanoutIndex: 0, branchId: "b", branchIndex: 1, joinIndex: 4 } },
                { kind: "task", member: "carol", task: "c", completed: false, branch: { fanoutIndex: 0, branchId: "c", branchIndex: 2, joinIndex: 4 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2, 3], maxErrored: 0, joinPolicy: "quorum", quorum: 0.5 } },
            ],
            [1, 2, 3],
        )
        const team = makeTeam({ activeTask: task, members: [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
            { name: "carol", sessionId: "ses_carol" },
        ]})
        const ctx = makeCtx({ calls })

        // When: 2 of 3 error, leaving only 1 survivor (< threshold).
        member(team, "bob").status = "errored"
        member(team, "carol").status = "errored"
        await checkTermination(ctx, team)

        // Then: workflow fails (impossible to reach quorum).
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
    })

    test("branch step with no live actor is marked errored and surviving branches decide the join", async () => {
        // Given: a fanout where api has no live session, while qa can still run.
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask(
            [
                { kind: "fanout", completed: false, fanout: { branchIds: ["api", "qa"], branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }], joinIndex: 3, maxErrored: 1 } },
                { kind: "task", member: "alice", task: "api", completed: false, branch: { fanoutIndex: 0, branchId: "api", branchIndex: 0, joinIndex: 3 } },
                { kind: "task", member: "bob", task: "qa", completed: false, branch: { fanoutIndex: 0, branchId: "qa", branchIndex: 1, joinIndex: 3 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2], maxErrored: 1 } },
                { kind: "task", member: "carol", task: "ship", completed: false },
            ],
            [0],
        )
        const team = makeTeam({ activeTask: task, members: [
            { name: "alice" },
            { name: "bob", sessionId: "ses_bob" },
            { name: "carol", sessionId: "ses_carol" },
        ]})
        const ctx = makeCtx({ outputs: { ses_bob: "qa output" }, calls })

        // When: the fanout advances into both branches.
        await advanceWorkflowStep(ctx, team)
        await processIdle(ctx, team, member(team, "bob"), "ses_bob")

        // Then: api is degraded to an errored branch, qa survives, and ship is dispatched.
        expect(task.steps?.[3]?.join?.erroredBranchIds).toEqual(["api"])
        expect(task.steps?.[3]?.completed).toBe(true)
        expect(calls).toContainEqual({ sessionId: "ses_bob", text: "qa" })
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(true)
    })

    test("fallback_verifier dispatches a gate when the primary verifier has no live session", async () => {
        // Given: a completed task and a gate whose primary verifier has no session.
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask(
            [
                { kind: "task", member: "alice", task: "draft", output: "draft output", completed: true },
                { kind: "gate", verifier: "bob", fallbackVerifier: "carol", criteria: "ok", targetStepIndex: 0, completed: false },
            ],
            [0],
        )
        const team = makeTeam({ activeTask: task, members: [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob" },
            { name: "carol", sessionId: "ses_carol" },
        ]})
        const ctx = makeCtx({ calls })

        // When: the gate is dispatched.
        await advanceWorkflowStep(ctx, team)

        // Then: the fallback verifier receives the gate prompt.
        expect(calls.length).toBe(1)
        expect(calls[0]?.sessionId).toBe("ses_carol")
        expect(calls[0]?.text).toContain("[Verification gate]")
    })

    test("multi-target gate prompt tells the verifier to aggregate targets", async () => {
        // Given: a gate verifying two previous task outputs.
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask(
            [
                { kind: "task", member: "alice", task: "api", output: "api output", completed: true },
                { kind: "task", member: "carol", task: "tests", output: "test output", completed: true },
                { kind: "gate", verifier: "bob", criteria: "consistent", targetStepIndices: [0, 1], completed: false },
            ],
            [0],
        )
        const team = makeTeam({ activeTask: task, members: [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
            { name: "carol", sessionId: "ses_carol" },
        ]})
        const ctx = makeCtx({ calls })

        // When: the gate is dispatched.
        await advanceWorkflowStep(ctx, team)

        // Then: the prompt asks for a single aggregated verdict across targets.
        expect(calls[0]?.text).toContain("aggregate of multiple target outputs")
        expect(calls[0]?.text).toContain("steps 1, 2")
    })

    test("join_policy='select' dispatches a selector and promotes the selected branch output", async () => {
        // Given: all branches succeeded and the join needs a selector.
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask(
            [
                { kind: "fanout", completed: true, fanout: { branchIds: ["api", "docs"], branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }], joinIndex: 3, maxErrored: 0, joinPolicy: "select", reducerMember: "dave" } },
                { kind: "task", member: "alice", task: "api", output: "api output", completed: true, branch: { fanoutIndex: 0, branchId: "api", branchIndex: 0, joinIndex: 3 } },
                { kind: "task", member: "bob", task: "docs", output: "docs output", completed: true, branch: { fanoutIndex: 0, branchId: "docs", branchIndex: 1, joinIndex: 3 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2], maxErrored: 0, joinPolicy: "select", reducerMember: "dave" } },
            ],
            [3],
        )
        const team = makeTeam({ activeTask: task, members: [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
            { name: "dave", sessionId: "ses_dave" },
        ]})
        const ctx = makeCtx({ outputs: { ses_dave: `<selection>{"winner":"api","rationale":"best"}</selection>` }, calls })

        // When: the join dispatches to the selector and captures the selection.
        await advanceWorkflowStep(ctx, team)
        await processIdle(ctx, team, member(team, "dave"), "ses_dave")

        // Then: only the selected branch is promoted into joinedOutput.
        expect(calls[0]?.sessionId).toBe("ses_dave")
        expect(calls[0]?.text).toContain("[Workflow select task]")
        expect(task.steps?.[3]?.join?.selectedBranchId).toBe("api")
        expect(task.steps?.[3]?.join?.joinedOutput).toContain("api output")
        expect(task.steps?.[3]?.join?.joinedOutput).not.toContain("docs output")
    })
})

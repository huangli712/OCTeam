import { describe, expect, test } from "bun:test"

import type { MemberState } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { getExpectedMember } from "../src/orchestration/lifecycle/idle.js"
import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import { isQuorumReached, parseSignoff } from "../src/orchestration/protocol/decisions.js"
import { handleSignoffIdle } from "../src/orchestration/control/signoff.js"
import { makeCtx, makeTask, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js"

function requireMember(team: Team, name: string): MemberState {
    const member = team.members.find(candidate => candidate.name === name)
    if (member === undefined) throw new Error(`Missing fixture member: ${name}`)
    return member
}

describe("parseSignoff", () => {
    test("parses approved signoff with rationale", () => {
        const text = 'Some review text... <signoff>{"approved": true, "rationale": "looks good"}</signoff>'
        const result = parseSignoff(text)
        expect(result).toEqual({ approved: true, rationale: "looks good" })
    })

    test("parses rejected signoff with rationale", () => {
        const text = '<signoff>{"approved": false, "rationale": "missing tests"}</signoff>'
        const result = parseSignoff(text)
        expect(result).toEqual({ approved: false, rationale: "missing tests" })
    })

    test("returns null when no signoff tag present", () => {
        expect(parseSignoff("just regular output, no tag")).toBeNull()
    })

    test("returns parseFailed for malformed JSON inside tag", () => {
        expect(parseSignoff("<signoff>not valid json</signoff>")).toEqual({
            approved: false,
            rationale: "",
            parseFailed: true,
        })
    })

    test("handles missing rationale field (defaults to empty string)", () => {
        const text = '<signoff>{"approved": true}</signoff>'
        const result = parseSignoff(text)
        expect(result).toEqual({ approved: true, rationale: "" })
    })

    test("handles approved explicitly false", () => {
        const text = '<signoff>{"approved": false}</signoff>'
        const result = parseSignoff(text)
        expect(result?.approved).toBe(false)
    })

    test("treats non-boolean approved as false", () => {
        const text = '<signoff>{"approved": "yes"}</signoff>'
        const result = parseSignoff(text)
        expect(result?.approved).toBe(false)
        expect(result?.parseFailed).toBe(true)
    })

    test("parses signoff embedded in longer text", () => {
        const text = `Here is my review.\n\nThe code looks acceptable.\n\n<signoff>{"approved": true, "rationale": "all checks pass"}</signoff>\nDone.`
        const result = parseSignoff(text)
        expect(result).toEqual({ approved: true, rationale: "all checks pass" })
    })

    test("handles empty string input", () => {
        expect(parseSignoff("")).toBeNull()
    })

    test("handles undefined-like input gracefully", () => {
        expect(parseSignoff(undefined as unknown as string)).toBeNull()
    })
})

describe("handleSignoffIdle malformed retry", () => {
    test("retries malformed signoff twice before recording a rejection", async () => {
        const calls: DispatchCall[] = []
        const task = makeTask({
            signoffPolicy: "decider",
            signoffDecider: "alice",
            signoffStage: true,
            signoffReviewers: ["alice"],
            signoffApprovals: {},
            signoffRawOutputs: { alice: "<signoff>not valid json</signoff>" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "alice", sessionId: "ses_alice", status: "idle" }],
        })
        const alice = requireMember(team, "alice")
        const ctx = makeCtx({ calls })

        for (let attempt = 1; attempt < 3; attempt++) {
            alice.status = "idle"
            await handleSignoffIdle(ctx, team, alice)
            expect(task.signoffParseFailures?.alice).toBe(attempt)
            expect(task.signoffApprovals?.alice).toBeUndefined()
            expect(team.activeTask).toBe(task)
        }

        alice.status = "idle"
        await handleSignoffIdle(ctx, team, alice)

        expect(task.signoffParseFailures?.alice).toBe(3)
        expect(task.signoffApprovals?.alice).toBe(false)
        expect(calls.filter(call => call.sessionId === "ses_alice")).toHaveLength(2)
        expect(team.activeTask).toBeUndefined()
        expect(team.status).toBe("failed")
    })
})

describe("getExpectedMember with signoff", () => {
    test("signoff stage returns null (any reviewer may advance)", () => {
        const task = makeTask({
            type: "pipeline",  // normally pipeline restricts to current stage
            signoffStage: true,
            stages: [{ member: "alice", task: "t", completed: false }],
            currentStageIndex: 0,
        })
        expect(getExpectedMember(task)).toBeNull()
    })

    test("non-signoff pipeline still restricts to current stage member", () => {
        const task = makeTask({
            type: "pipeline",
            signoffStage: false,
            stages: [{ member: "alice", task: "t", completed: false }],
            currentStageIndex: 0,
        })
        expect(getExpectedMember(task)).toBe("alice")
    })

    test("non-signoff parallel still returns null", () => {
        const task = makeTask({ type: "parallel", signoffStage: false })
        expect(getExpectedMember(task)).toBeNull()
    })

    test("non-signoff delegate still returns null", () => {
        const task = makeTask({ type: "delegate", signoffStage: false })
        expect(getExpectedMember(task)).toBeNull()
    })
})

describe("workflow signoff output capture", () => {
    test("decider uses the fresh signoff response instead of stale workflow output", async () => {
        const calls: DispatchCall[] = []
        const signoff = '<signoff>{"approved":true,"rationale":"ready"}</signoff>'
        const task = makeWorkflowTask({
            signoffPolicy: "decider",
            signoffDecider: "alice",
            signoffStage: true,
            signoffApprovals: {},
            responses: { alice: "stale workflow output" },
            steps: [{ kind: "task", member: "worker", task: "done", completed: true }],
            activeStepIndices: [],
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "worker", sessionId: "ses_worker" },
            ],
        })

        await processIdle(
            makeCtx({ calls, outputs: { ses_alice: signoff } }),
            team,
            requireMember(team, "alice"),
            "ses_alice",
        )

        expect(task.signoffRawOutputs?.alice).toBe(signoff)
        expect(task.responses.alice).toBe("stale workflow output")
        expect(task.signoffApprovals?.alice).toBe(true)
        expect(team.activeTask).toBeUndefined()
    })

    test("peer quorum captures each reviewer's fresh signoff response", async () => {
        const calls: DispatchCall[] = []
        const aliceSignoff = '<signoff>{"approved":true,"rationale":"ready"}</signoff>'
        const bobSignoff = '<signoff>{"approved":false,"rationale":"changes"}</signoff>'
        const task = makeWorkflowTask({
            signoffPolicy: "peer-quorum",
            signoffStage: true,
            signoffApprovals: {},
            signoffQuorum: 0.5,
            steps: [{ kind: "task", member: "worker", task: "done", completed: true }],
            activeStepIndices: [],
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })
        const ctx = makeCtx({
            calls,
            outputs: { ses_alice: aliceSignoff, ses_bob: bobSignoff },
        })

        await processIdle(ctx, team, requireMember(team, "alice"), "ses_alice")
        expect(task.signoffRawOutputs?.alice).toBe(aliceSignoff)
        expect(task.signoffApprovals?.alice).toBe(true)
        expect(team.activeTask).toBe(task)

        await processIdle(ctx, team, requireMember(team, "bob"), "ses_bob")
        expect(task.signoffRawOutputs?.bob).toBe(bobSignoff)
        expect(task.signoffApprovals).toEqual({ alice: true, bob: false })
        expect(team.activeTask).toBeUndefined()
    })
})

describe("isQuorumReached", () => {
    test("all responded, majority reached (2/3, quorum 0.5)", () => {
        const result = isQuorumReached({ a: true, b: true, c: false }, 3, 0.5)
        expect(result.allResponded).toBe(true)
        expect(result.reached).toBe(true)
        expect(result.approvedCount).toBe(2)
    })

    test("all responded, quorum NOT reached (1/3, quorum 0.5)", () => {
        const result = isQuorumReached({ a: true, b: false, c: false }, 3, 0.5)
        expect(result.allResponded).toBe(true)
        expect(result.reached).toBe(false)
        expect(result.approvedCount).toBe(1)
    })

    test("not all responded yet (2/3 responded)", () => {
        const result = isQuorumReached({ a: true, b: true }, 3, 0.5)
        expect(result.allResponded).toBe(false)
        expect(result.reached).toBe(false)  // cannot reach until all respond
        expect(result.approvedCount).toBe(2)
    })

    test("unanimous approval (3/3, quorum 0.67)", () => {
        const result = isQuorumReached({ a: true, b: true, c: true }, 3, 0.67)
        expect(result.allResponded).toBe(true)
        expect(result.reached).toBe(true)
    })

    test("quorum 1.0 requires unanimous", () => {
        expect(isQuorumReached({ a: true, b: true, c: false }, 3, 1.0).reached).toBe(false)
        expect(isQuorumReached({ a: true, b: true, c: true }, 3, 1.0).reached).toBe(true)
    })

    test("quorum 0.0 always reached once all responded", () => {
        const result = isQuorumReached({ a: false, b: false }, 2, 0.0)
        expect(result.allResponded).toBe(true)
        expect(result.reached).toBe(true)
    })

    test("zero reviewers: allResponded=true but reached=false (avoid div-by-zero)", () => {
        const result = isQuorumReached({}, 0, 0.5)
        expect(result.allResponded).toBe(true)
        expect(result.reached).toBe(false)  // guard against reviewerCount=0
    })

    test("exact threshold boundary: 2/4 with quorum 0.5 = reached", () => {
        const result = isQuorumReached({ a: true, b: true, c: false, d: false }, 4, 0.5)
        expect(result.reached).toBe(true)  // 0.5 >= 0.5
    })

    test("just below threshold: 1/4 with quorum 0.5 = not reached", () => {
        const result = isQuorumReached({ a: true, b: false, c: false, d: false }, 4, 0.5)
        expect(result.reached).toBe(false)  // 0.25 < 0.5
    })

    test("empty approvals but reviewerCount > 0: not all responded", () => {
        const result = isQuorumReached({}, 3, 0.5)
        expect(result.allResponded).toBe(false)
        expect(result.reached).toBe(false)
    })
})

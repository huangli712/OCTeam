import { describe, expect, test } from "bun:test"

import { getExpectedMember } from "../src/orchestration/idle.js"
import { isQuorumReached, parseSignoff } from "../src/orchestration/decisions.js"
import type { ActiveTask } from "../src/core/types.js"

function makeTask(opts: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
        startedAt: 0,
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        ...opts,
    } as ActiveTask
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

    test("returns null for malformed JSON inside tag", () => {
        expect(parseSignoff("<signoff>not valid json</signoff>")).toBeNull()
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

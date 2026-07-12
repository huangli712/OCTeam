import { describe, expect, test } from "bun:test"

import { formatWorkflowMermaid } from "../src/orchestration/runs/mermaid.js"
import type { WorkflowRunStep } from "../src/core/types.js"

const WORKFLOW_STEPS: WorkflowRunStep[] = [
    { index: 0, step: 1, kind: "task", member: "alice", completed: true },
    { index: 1, step: 2, kind: "gate", verifier: "bob", targetStep: 1, completed: false },
    { index: 2, step: 3, kind: "task", member: "carol", completed: false },
]

describe("formatWorkflowMermaid", () => {
    test("omits status classes when no live status map is provided", () => {
        const result = formatWorkflowMermaid(WORKFLOW_STEPS)

        expect(result).toContain("flowchart TD")
        expect(result).toContain("s1 -. verifies .-> s2")
        expect(result).not.toContain("classDef")
        expect(result).not.toContain("class s")
    })

    test("adds live status classes when a status map is provided", () => {
        const result = formatWorkflowMermaid(
            WORKFLOW_STEPS,
            new Map([
                [0, "done"],
                [1, "active"],
                [2, "pending"],
            ]),
        )

        expect(result).toContain("classDef done")
        expect(result).toContain("classDef active")
        expect(result).toContain("classDef pending")
        expect(result).toContain("class s1 done;")
        expect(result).toContain("class s2 active;")
        expect(result).toContain("class s3 pending;")
    })

    test("escapes angle brackets in labels to prevent Mermaid render corruption", () => {
        const steps: WorkflowRunStep[] = [
            { index: 0, step: 1, kind: "task", member: "alice<b>x</b>", completed: true },
        ]
        const result = formatWorkflowMermaid(steps)
        expect(result).not.toContain("<b>")
        expect(result).toContain("&lt;b&gt;")
    })
})

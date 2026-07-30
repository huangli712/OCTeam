import { describe, expect, test } from "bun:test"

import type { WorkflowToolStep } from "../src/core/types/workflow.js"
import { resolveWorkflowArgs } from "../src/tools/workflow/validate.js"
import { makeCtx } from "./helpers.js"

function taskSteps(count: number): WorkflowToolStep[] {
    return Array.from({ length: count }, (_, index) => ({
        kind: "task",
        member: "alice",
        task: `step ${index}`,
    }))
}

describe("inline workflow total-step limit", () => {
    test("rejects more than 256 linear steps before lowering", async () => {
        const result = await resolveWorkflowArgs(makeCtx(), {
            team_id: "alpha",
            steps: taskSteps(257),
        })

        expect(typeof result).toBe("string")
        expect(result).toContain("256")
    })

    test("counts nested branch steps in the same 256-step budget", async () => {
        const steps: WorkflowToolStep[] = [
            {
                kind: "fanout",
                branches: [{ id: "branch", steps: taskSteps(256) }],
            },
            { kind: "join" },
        ]

        const result = await resolveWorkflowArgs(makeCtx(), {
            team_id: "alpha",
            steps,
        })

        expect(typeof result).toBe("string")
        expect(result).toContain("256")
    })
})

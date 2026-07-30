/**
 * Regression tests for C-7: workflow loader must enforce resource limits
 * to prevent OOM and stack exhaustion from a malicious or buggy workflow_file.
 *
 * Bug: src/orchestration/workflow/loader.ts loadWorkflowFile + validateWorkflowStepArray
 * have no caps on:
 *   1. File size before reading (fs.readFile slurps the whole file).
 *   2. Fanout recursion depth (fanout → branches → steps → fanout → ...).
 *   3. Total step count across the workflow (linear + nested).
 *   4. Branches-per-fanout array length (raw, before matrix expansion).
 *
 * A hostile workflow_file can exhaust memory (giant file or deeply-nested
 * fanout) or stack (deep recursion in validateWorkflowStep).
 *
 * Fix: enforce hard caps in loadWorkflowFile and validateWorkflowStepArray.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"

import { loadWorkflowFile, validateWorkflowSteps } from "../src/orchestration/workflow/loader.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

describe("C-7.1: loadWorkflowFile rejects oversized files", () => {
    test("file larger than the byte cap is rejected before reading", async () => {
        const root = tmpRoot("c7-oversize-file")
        const dir = path.join(root, ".octeam", "workflows")
        await import("node:fs/promises").then(fs => fs.mkdir(dir, { recursive: true }))
        const relPath = ".octeam/workflows/huge.json"
        // Write a JSON file just over the cap (5 MB of whitespace-padding).
        // The cap will be a module constant; this file is comfortably larger.
        const padding = " ".repeat(5 * 1024 * 1024)
        writeFileSync(
            path.join(root, relPath),
            `{"steps":[{"kind":"task","member":"x","task":"${padding}"}]}`,
        )

        const result = await loadWorkflowFile(root, relPath, {})
        expect("error" in result).toBe(true)
        if ("error" in result) {
            expect(result.error).toMatch(/too large|exceeds.*byte|size.*limit/i)
        }
    })
})

describe("C-7.2: validateWorkflowSteps rejects excessive step counts", () => {
    test("linear workflow with too many steps is rejected", () => {
        // Build a workflow with too many task steps. The cap will be a
        // module constant (e.g. 256); we'll exceed it.
        const tooMany = Array.from({ length: 300 }, (_, i) => ({
            kind: "task",
            member: "x",
            task: `step ${i}`,
        }))
        const result = validateWorkflowSteps(tooMany)
        expect("error" in result).toBe(true)
        if ("error" in result) {
            expect(result.error).toMatch(/exceeds.*maximum|too many steps|step count.*limit/i)
        }
    })

    test("control: a reasonable workflow (e.g. 50 steps) is accepted", () => {
        const reasonable = Array.from({ length: 50 }, (_, i) => ({
            kind: "task",
            member: "x",
            task: `step ${i}`,
        }))
        const result = validateWorkflowSteps(reasonable)
        expect("steps" in result).toBe(true)
    })

    test("sibling foreach expansions share one total-step budget", () => {
        const values = Array.from({ length: 64 }, (_, index) => `item-${index}`)
        const fanout = {
            kind: "fanout",
            foreach: values,
            steps: [
                { kind: "task", member: "x", task: "first" },
                { kind: "task", member: "x", task: "second" },
            ],
        }

        const result = validateWorkflowSteps([fanout, { kind: "join" }, fanout, { kind: "join" }])

        expect("error" in result).toBe(true)
    })

    test("nested foreach expansions count the fully expanded template", () => {
        const inner = {
            kind: "fanout",
            foreach: Array.from({ length: 20 }, (_, index) => `inner-${index}`),
            steps: Array.from({ length: 3 }, (_, index) => ({
                kind: "task",
                member: "x",
                task: `inner task ${index}`,
            })),
        }
        const outer = {
            kind: "fanout",
            foreach: Array.from({ length: 5 }, (_, index) => `outer-${index}`),
            steps: [inner, { kind: "join" }],
        }

        const result = validateWorkflowSteps([outer, { kind: "join" }])

        expect("error" in result).toBe(true)
    })
})

describe("C-7.3: validateWorkflowSteps rejects excessive fanout recursion depth", () => {
    test("deeply nested fanout (depth > cap) is rejected", () => {
        // Build a deeply nested workflow: fanout → branch → fanout → ...
        // Each level nests one deeper. Without a depth cap, this would
        // blow the JS stack.
        const MAX_DEPTH = 50 // comfortably beyond any reasonable depth cap
        let inner: Record<string, unknown> = { kind: "task", member: "x", task: "leaf" }
        for (let i = 0; i < MAX_DEPTH; i++) {
            inner = {
                kind: "fanout",
                branches: [{ id: `b${i}`, steps: [inner] }],
            }
        }
        const result = validateWorkflowSteps([inner])
        expect("error" in result).toBe(true)
        if ("error" in result) {
            expect(result.error).toMatch(/depth|nesting|too deeply/i)
        }
    })

    test("control: shallow nested fanout (depth 3) is accepted", () => {
        const inner = { kind: "task", member: "x", task: "leaf" } as const
        const mid = {
            kind: "fanout" as const,
            branches: [{ id: "m", steps: [inner] }],
        }
        const outer = {
            kind: "fanout" as const,
            branches: [{ id: "o", steps: [mid] }],
        }
        const result = validateWorkflowSteps([outer])
        expect("steps" in result).toBe(true)
    })
})

describe("C-7.4: validateWorkflowSteps rejects excessive branches per fanout", () => {
    test("fanout with too many branches is rejected", () => {
        // The matrix/foreach expansion in lower.ts caps at 64, but the raw
        // loader accepts any branch array length — a hostile file can
        // declare 10,000 branches directly.
        const tooManyBranches = Array.from({ length: 200 }, (_, i) => ({
            id: `b${i}`,
            steps: [{ kind: "task", member: "x", task: "x" }],
        }))
        const steps = [{ kind: "fanout", branches: tooManyBranches }]
        const result = validateWorkflowSteps(steps)
        expect("error" in result).toBe(true)
        if ("error" in result) {
            expect(result.error).toMatch(/too many branches|branch.*limit/i)
        }
    })
})

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { loadWorkflowFile, validateWorkflowSteps } from "../src/tools/workflow-file.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

// -----------------------------------------------------------------------
// validateWorkflowSteps - pure workflow step-array validation seam.
// The helper reuses the existing workflow_file step-array validation but
// never touches the filesystem: it takes a raw value and returns either
// parsed steps or a single error string with a stable synthetic location.
// loadWorkflowFile now routes through the same exported helper, passing the
// real relative path so its error strings keep naming the actual file.
// -----------------------------------------------------------------------
describe("validateWorkflowSteps", () => {
    test("valid step array is accepted and returned", () => {
        // Given: a well-formed task + gate step array.
        const value = [
            { kind: "task", member: "alice", task: "do x" },
            { kind: "gate", verifier: "bob", criteria: "ok" },
        ]

        // When: the pure validator runs.
        const result = validateWorkflowSteps(value)

        // Then: the parsed steps are returned unchanged in count.
        expect("steps" in result).toBe(true)
        if ("steps" in result) {
            expect(result.steps).toHaveLength(2)
            expect(result.steps[0]?.kind).toBe("task")
            expect(result.steps[1]?.kind).toBe("gate")
        }
    })

    test("non-array input is rejected with a synthetic location", () => {
        // Given: a value that is not a steps array.
        // When: the pure validator runs.
        const result = validateWorkflowSteps("not an array")

        // Then: a stable synthetic location is used, not a real filesystem path.
        expect("error" in result).toBe(true)
        if ("error" in result) {
            expect(result.error).toContain("must contain a workflow steps array")
            expect(result.error).toContain("<workflow>")
            expect(result.error).not.toContain(".json")
        }
    })

    test("object (non-array) input is rejected", () => {
        // Given: an object rather than an array.
        // When: the pure validator runs.
        const result = validateWorkflowSteps({ steps: [] })

        // Then: it is rejected as a non-array.
        expect("error" in result).toBe(true)
        if ("error" in result) {
            expect(result.error).toContain("must contain a workflow steps array")
        }
    })

    test("non-object step element is rejected", () => {
        // Given: a step array whose first element is not an object.
        // When: the pure validator runs.
        const result = validateWorkflowSteps([42])

        // Then: the offending step index is reported.
        expect("error" in result).toBe(true)
        if ("error" in result) {
            expect(result.error).toContain("step 1")
            expect(result.error).toContain("must be an object")
        }
    })

    test("unknown step kind is rejected", () => {
        // Given: a step with an unsupported kind.
        // When: the pure validator runs.
        const result = validateWorkflowSteps([{ kind: "invalid" }])

        // Then: the kind constraint is surfaced for that step.
        expect("error" in result).toBe(true)
        if ("error" in result) {
            expect(result.error).toContain("step 1")
            expect(result.error).toContain("kind must be task, gate, fanout, or join")
        }
    })

    test("out-of-range step field is rejected by reused field validation", () => {
        // Given: a task step with max_retries above the allowed range.
        const value = [{ kind: "task", member: "alice", task: "do x", max_retries: 99 }]

        // When: the pure validator runs.
        const result = validateWorkflowSteps(value)

        // Then: the same field error the workflow_file loader emits is returned.
        expect("error" in result).toBe(true)
        if ("error" in result) {
            expect(result.error).toContain("step 1 max_retries must be an integer from 0 to 5")
        }
    })

    test("explicit sourcePath form attributes errors to the provided path", () => {
        // Given: an invalid step and an explicit source-path label.
        const value = [{ kind: "task", member: "alice", task: "do x", max_retries: 99 }]

        // When: the two-arg overload runs with a caller-supplied path.
        const result = validateWorkflowSteps(value, "config/wf.json")

        // Then: the error names the provided path instead of the synthetic default.
        expect("error" in result).toBe(true)
        if ("error" in result) {
            expect(result.error).toContain(`workflow_file "config/wf.json"`)
            expect(result.error).toContain("step 1 max_retries must be an integer from 0 to 5")
            expect(result.error).not.toContain("<workflow>")
        }
    })
})

// -----------------------------------------------------------------------
// loadWorkflowFile shares the same step validation, but must keep naming the
// real relative workflow_file path in errors (not the pure synthetic label).
// -----------------------------------------------------------------------
describe("loadWorkflowFile error attribution", () => {
    afterAll(cleanupTmpRoots)

    test("valid file returns parsed steps", async () => {
        // Given: a well-formed workflow file on disk.
        const root = tmpRoot("wf-file-validate-ok")
        const dir = join(root, ".octeam", "workflows")
        mkdirSync(dir, { recursive: true })
        const relPath = ".octeam/workflows/ok.json"
        writeFileSync(join(root, relPath), JSON.stringify({
            steps: [
                { kind: "task", member: "alice", task: "do x" },
                { kind: "gate", verifier: "bob", criteria: "ok" },
            ],
        }))

        // When: the file is loaded.
        const result = await loadWorkflowFile(root, relPath, {})

        // Then: the parsed steps are returned unchanged in count.
        expect("steps" in result).toBe(true)
        if ("steps" in result) {
            expect(result.steps).toHaveLength(2)
        }
    })

    test("step validation errors name the real workflow_file path, not the synthetic location", async () => {
        // Given: a workflow file whose only step has an out-of-range max_retries.
        const root = tmpRoot("wf-file-validate-relpath")
        const dir = join(root, ".octeam", "workflows")
        mkdirSync(dir, { recursive: true })
        const relPath = ".octeam/workflows/invalid-step.json"
        writeFileSync(join(root, relPath), JSON.stringify({
            steps: [{ kind: "task", member: "alice", task: "do x", max_retries: 99 }],
        }))

        // When: the file is loaded through loadWorkflowFile.
        const result = await loadWorkflowFile(root, relPath, {})

        // Then: the error names the real relative path and the shared field rule,
        // and never leaks the pure helper's synthetic <workflow> location.
        expect("error" in result).toBe(true)
        if ("error" in result) {
            expect(result.error).toContain(`workflow_file "${relPath}"`)
            expect(result.error).toContain("step 1 max_retries must be an integer from 0 to 5")
            expect(result.error).not.toContain("<workflow>")
        }
    })
})

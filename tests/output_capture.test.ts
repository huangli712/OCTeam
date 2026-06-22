import { describe, expect, test } from "bun:test"

import { extractOutputFromParts, extractTextFromParts } from "../src/utils.js"

describe("extractTextFromParts (baseline regression)", () => {
    test("extracts text from text-only parts", () => {
        const parts = [{ type: "text", text: "hello world" }]
        expect(extractTextFromParts(parts)).toBe("hello world")
    })

    test("returns empty for non-array", () => {
        expect(extractTextFromParts(null)).toBe("")
        expect(extractTextFromParts(undefined)).toBe("")
    })
})

describe("extractOutputFromParts", () => {
    test("text only: same as extractTextFromParts", () => {
        const parts = [{ type: "text", text: "Here is my answer." }]
        expect(extractOutputFromParts(parts)).toBe("Here is my answer.")
    })

    test("multiple text parts: joined with double newline", () => {
        const parts = [
            { type: "text", text: "First paragraph." },
            { type: "text", text: "Second paragraph." },
        ]
        expect(extractOutputFromParts(parts)).toBe("First paragraph.\n\nSecond paragraph.")
    })

    test("write tool: captures filePath + content", () => {
        const parts = [
            { type: "text", text: "Writing the solution." },
            {
                type: "tool_use",
                name: "write",
                input: {
                    filePath: "/tmp/solution.py",
                    content: "def gcd(a, b):\n    while b:\n        a, b = b, a % b\n    return a",
                },
            },
        ]
        const result = extractOutputFromParts(parts)
        expect(result).toContain("Writing the solution.")
        expect(result).toContain("[File: /tmp/solution.py]")
        expect(result).toContain("def gcd(a, b):")
        expect(result).toContain("return a")
    })

    test("bash tool: captures command with $ prefix", () => {
        const parts = [
            { type: "text", text: "Running tests." },
            { type: "tool_use", name: "bash", input: { command: "python -m pytest tests/" } },
        ]
        const result = extractOutputFromParts(parts)
        expect(result).toContain("Running tests.")
        expect(result).toContain("$ python -m pytest tests/")
    })

    test("aft_apply_patch: captures patchText", () => {
        const parts = [
            {
                type: "tool_use",
                name: "aft_apply_patch",
                input: { patchText: "*** Begin Patch\n*** End Patch" },
            },
        ]
        const result = extractOutputFromParts(parts)
        expect(result).toContain("[Patch]")
        expect(result).toContain("*** Begin Patch")
    })

    test("team_send_message EXCLUDED (coordination, not deliverable)", () => {
        const parts = [
            { type: "text", text: "Done." },
            {
                type: "tool_use",
                name: "team_send_message",
                input: { to: "master", body: "Task completed successfully." },
            },
        ]
        const result = extractOutputFromParts(parts)
        expect(result).toBe("Done.")
        expect(result).not.toContain("Task completed")
    })

    test("team_task_update EXCLUDED", () => {
        const parts = [
            { type: "text", text: "Claiming task." },
            {
                type: "tool_use",
                name: "team_task_update",
                input: { task_id: "abc", status: "claimed" },
            },
        ]
        const result = extractOutputFromParts(parts)
        expect(result).toBe("Claiming task.")
        expect(result).not.toContain("claimed")
    })

    test("empty parts returns empty string", () => {
        expect(extractOutputFromParts([])).toBe("")
    })

    test("null/undefined parts returns empty string", () => {
        expect(extractOutputFromParts(null)).toBe("")
        expect(extractOutputFromParts(undefined)).toBe("")
    })

    test("whitespace-only text is filtered", () => {
        const parts = [
            { type: "text", text: "   " },
            { type: "text", text: "\n\n" },
        ]
        expect(extractOutputFromParts(parts)).toBe("")
    })

    test("realistic coder scenario: text + write + bash + team_send_message", () => {
        const parts = [
            { type: "text", text: "I'll implement the GCD function." },
            {
                type: "tool_use",
                name: "write",
                input: {
                    filePath: "/tmp/gcd.py",
                    content: "def gcd(a, b):\n    while b:\n        a, b = b, a % b\n    return a\n\nassert gcd(48, 18) == 6",
                },
            },
            { type: "tool_use", name: "bash", input: { command: "python /tmp/gcd.py" } },
            { type: "text", text: "Done. All tests pass." },
            {
                type: "tool_use",
                name: "team_send_message",
                input: { to: "master", body: "GCD implementation complete." },
            },
        ]
        const result = extractOutputFromParts(parts)
        // Should contain text + write content + bash command
        expect(result).toContain("I'll implement the GCD function.")
        expect(result).toContain("[File: /tmp/gcd.py]")
        expect(result).toContain("def gcd(a, b):")
        expect(result).toContain("assert gcd(48, 18) == 6")
        expect(result).toContain("$ python /tmp/gcd.py")
        expect(result).toContain("Done. All tests pass.")
        // Should NOT contain team_send_message body
        expect(result).not.toContain("GCD implementation complete.")
    })

    test("aft_write and aft_edit recognized as work tools", () => {
        const parts = [
            {
                type: "tool_use",
                name: "aft_write",
                input: { filePath: "src/main.ts", content: "console.log('hello')" },
            },
        ]
        const result = extractOutputFromParts(parts)
        expect(result).toContain("[File: src/main.ts]")
        expect(result).toContain("console.log('hello')")
    })
})

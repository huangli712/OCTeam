import { describe, expect, test } from "bun:test"

import { ROLE_PRESETS, rolePreset } from "../src/core/role-presets.js"
import { buildRolePrompt } from "../src/core/utils.js"

describe("rolePreset (role → preset instruction)", () => {
    test("returns a non-empty preset for standard roles", () => {
        for (const role of [
            "coder",
            "verifier",
            "reviewer",
            "researcher",
            "finder",
            "architect",
            "explorer",
            "auditor",
        ]) {
            const preset = rolePreset(role)
            expect(preset).toBeDefined()
            expect(preset!.length).toBeGreaterThan(0)
        }
    })

    test("is case-insensitive", () => {
        expect(rolePreset("Coder")).toBe(ROLE_PRESETS.coder)
        expect(rolePreset("CODER")).toBe(ROLE_PRESETS.coder)
        expect(rolePreset("ReViewer")).toBe(ROLE_PRESETS.reviewer)
    })

    test("returns undefined for an unknown role", () => {
        expect(rolePreset("frobnicator")).toBeUndefined()
        expect(rolePreset("")).toBeUndefined()
    })
})

describe("buildRolePrompt role-instruction injection", () => {
    const peers = ["alice", "bob"]

    test("injects <role-instruction> when the role has a preset", () => {
        const out = buildRolePrompt(
            { name: "alice", role: "coder", prompt: "Implement the login endpoint." },
            "auth-team",
            peers,
        )
        expect(out).toContain("<role-instruction>")
        expect(out).toContain(ROLE_PRESETS.coder)
        expect(out).toContain("<user-instruction>")
        expect(out).toContain("Implement the login endpoint.")
    })

    test("role-instruction precedes user-instruction (role guidance first, task second)", () => {
        const out = buildRolePrompt(
            { name: "alice", role: "coder", prompt: "task" },
            "t",
            peers,
        )
        expect(out.indexOf("<role-instruction>")).toBeLessThan(out.indexOf("<user-instruction>"))
    })

    test("omits <role-instruction> when the role has no preset (user instruction still injected)", () => {
        const out = buildRolePrompt(
            { name: "alice", role: "frobnicator", prompt: "do the thing" },
            "t",
            peers,
        )
        expect(out).not.toContain("<role-instruction>")
        expect(out).toContain("<user-instruction>")
        expect(out).toContain("do the thing")
    })
})

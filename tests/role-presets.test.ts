import { describe, expect, test } from "bun:test"

import {
    DEFAULT_ROLE,
    ROLES,
    ROLE_NAMES,
    normalizeRole,
    roleAgent,
    rolePreset,
} from "../src/core/role-presets.js"
import { buildRolePrompt } from "../src/core/utils.js"

describe("ROLES catalogue", () => {
    test("has 18 roles, each with a non-empty agent and instruction", () => {
        expect(ROLE_NAMES.length).toBe(18)
        for (const name of ROLE_NAMES) {
            const def = ROLES[name]
            expect(def.agent.length).toBeGreaterThan(0)
            expect(def.instruction.length).toBeGreaterThan(0)
        }
    })

    test("DEFAULT_ROLE is a real, read-only role (fail-safe to least privilege)", () => {
        expect(DEFAULT_ROLE).toBe("reviewer")
        expect(ROLE_NAMES).toContain("reviewer")
        // The silent fallback must map to a read-only agent, never "build".
        expect(roleAgent(DEFAULT_ROLE)).toBe("oracle")
        // "almighty" remains a valid, explicitly-selectable role.
        expect(ROLE_NAMES).toContain("almighty")
    })
})

describe("normalizeRole (closed enum, unknown → reviewer)", () => {
    test("known roles map to themselves", () => {
        for (const name of ROLE_NAMES) {
            expect(normalizeRole(name)).toBe(name)
        }
    })

    test("is case-insensitive", () => {
        expect(normalizeRole("Coder")).toBe("coder")
        expect(normalizeRole("REVIEWER")).toBe("reviewer")
    })

    test("unknown role falls back to the read-only reviewer role", () => {
        expect(normalizeRole("frobnicator")).toBe("reviewer")
        expect(normalizeRole("")).toBe("reviewer")
    })

    test("inherited Object keys do not falsely match", () => {
        expect(normalizeRole("constructor")).toBe("reviewer")
        expect(normalizeRole("toString")).toBe("reviewer")
        expect(normalizeRole("hasOwnProperty")).toBe("reviewer")
    })
})

describe("roleAgent (role → fixed agent)", () => {
    test("software roles", () => {
        expect(roleAgent("coder")).toBe("oct-junior")
        expect(roleAgent("debugger")).toBe("build")
        expect(roleAgent("optimizer")).toBe("build")
        expect(roleAgent("tester")).toBe("build")
        expect(roleAgent("writer")).toBe("build")
        expect(roleAgent("reviewer")).toBe("oracle")
        expect(roleAgent("architect")).toBe("oracle")
        expect(roleAgent("explorer")).toBe("explore")
    })

    test("science roles", () => {
        expect(roleAgent("mathematician")).toBe("build")
        expect(roleAgent("physicist")).toBe("build")
        expect(roleAgent("simulator")).toBe("build")
        expect(roleAgent("chemist")).toBe("build")
        expect(roleAgent("analyst")).toBe("build")
        expect(roleAgent("visualizer")).toBe("build")
    })

    test("research / writing / ideation", () => {
        expect(roleAgent("researcher")).toBe("librarian")
        expect(roleAgent("author")).toBe("build")
        expect(roleAgent("fantast")).toBe("build")
    })

    test("almighty uses build; unknown roles fall back to read-only oracle", () => {
        expect(roleAgent("almighty")).toBe("build")
        expect(roleAgent("frobnicator")).toBe("oracle")
    })

    test("is case-insensitive", () => {
        expect(roleAgent("Reviewer")).toBe("oracle")
        expect(roleAgent("FANTAST")).toBe("build")
    })
})

describe("rolePreset (always a non-empty instruction)", () => {
    test("known role returns its instruction", () => {
        expect(rolePreset("coder")).toBe(ROLES.coder.instruction)
        expect(rolePreset("Reviewer")).toBe(ROLES.reviewer.instruction)
    })

    test("unknown role returns the reviewer instruction", () => {
        expect(rolePreset("frobnicator")).toBe(ROLES.reviewer.instruction)
        expect(rolePreset("").length).toBeGreaterThan(0)
    })
})

describe("buildRolePrompt role-instruction injection", () => {
    const peers = ["alice", "bob"]

    test("injects <role-instruction> with the role's preset", () => {
        const out = buildRolePrompt(
            { name: "alice", role: "coder", prompt: "Implement the login endpoint." },
            "auth-team",
            peers,
        )
        expect(out).toContain("<role-instruction>")
        expect(out).toContain(ROLES.coder.instruction)
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

    test("unknown role still injects the reviewer instruction", () => {
        const out = buildRolePrompt(
            { name: "alice", role: "frobnicator", prompt: "do the thing" },
            "t",
            peers,
        )
        expect(out).toContain("<role-instruction>")
        expect(out).toContain(ROLES.reviewer.instruction)
        expect(out).toContain("do the thing")
    })
})

import { describe, expect, test } from "bun:test"

import {
    DEFAULT_ROLE,
    ROLES,
    ROLE_NAMES,
    normalizeRole,
    roleAgent,
    rolePreset,
} from "../src/core/role.js"
import { buildRolePrompt } from "../src/core/utils.js"

describe("ROLES catalogue", () => {
    test("has 21 roles, each with a non-empty agent and instruction", () => {
        expect(ROLE_NAMES.length).toBe(21)
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
        expect(roleAgent(DEFAULT_ROLE)).toBe("oct-oracle")
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
        expect(roleAgent("debugger")).toBe("oct-junior")
        expect(roleAgent("optimizer")).toBe("oct-junior")
        expect(roleAgent("tester")).toBe("oct-junior")
        expect(roleAgent("writer")).toBe("oct-junior")
        expect(roleAgent("reviewer")).toBe("oct-oracle")
        expect(roleAgent("architect")).toBe("oct-oracle")
        expect(roleAgent("explorer")).toBe("oct-explore")
    })

    test("science roles", () => {
        expect(roleAgent("mathematician")).toBe("oct-junior")
        expect(roleAgent("physicist")).toBe("oct-junior")
        expect(roleAgent("simulator")).toBe("oct-junior")
        expect(roleAgent("chemist")).toBe("oct-junior")
        expect(roleAgent("analyst")).toBe("oct-junior")
        expect(roleAgent("visualizer")).toBe("oct-junior")
    })

    test("research / writing / ideation", () => {
        expect(roleAgent("researcher")).toBe("oct-librarian")
        expect(roleAgent("author")).toBe("oct-junior")
        expect(roleAgent("fantast")).toBe("oct-junior")
    })

    test("planning / review / media roles", () => {
        expect(roleAgent("planner")).toBe("oct-metis")
        expect(roleAgent("auditor")).toBe("oct-momus")
        expect(roleAgent("looker")).toBe("oct-multimodal-looker")
    })

    test("almighty uses oct-junior; unknown roles fall back to read-only oct-oracle", () => {
        expect(roleAgent("almighty")).toBe("oct-junior")
        expect(roleAgent("frobnicator")).toBe("oct-oracle")
    })

    test("is case-insensitive", () => {
        expect(roleAgent("Reviewer")).toBe("oct-oracle")
        expect(roleAgent("FANTAST")).toBe("oct-junior")
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

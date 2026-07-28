import { describe, expect, test } from "bun:test"

import {
    DEFAULT_ROLE,
    ROLES,
    ROLE_NAMES,
    normalizeRole,
    roleAgent,
    rolePreset,
} from "../src/core/role.js"
import { buildRolePrompt } from "../src/orchestration/protocol/output.js"
import { prependStandingInstruction } from "../src/orchestration/control/dispatch.js"
import type { MemberState } from "../src/core/types.js"

describe("ROLES catalogue", () => {
    test("has 26 roles, each with a non-empty agent and instruction", () => {
        expect(ROLE_NAMES.length).toBe(26)
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
        expect(roleAgent("coder")).toBe("oct-deep")
        expect(roleAgent("debugger")).toBe("oct-junior")
        expect(roleAgent("optimizer")).toBe("oct-junior")
        expect(roleAgent("tester")).toBe("oct-junior")
        expect(roleAgent("writer")).toBe("oct-junior")
        expect(roleAgent("solver")).toBe("oct-deep")
        expect(roleAgent("reviewer")).toBe("oct-oracle")
        expect(roleAgent("architect")).toBe("oct-oracle")
        expect(roleAgent("explorer")).toBe("oct-explore")
    })

    test("science roles", () => {
        expect(roleAgent("mathematician")).toBe("oct-junior")
        expect(roleAgent("physicist")).toBe("oct-deep")
        expect(roleAgent("simulator")).toBe("oct-deep")
        expect(roleAgent("chemist")).toBe("oct-junior")
        expect(roleAgent("analyst")).toBe("oct-junior")
        expect(roleAgent("visualizer")).toBe("oct-junior")
    })

    test("research / writing / ideation", () => {
        expect(roleAgent("researcher")).toBe("oct-librarian")
        expect(roleAgent("author")).toBe("oct-junior")
        expect(roleAgent("fantast")).toBe("oct-ultrabrain")
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
        expect(roleAgent("FANTAST")).toBe("oct-ultrabrain")
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

    test("injects <role-instruction> with the role's preset, NOT the member task", () => {
        const out = buildRolePrompt(
            { name: "alice", role: "coder", prompt: "Implement the login endpoint." },
            "auth-team",
            peers,
        )
        expect(out).toContain("<role-instruction>")
        expect(out).toContain(ROLES.coder.instruction)
        // Role-setup is identity-only: the member's task (spec.prompt) is delivered
        // later as <member-instruction> on first dispatch, NOT during role-setup.
        // Embedding it here caused members to execute the full task during the
        // role-setup barrier window (120s), blowing the barrier for heavy tasks.
        expect(out).not.toContain("<user-instruction>")
        expect(out).not.toContain("Implement the login endpoint.")
    })

    test("role-instruction is present even when prompt is omitted", () => {
        const out = buildRolePrompt(
            { name: "alice", role: "coder", prompt: "" },
            "t",
            peers,
        )
        expect(out).toContain("<role-instruction>")
        expect(out).not.toContain("<user-instruction>")
    })

    test("unknown role still injects the reviewer instruction", () => {
        const out = buildRolePrompt(
            { name: "alice", role: "frobnicator", prompt: "do the thing" },
            "t",
            peers,
        )
        expect(out).toContain("<role-instruction>")
        expect(out).toContain(ROLES.reviewer.instruction)
        // prompt must NOT leak into role-setup
        expect(out).not.toContain("do the thing")
    })
})

describe("prependStandingInstruction", () => {
    const baseText = "[Your task]\nRun the benchmark."

    function mkMember(overrides: Partial<MemberState> = {}): MemberState {
        return { name: "alice", status: "idle", initialized: true, turnCount: 0, ...overrides }
    }

    test("prepends <member-instruction> on first dispatch (promptDelivered falsy)", () => {
        const member = mkMember({ prompt: "You are the sort engineer." })
        const out = prependStandingInstruction(member, baseText)
        expect(out).toContain("<member-instruction>")
        expect(out).toContain("You are the sort engineer.")
        expect(out).toContain(baseText)
        // pure transform: does not flip the flag itself (callers do, after promptAsync)
        expect(member.promptDelivered).toBeFalsy()
    })

    test("no-ops once promptDelivered is true (delivered exactly once)", () => {
        const member = mkMember({ prompt: "You are the sort engineer.", promptDelivered: true })
        expect(prependStandingInstruction(member, baseText)).toBe(baseText)
    })

    test("no-ops when member has no prompt", () => {
        const member = mkMember({})
        expect(prependStandingInstruction(member, baseText)).toBe(baseText)
    })
})

/**
 * M1: cross-check that role.ts's OCTEAM_AGENTS allowlist and agents/index.ts's
 * OCTEAM_AGENTS registry are consistent. Without this, a new agent added to
 * the registry but not mapped in ROLES would pass the config hook but fail
 * isOCTeamAgent at dispatch — a confusing operational gap.
 */
import { isOCTeamAgent, OCTEAM_AGENTS as ROLE_AGENTS } from "../src/core/role.js"
import { OCTEAM_AGENTS as REGISTRY_AGENTS } from "../src/agents/index.js"

describe("M1: OCTEAM_AGENTS consistency (role allowlist vs agent registry)", () => {
    test("every role-mapped agent exists in the agent registry", () => {
        for (const agentName of ROLE_AGENTS) {
            expect(REGISTRY_AGENTS[agentName]).toBeDefined()
        }
    })

    test("every registry agent is recognized by isOCTeamAgent", () => {
        for (const agentName of Object.keys(REGISTRY_AGENTS)) {
            expect(isOCTeamAgent(agentName)).toBe(true)
        }
    })
})

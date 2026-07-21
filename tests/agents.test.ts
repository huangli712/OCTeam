import { describe, expect, test } from "bun:test"

import { createConfigHook, OCTEAM_AGENTS } from "../src/agents/index.js"
import type { OcteamAgentConfig } from "../src/agents/types.js"

const READONLY_AGENTS = ["oct-oracle", "oct-librarian", "oct-explore", "oct-multimodal-looker", "oct-ultrabrain"] as const
const ANALYSIS_AGENTS = ["oct-metis", "oct-momus"] as const
const EXECUTOR_AGENTS = ["oct-junior", "oct-deep"] as const

const ALL_AGENT_KEYS = [
    ...READONLY_AGENTS,
    ...ANALYSIS_AGENTS,
    ...EXECUTOR_AGENTS,
] as const

function getAgent(key: string): OcteamAgentConfig {
    const agent = OCTEAM_AGENTS[key]
    if (!agent) throw new Error(`Agent ${key} not found in OCTEAM_AGENTS`)
    return agent
}

describe("OCTEAM_AGENTS registry", () => {
    test("exports exactly 9 agents", () => {
        const keys = Object.keys(OCTEAM_AGENTS)
        expect(keys).toHaveLength(9)
    })

    test("has the exact 6 expected agent keys (no extras, no missing)", () => {
        const keys = new Set(Object.keys(OCTEAM_AGENTS))
        const expected = new Set(ALL_AGENT_KEYS)
        expect(keys).toEqual(expected)
    })
})

describe("every agent config — structural rules", () => {
    for (const key of ALL_AGENT_KEYS) {
        const label = key

        test(`${label}: mode is "subagent"`, () => {
            expect(getAgent(key).mode).toBe("subagent")
        })

        test(`${label}: has a non-empty description`, () => {
            const desc = getAgent(key).description
            expect(typeof desc).toBe("string")
            expect(desc.length).toBeGreaterThan(0)
        })

        test(`${label}: has a non-empty prompt`, () => {
            const prompt = getAgent(key).prompt
            expect(typeof prompt).toBe("string")
            expect(prompt.length).toBeGreaterThan(0)
        })

        test(`${label}: has a valid hex color`, () => {
            const color = getAgent(key).color
            expect(typeof color).toBe("string")
            expect(color).toMatch(/^#[0-9a-fA-F]{6}$/)
        })

        test(`${label}: has a permission object`, () => {
            const perm = getAgent(key).permission
            expect(typeof perm).toBe("object")
            expect(perm).not.toBeNull()
        })
    }
})

describe("read-only agents (oracle / librarian / explore) — deny edit + task", () => {
    for (const key of READONLY_AGENTS) {
        test(`${key}: permission.edit is "deny"`, () => {
            expect(getAgent(key).permission?.edit).toBe("deny")
        })

        test(`${key}: permission.task is "deny"`, () => {
            expect(getAgent(key).permission?.task).toBe("deny")
        })
    }
})

describe("analysis agents (metis / momus) — deny edit, NOT deny task", () => {
    for (const key of ANALYSIS_AGENTS) {
        test(`${key}: permission.edit is "deny"`, () => {
            expect(getAgent(key).permission?.edit).toBe("deny")
        })

        test(`${key}: permission.task is NOT "deny"`, () => {
            expect(getAgent(key).permission?.task).not.toBe("deny")
        })
    }
})

describe("executor agents (junior / ultrabrain) — deny task, NOT deny edit", () => {
    for (const key of EXECUTOR_AGENTS) {
        test(`${key}: permission.task is 'deny'`, () => {
            expect(getAgent(key).permission?.task).toBe("deny")
        })

        test(`${key}: permission.edit is NOT 'deny'`, () => {
            expect(getAgent(key).permission?.edit).not.toBe("deny")
        })
    }
})

describe("temperature values", () => {
    test("metis has temperature 0.3", () => {
        expect(getAgent("oct-metis").temperature).toBe(0.3)
    })

    test("oracle has temperature 0.1", () => {
        expect(getAgent("oct-oracle").temperature).toBe(0.1)
    })

    test("librarian has temperature 0.1", () => {
        expect(getAgent("oct-librarian").temperature).toBe(0.1)
    })

    test("explore has temperature 0.1", () => {
        expect(getAgent("oct-explore").temperature).toBe(0.1)
    })

    test("momus has temperature 0.1", () => {
        expect(getAgent("oct-momus").temperature).toBe(0.1)
    })

    test("junior has temperature 0.1", () => {
        expect(getAgent("oct-junior").temperature).toBe(0.1)
    })

    test("ultrabrain has temperature 0.5", () => {
        expect(getAgent("oct-ultrabrain").temperature).toBe(0.5)
    })

    test("deep has temperature 0.1", () => {
        expect(getAgent("oct-deep").temperature).toBe(0.1)
    })
})

describe("createConfigHook", () => {
    test("returns an async function", () => {
        const hook = createConfigHook()
        expect(typeof hook).toBe("function")
        // async functions have constructor name AsyncFunction
        expect(hook.constructor.name).toBe("AsyncFunction")
    })

    test("injects all 9 agents into an empty config", async () => {
        const cfg: { agent?: Record<string, unknown> } = {}
        const hook = createConfigHook()
        await hook(cfg as Parameters<typeof hook>[0])
        expect(cfg.agent).toBeDefined()
        expect(Object.keys(cfg.agent!)).toHaveLength(9)
        for (const key of ALL_AGENT_KEYS) {
            expect(cfg.agent![key]).toBe(OCTEAM_AGENTS[key])
        }
    })

    test("does NOT overwrite a pre-existing agent entry", async () => {
        const preExisting = { mode: "subagent", description: "custom", prompt: "custom prompt" }
        const cfg: { agent?: Record<string, unknown> } = {
            agent: { "oct-oracle": preExisting, "oct-junior": preExisting },
        }
        const hook = createConfigHook()
        await hook(cfg as Parameters<typeof hook>[0])
        // pre-existing entries untouched
        expect(cfg.agent!["oct-oracle"]).toBe(preExisting)
        expect(cfg.agent!["oct-junior"]).toBe(preExisting)
        // the other 7 should be injected
        expect(Object.keys(cfg.agent!)).toHaveLength(9)
    })

    test("does NOT overwrite a completely pre-populated config", async () => {
        const cfg: { agent?: Record<string, unknown> } = {
            agent: {},
        }
        for (const key of ALL_AGENT_KEYS) {
            cfg.agent![key] = { mode: "subagent", description: key, prompt: "c" }
        }
        const hook = createConfigHook()
        await hook(cfg as Parameters<typeof hook>[0])
        for (const key of ALL_AGENT_KEYS) {
            expect(cfg.agent![key]).toEqual({ mode: "subagent", description: key, prompt: "c" })
        }
    })
})

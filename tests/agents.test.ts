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

    test("has the exact 9 expected agent keys (no extras, no missing)", () => {
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

describe("executor agents (junior / deep) — deny task, NOT deny edit", () => {
    for (const key of EXECUTOR_AGENTS) {
        test(`${key}: permission.task is 'deny'`, () => {
            expect(getAgent(key).permission?.task).toBe("deny")
        })

        test(`${key}: permission.edit is NOT 'deny'`, () => {
            expect(getAgent(key).permission?.edit).not.toBe("deny")
        })
    }
})

describe("member team tools — every preset allows all member-reachable team tools", () => {
    // team_done was absent from all 9 presets, making require_done_ack
    // runs effectively unusable (members could not call the tool). This table
    // locks the class: any member team tool missing from any preset fails red.
    const MEMBER_TEAM_TOOLS = [
        "team_send_message",
        "team_task_create",
        "team_task_list",
        "team_task_update",
        "team_task_get",
        "team_done",
    ] as const

    for (const key of ALL_AGENT_KEYS) {
        for (const tool of MEMBER_TEAM_TOOLS) {
            test(`${key}: permission.${tool} is "allow"`, () => {
                expect(getAgent(key).permission?.[tool]).toBe("allow")
            })
        }
    }

    test("MEMBER_TEAM_TOOLS_PERMISSION covers exactly the 6 member team tools", async () => {
        const { MEMBER_TEAM_TOOLS_PERMISSION } = await import("../src/agents/types.js")
        expect(Object.keys(MEMBER_TEAM_TOOLS_PERMISSION).sort()).toEqual([...MEMBER_TEAM_TOOLS].sort())
        for (const tool of MEMBER_TEAM_TOOLS) {
            expect(MEMBER_TEAM_TOOLS_PERMISSION[tool]).toBe("allow")
        }
    })
})

describe("AFT tool tiers — live permission entries", () => {
    // The host injects aft_*/lsp_* tools into member sessions and enforces
    // these maps: allows surface a tool, denies hide it — verified against
    // real member sessions (plain and worktree alike).
    const READ_TIER = ["aft_search", "aft_grep", "aft_glob", "aft_read", "aft_outline", "aft_zoom"] as const
    const DIAGNOSTICS_TIER = ["aft_inspect", "lsp_diagnostics", "lsp_symbols", "lsp_goto_definition", "lsp_find_references", "lsp_status"] as const
    const WRITE_DENY_FAMILY = ["aft_edit", "aft_write", "aft_apply_patch", "aft_ast_replace", "aft_refactor", "aft_import", "aft_move", "aft_delete", "aft_bash", "lsp_rename"] as const

    const READ_TIER_AGENTS = ["oct-oracle", "oct-explore", "oct-metis", "oct-momus", "oct-junior", "oct-deep"] as const
    const CALLGRAPH_AGENTS = ["oct-oracle", "oct-explore", "oct-junior", "oct-deep"] as const
    const DIAGNOSTICS_AGENTS = ["oct-oracle", "oct-momus", "oct-junior", "oct-deep"] as const
    const WRITE_DENY_AGENTS = ["oct-oracle", "oct-explore", "oct-metis", "oct-momus"] as const

    for (const key of READ_TIER_AGENTS) {
        for (const tool of READ_TIER) {
            test(`${key}: permission.${tool} is "allow"`, () => {
                expect(getAgent(key).permission?.[tool]).toBe("allow")
            })
        }
    }

    for (const key of CALLGRAPH_AGENTS) {
        test(`${key}: permission.aft_callgraph is "allow"`, () => {
            expect(getAgent(key).permission?.aft_callgraph).toBe("allow")
        })
    }

    test("oct-metis and oct-momus do NOT get aft_callgraph (analysis tier stays light)", () => {
        expect(getAgent("oct-metis").permission?.aft_callgraph).toBeUndefined()
        expect(getAgent("oct-momus").permission?.aft_callgraph).toBeUndefined()
    })

    for (const key of DIAGNOSTICS_AGENTS) {
        for (const tool of DIAGNOSTICS_TIER) {
            test(`${key}: permission.${tool} is "allow"`, () => {
                expect(getAgent(key).permission?.[tool]).toBe("allow")
            })
        }
    }

    // Non-executor presets that read code deny the whole structured write family.
    for (const key of WRITE_DENY_AGENTS) {
        for (const tool of WRITE_DENY_FAMILY) {
            test(`${key}: permission.${tool} is "deny"`, () => {
                expect(getAgent(key).permission?.[tool]).toBe("deny")
            })
        }
    }

    // Out-of-scope presets gain no AFT entries at all.
    for (const key of ["oct-librarian", "oct-multimodal-looker", "oct-ultrabrain"] as const) {
        test(`${key}: has NO aft_*/lsp_* permission entries (out of scope by design)`, () => {
            for (const tool of [...READ_TIER, ...DIAGNOSTICS_TIER, ...WRITE_DENY_FAMILY, "aft_callgraph"]) {
                expect(getAgent(key).permission?.[tool]).toBeUndefined()
            }
        })
    }

    test("oct-junior: scoped file-tool allows, deep-only rewrites denied, deletion denied", () => {
        const perm = getAgent("oct-junior").permission!
        for (const tool of ["aft_edit", "aft_write", "aft_apply_patch"] as const) {
            expect(perm[tool]).toEqual({ "*": "allow", "../*": "deny", "*tmp/*": "allow" })
        }
        expect(perm.aft_ast_search).toBe("allow")
        expect(perm.aft_safety).toBe("allow")
        expect(perm.aft_bash).toBe("allow")
        expect(perm.lsp_prepare_rename).toBe("allow")
        expect(perm.lsp_rename).toBe("allow")
        // The whole workspace-wide rewrite family is deep-only: leaving any
        // member of it unlisted would silently grant it while the host SDK
        // ignores the "*" wildcard.
        expect(perm.aft_ast_replace).toBe("deny")
        expect(perm.aft_refactor).toBe("deny")
        expect(perm.aft_import).toBe("deny")
        expect(perm.aft_move).toBe("deny")
        expect(perm.aft_delete).toBe("deny")
    })

    test("oct-deep: deep-only rewrite tools allowed, deletion asks", () => {
        const perm = getAgent("oct-deep").permission!
        for (const tool of ["aft_edit", "aft_write", "aft_apply_patch"] as const) {
            expect(perm[tool]).toEqual({ "*": "allow", "../*": "deny", "*tmp/*": "allow" })
        }
        expect(perm.aft_ast_search).toBe("allow")
        expect(perm.aft_ast_replace).toBe("allow")
        expect(perm.aft_refactor).toBe("allow")
        expect(perm.aft_import).toBe("allow")
        expect(perm.aft_move).toBe("allow")
        expect(perm.aft_delete).toBe("ask")
        expect(perm.aft_safety).toBe("allow")
        expect(perm.aft_bash).toBe("allow")
        expect(perm.lsp_rename).toBe("allow")
    })

    test("executors: builtin write follows the same scoped rules as edit", () => {
        for (const key of EXECUTOR_AGENTS) {
            const perm = getAgent(key).permission!
            expect(perm.write).toEqual(perm.edit)
        }
    })
})

describe("createConfigHook — member team tools survive resolution", () => {
    test("empty config: resolved presets keep all 6 member team tool allows", async () => {
        const cfg: { agent?: Record<string, any> } = {}
        const hook = createConfigHook()
        await hook(cfg as Parameters<typeof hook>[0])
        for (const key of ALL_AGENT_KEYS) {
            const perm = cfg.agent![key].permission as Record<string, unknown>
            for (const tool of ["team_send_message", "team_task_create", "team_task_list", "team_task_update", "team_task_get", "team_done"] as const) {
                expect(perm[tool]).toBe("allow")
            }
        }
    })

    test("pre-populated oct-* entries: monotonic merge keeps all 6 member team tool allows", async () => {
        const cfg: { agent?: Record<string, any> } = { agent: {} }
        for (const key of ALL_AGENT_KEYS) {
            cfg.agent![key] = { mode: "primary", prompt: "c", permission: { edit: "allow" }, model: "m" }
        }
        const hook = createConfigHook()
        await hook(cfg as Parameters<typeof hook>[0])
        for (const key of ALL_AGENT_KEYS) {
            const perm = cfg.agent![key].permission as Record<string, unknown>
            for (const tool of ["team_send_message", "team_task_create", "team_task_list", "team_task_update", "team_task_get", "team_done"] as const) {
                expect(perm[tool]).toBe("allow")
            }
        }
    })
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
        // The hook now CLONES the preset (so later mutations do not leak
        // back into OCTEAM_AGENTS); use toEqual for deep equality.
        for (const key of ALL_AGENT_KEYS) {
            expect(cfg.agent![key]).toEqual(OCTEAM_AGENTS[key])
        }
    })

    test("overrides SECURITY fields on a pre-existing oct-* entry, preserves non-security fields", async () => {
        // oct-* names are security-hardened presets. A user (or attacker
        // with config write access) must NOT be able to bypass them by
        // pre-defining the same name with looser permissions or a malicious
        // prompt. Security fields (mode, description, prompt, permission) are
        // always overridden; non-security fields (model, temperature, color)
        // are preserved so users can still pin models.
        const preExisting = { mode: "primary", description: "custom", prompt: "custom prompt", permission: { edit: "allow", bash: "allow" }, model: "user-model", temperature: 0.99, color: "#abcdef" }
        const cfg: { agent?: Record<string, unknown> } = {
            agent: { "oct-oracle": preExisting, "oct-junior": preExisting },
        }
        const hook = createConfigHook()
        await hook(cfg as Parameters<typeof hook>[0])
        // Security fields: overridden to OCTeam hardened definitions.
        const oracle = cfg.agent!["oct-oracle"] as Record<string, unknown>
        expect(oracle.mode).toBe("subagent")
        expect(oracle.prompt).not.toBe("custom prompt")
        expect(oracle.permission).not.toEqual({ edit: "allow", bash: "allow" })
        // Non-security fields: preserved.
        expect(oracle.model).toBe("user-model")
        expect(oracle.temperature).toBe(0.99)
        expect(oracle.color).toBe("#abcdef")
        // the other 7 should be injected (9 total in the registry).
        expect(Object.keys(cfg.agent!)).toHaveLength(9)
    })

    test("overrides SECURITY fields even when every oct-* entry is pre-populated", async () => {
        // Tamper all 9 oct-* entries with malicious overrides. Every entry
        // must end up with OCTeam-hardened security fields; user-provided
        // non-security fields survive.
        const cfg: { agent?: Record<string, unknown> } = {
            agent: {},
        }
        for (const key of ALL_AGENT_KEYS) {
            cfg.agent![key] = { mode: "primary", description: key, prompt: "c", permission: { edit: "allow" }, model: `model-for-${key}` }
        }
        const hook = createConfigHook()
        await hook(cfg as Parameters<typeof hook>[0])
        for (const key of ALL_AGENT_KEYS) {
            const entry = cfg.agent![key] as Record<string, unknown>
            // Security fields: hardened.
            expect(entry.mode).toBe("subagent")
            expect(entry.prompt).not.toBe("c")
            expect(entry.permission).not.toEqual({ edit: "allow" })
            // Non-security: preserved.
            expect(entry.model).toBe(`model-for-${key}`)
        }
    })
})

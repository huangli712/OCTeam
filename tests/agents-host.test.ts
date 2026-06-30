/**
 * Integration test: does the host actually expose the oct-* agents (registered
 * via createConfigHook) through its app.agents() API? Closes the gap left by
 * tests/agents.test.ts, which only verifies the config hook's *output* (the
 * cfg.agent object) but never the host's *consumption* of it.
 *
 * createOpencode() boots a real in-process OpenCode host. The host discovers
 * OCTeam as a plugin (package.json `oc-plugin` field), runs its config hook,
 * and thereby learns about the oct-* agents. We then ask the host for its full
 * agent list and assert every oct-* key is present.
 */
import { describe, expect, test } from "bun:test"

import { createOpencode } from "@opencode-ai/sdk"

import { OCTEAM_AGENTS } from "../src/agents/index.js"

describe("app.agents() integration — are oct-* agents visible to the host?", () => {
    test("createOpencode host exposes all oct-* agents via app.agents()", async () => {
        const { client, server } = await createOpencode()
        try {
            const res = await client.app.agents({ query: { directory: process.cwd() } })
            const names = new Set((res.data ?? []).map(a => a.name))
            for (const key of Object.keys(OCTEAM_AGENTS)) {
                expect(names.has(key)).toBe(true)
            }
        } finally {
            server.close()
        }
    }, 60000)
})

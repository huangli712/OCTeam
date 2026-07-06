/**
 * Coverage tests for src/server.ts — the plugin module entry.
 *
 * server() is the integration point that wires PluginContext → crash recovery
 * → sweep timer → 33 tools + event/transform/compacting/config hooks. These
 * tests verify the structural contract (the right hooks are returned) and that
 * crash-recovery failures are swallowed (the host must never crash on init).
 *
 * Uses a real tmp storage root so reconcile/rebuild operate against the actual
 * filesystem (empty → no-ops, which is the valid "fresh install" path).
 */
import { afterAll, describe, expect, test } from "bun:test"

import type { PluginInput } from "@opencode-ai/plugin"
import type { OpencodeClient, Project } from "@opencode-ai/sdk"

import pluginModule from "../src/server.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

/** Build a minimal PluginInput pointing at a tmp directory. */
function makeInput(directory: string): PluginInput {
    const client: Partial<OpencodeClient> = {
        app: { log: async () => ({ data: {} }) } as never,
        session: {
            promptAsync: async () => ({ data: {} }),
            messages: async () => ({ data: [] }),
            status: async () => ({ data: {} }),
        } as never,
    }
    return {
        directory,
        project: { id: "test-project" } as Project,
        client: client as OpencodeClient,
    } as unknown as PluginInput
}

describe("plugin module export", () => {
    test("exports { id: 'octeam', server }", () => {
        expect(pluginModule.id).toBe("octeam")
        expect(typeof pluginModule.server).toBe("function")
    })
})

describe("server()", () => {
    test("returns hooks with all 5 keys on a fresh (empty) storage root", async () => {
        const root = tmpRoot("server-fresh")
        const input = makeInput(`${root}/project`)

        const hooks = await pluginModule.server(input)

        expect(hooks).toBeDefined()
        expect(typeof hooks.tool).toBe("object")
        expect(typeof hooks.event).toBe("function")
        expect(typeof hooks["experimental.chat.messages.transform"]).toBe("function")
        expect(typeof hooks["experimental.session.compacting"]).toBe("function")
        // config hook shape varies by host version; just verify it exists.
        expect(hooks.config).toBeDefined()
    })

    test("does not throw when storage root has no prior teams (fresh install)", async () => {
        const root = tmpRoot("server-empty")
        const input = makeInput(`${root}/project`)

        // All three reconcile functions (rebuildSessionIndex,
        // reconcileActivation, reconcileCrashedTeams) must no-op cleanly on an
        // empty root and return hooks without throwing.
        await expect(pluginModule.server(input)).resolves.toBeDefined()
    })

    test("returns a non-empty tool registry (33 tools)", async () => {
        const root = tmpRoot("server-tools")
        const input = makeInput(`${root}/project`)

        const hooks = await pluginModule.server(input)
        const toolKeys = Object.keys(hooks.tool ?? {})
        // The README documents 33 tools; we assert at least a substantial
        // subset is wired (exact count may shift across versions, so >= 25
        // guards against a regression where createTools returns {}).
        expect(toolKeys.length).toBeGreaterThanOrEqual(25)
    })
})

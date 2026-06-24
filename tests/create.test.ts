import { afterEach, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import { teamCreateTool } from "../src/tools/lifecycle.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { resolveTeamMember, unindexSession } from "../src/core/utils.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

function makeCtx(storageRoot: string): PluginContext {
    // team_create's client.* calls are all best-effort (try/catch fallback), so
    // a minimal ctx without a client is sufficient to exercise the constraints.
    return { storageRoot, scope: "project" } as unknown as PluginContext
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("team_create constraints", () => {
    test("duplicate team name in same scope → rejected", async () => {
        const root = tmpRoot("create-dup")
        const sid = "ses_create_dup"
        tracked.push(sid)
        await initTeamState(root, makeState("alpha", sid, [makeMember("alice")]), sid)

        const tool = teamCreateTool(makeCtx(root))
        const result = await tool.execute(
            { name: "alpha", members: [{ role: "coder", prompt: "code" }] },
            { sessionID: sid } as any,
        )

        expect(result).toContain("already exists")
    })

    test("new team is always inactive (never auto-activated)", async () => {
        const root = tmpRoot("create-inactive")
        const sid = "ses_create_inactive"
        tracked.push(sid)

        const tool = teamCreateTool(makeCtx(root))
        const result = await tool.execute(
            { name: "beta", members: [{ role: "coder", prompt: "code" }] },
            { sessionID: sid } as any,
        )

        expect(result).toContain("inactive")
        expect(result).toContain("team_activate")
        const t = await loadTeamState(root, "beta", sid)
        expect(t.activatedAt).toBeUndefined()
        // no active pointer in memory → master resolves to null
        expect(await resolveTeamMember(root, sid)).toBeNull()
    })

    test("first team for a session is also inactive (no legacy auto-activate)", async () => {
        const root = tmpRoot("create-first-inactive")
        const sid = "ses_create_first"
        tracked.push(sid)

        const tool = teamCreateTool(makeCtx(root))
        await tool.execute(
            { name: "solo", members: [{ role: "coder", prompt: "code" }] },
            { sessionID: sid } as any,
        )

        const t = await loadTeamState(root, "solo", sid)
        expect(t.activatedAt).toBeUndefined()
        expect(await resolveTeamMember(root, sid)).toBeNull()
    })
})

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import { teamCreateTool } from "../src/tools/create.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { resolveTeamMember, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from './helpers.js';

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})
afterAll(cleanupTmpRoots)

describe("team_create constraints", () => {
    test("duplicate team name in same scope → rejected", async () => {
        const root = tmpRoot("create-dup")
        const sid = "ses_create_dup"
        tracked.push(sid)
        await initTeamState(root, makeState("alpha", sid, [makeMember("alice")]), sid)

        const tool = teamCreateTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { name: "alpha", members: [{ role: "coder", prompt: "code" }] },
            makeToolContext(sid),
        )

        expect(result).toContain("already exists")
    })

    test("new team is always inactive (never auto-activated)", async () => {
        const root = tmpRoot("create-inactive")
        const sid = "ses_create_inactive"
        tracked.push(sid)

        const tool = teamCreateTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { name: "beta", members: [{ role: "coder", prompt: "code" }] },
            makeToolContext(sid),
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

        const tool = teamCreateTool(makeCtx({ storageRoot: root }))
        await tool.execute(
            { name: "solo", members: [{ role: "coder", prompt: "code" }] },
            makeToolContext(sid),
        )

        const t = await loadTeamState(root, "solo", sid)
        expect(t.activatedAt).toBeUndefined()
        expect(await resolveTeamMember(root, sid)).toBeNull()
    })
})

import { afterEach, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { TeamSpec } from "../src/core/types.js"
import { teamListTool } from "../src/tools/list.js"
import { initTeamState, writeTeamSpec } from "../src/state/store.js"
import { unindexSession } from "../src/state/resolve.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

function makeCtx(storageRoot: string): PluginContext {
    return { storageRoot, scope: "project" } as unknown as PluginContext
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

async function setupTeam(
    storageRoot: string,
    name: string,
    sid: string,
    opts: { description?: string; activatedAt?: number; members?: number } = {},
): Promise<void> {
    const count = opts.members ?? 1
    const members = Array.from({ length: count }, (_, i) => makeMember(`m${i}`))
    await initTeamState(storageRoot, makeState(name, sid, members, opts.activatedAt), sid)
    const spec: TeamSpec = {
        version: 1,
        name,
        description: opts.description,
        createdAt: Date.now(),
        members: members.map(m => ({ name: m.name, role: "coder", prompt: "code" })),
    }
    await writeTeamSpec(storageRoot, spec, sid)
}

describe("team_list table format", () => {
    test("empty → No teams found", async () => {
        const root = tmpRoot("list-empty")
        const result = await teamListTool(makeCtx(root)).execute({}, { sessionID: "ses_x" } as any)
        expect(result).toBe("No teams found.")
    })

    test("single team → markdown table with 6 fields", async () => {
        const root = tmpRoot("list-one")
        const sid = "ses_list_one"
        tracked.push(sid)
        await setupTeam(root, "alpha", sid, {
            description: "My team",
            activatedAt: Date.now(),
            members: 3,
        })
        const result = await teamListTool(makeCtx(root)).execute({}, { sessionID: sid } as any)
        // header row
        expect(result).toContain("| Name | Description | Created | Members | Status | Active |")
        // data fields
        expect(result).toContain("alpha")
        expect(result).toContain("My team")
        expect(result).toContain("| 3 |")
        expect(result).toContain("live")
        expect(result).toContain("yes")
    })

    test("inactive team → active column shows no", async () => {
        const root = tmpRoot("list-inactive")
        const sid = "ses_list_inactive"
        tracked.push(sid)
        await setupTeam(root, "beta", sid, { description: "Idle team" })
        const result = await teamListTool(makeCtx(root)).execute({}, { sessionID: sid } as any)
        expect(result).toContain("| no |")
        expect(result).toContain("beta")
    })

    test("no description → shows dash", async () => {
        const root = tmpRoot("list-nodesc")
        const sid = "ses_list_nodesc"
        tracked.push(sid)
        await setupTeam(root, "gamma", sid, {})
        const result = await teamListTool(makeCtx(root)).execute({}, { sessionID: sid } as any)
        expect(result).toContain("| - |")
    })
})

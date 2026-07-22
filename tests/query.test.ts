import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import type { TeamSpec } from "../src/core/types.js"
import { teamQueryTool } from "../src/tools/query/inspect.js"
import { initTeamState, writeTeamSpec } from "../src/state/store.js"
import { teamDir, worktreesDir } from "../src/state/paths.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from './helpers.js';


const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})
afterAll(cleanupTmpRoots)

async function setupTeam(
    root: string,
    sid: string,
    opts: { members?: ReturnType<typeof makeMember>[]; activatedAt?: number } = {},
): Promise<void> {
    const members = opts.members ?? [makeMember("alice")]
    await initTeamState(root, makeState("alpha", sid, members, opts.activatedAt), sid)
    const spec: TeamSpec = {
        version: 1,
        name: "alpha",
        createdAt: Date.now(),
        members: members.map(m => ({
            name: m.name,
            role: "coder",
            prompt: "write code",
            agent: "build",
            model: m.model,
        })),
    }
    await writeTeamSpec(root, spec, sid)
    await rebuildSessionIndex(root, `${root}__unused`)
}

describe("team_query tool", () => {
    test("team not found → error (caller not a member)", async () => {
        const root = tmpRoot("q-404")
        const result = await teamQueryTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "nonexistent", member_name: "alice" },
            makeToolContext("ses_x"),
        )
        expect(result).toContain("Error")
        expect(result).toContain("not a member")
    })

    test("member not found → error", async () => {
        const root = tmpRoot("q-member-404")
        const sid = "ses_q_404"
        tracked.push(sid)
        await setupTeam(root, sid, { activatedAt: Date.now() })
        const result = await teamQueryTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", member_name: "bob" },
            makeToolContext(sid),
        )
        expect(result).toContain("not found")
    })

    test("existing member → shows 7 core fields + conditional fields", async () => {
        const root = tmpRoot("q-fields")
        const sid = "ses_q_fields"
        tracked.push(sid)
        const alice = { ...makeMember("alice"), model: "anthropic/claude" }
        await setupTeam(root, sid, { members: [alice], activatedAt: Date.now() })
        const result = await teamQueryTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", member_name: "alice" },
            makeToolContext(sid),
        )
        // 7 core fields
        expect(result).toContain("Name:")
        expect(result).toContain("Role:")
        expect(result).toContain("Prompt:")
        expect(result).toContain("Model:")
        expect(result).toContain("Agent:")
        expect(result).toContain("Status:")
        // bonus fields
        expect(result).toContain("Initialized:")
        expect(result).toContain("Turn count:")
    })

    test("member with worktreePath → shows the path", async () => {
        const root = tmpRoot("q-wt")
        const sid = "ses_q_wt"
        tracked.push(sid)
        const wtPath = `${worktreesDir(teamDir(root, "alpha", sid))}/alice`
        const alice = { ...makeMember("alice"), worktreePath: wtPath }
        await setupTeam(root, sid, { members: [alice], activatedAt: Date.now() })
        const result = await teamQueryTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", member_name: "alice" },
            makeToolContext(sid),
        )
        expect(result).toContain(wtPath)
    })

    test("member without model → model field shown as 'unknown'", async () => {
        const root = tmpRoot("q-nomodel")
        const sid = "ses_q_nomodel"
        tracked.push(sid)
        await setupTeam(root, sid, { members: [makeMember("alice")], activatedAt: Date.now() })
        const result = await teamQueryTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", member_name: "alice" },
            makeToolContext(sid),
        )
        expect(result).toContain("Model:")
        expect(result).toContain("unknown")
    })
})

/**
 * Coverage-gap tests for src/tools/remove.ts — the mutex-internal revalidation
 * branches that the happy-path tests in member-add-remove.test.ts don't reach:
 *   - team not found (line 26)
 *   - spec read throws / returns null inside mutex (lines 60-61, 65-66)
 *
 * The staleState race (lines 52-53) requires deterministic mutex occupation
 * and is fragile in CI; the outer status check (line 32) covers the same
 * error message, so we skip the race variant here.
 */
import fs from "node:fs/promises"

import { afterAll, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { TeamSpec } from "../src/core/types.js"
import { normalizeRole } from "../src/core/role.js"
import { teamRemoveMemberTool } from "../src/tools/remove.js"
import { initTeamState, invalidateTeam, loadTeamState, writeTeamSpec } from "../src/state/store.js"
import { configPath } from "../src/state/paths.js"
import { unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

function makeCtx(storageRoot: string): PluginContext {
    return { storageRoot, scope: "project" } as unknown as PluginContext
}

async function setupLiveTeam(
    root: string,
    sid: string,
    name: string,
    members: { name: string; role: string; prompt: string }[],
) {
    const spec: TeamSpec = {
        version: 1,
        name,
        description: "test",
        createdAt: Date.now(),
        members: members.map(m => ({ name: m.name, role: normalizeRole(m.role), prompt: m.prompt })),
    }
    await writeTeamSpec(root, spec, sid)
    const state = makeState(name, sid, members.map(m => makeMember(m.name)))
    const team = await initTeamState(root, state, sid)
    return { team, spec }
}

describe("team_remove_member: error paths", () => {
    test("team not found → error", async () => {
        const root = tmpRoot("rm-404")
        const result = await teamRemoveMemberTool(makeCtx(root)).execute(
            { team_id: "ghost", member_name: "alice" },
            makeToolContext("ses_rm_404"),
        )
        expect(result).toContain("not found")
    })

    test("config.json corrupted → specError (readTeamSpec throws inside mutex)", async () => {
        const root = tmpRoot("rm-bad-spec")
        const sid = "ses_rm_bad_spec"
        const { team } = await setupLiveTeam(root, sid, "alpha", [
            { name: "alice", role: "coder", prompt: "code" },
            { name: "bob", role: "tester", prompt: "test" },
        ])
        // Corrupt config.json so readTeamSpec throws JSON.parse error inside mutex.
        const cfgPath = configPath(team.directory)
        await fs.writeFile(cfgPath, "{ invalid json", "utf8")

        const result = await teamRemoveMemberTool(makeCtx(root)).execute(
            { team_id: "alpha", member_name: "bob" },
            makeToolContext(sid),
        )
        expect(result).toContain("cannot read config")
        // Members unchanged (error returned before splice).
        const reloaded = await loadTeamState(root, "alpha", sid)
        expect(reloaded.members.length).toBe(2)
        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("config.json absent → specError (readTeamSpec returns null inside mutex)", async () => {
        const root = tmpRoot("rm-no-spec")
        const sid = "ses_rm_no_spec"
        const { team } = await setupLiveTeam(root, sid, "beta", [
            { name: "alice", role: "coder", prompt: "code" },
            { name: "bob", role: "tester", prompt: "test" },
        ])
        // Delete config.json so readTeamSpec returns null.
        await fs.unlink(configPath(team.directory))

        const result = await teamRemoveMemberTool(makeCtx(root)).execute(
            { team_id: "beta", member_name: "bob" },
            makeToolContext(sid),
        )
        expect(result).toContain("cannot read config")
        invalidateTeam(team.directory)
        unindexSession(sid)
    })
})

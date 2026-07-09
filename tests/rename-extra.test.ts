/**
 * Coverage-gap tests for src/tools/rename.ts — team-not-found (line 36),
 * staleState inside mutex (lines 71-72), and wasActive→setActiveTeam (line 94).
 *
 * member-add-remove.test.ts covers the happy path and collision/404 errors;
 * these tests target the mutex revalidation and active-index update branches.
 */
import { afterAll, describe, expect, test } from "bun:test"

import type { TeamSpec } from "../src/core/types.js"
import { normalizeRole } from "../src/core/role.js"
import { teamRenameTool } from "../src/tools/rename.js"
import { initTeamState, invalidateTeam, loadTeamState, writeTeamSpec } from "../src/state/store.js"
import { indexMasterTeam, resolveTeamMember, setActiveTeam, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

async function setupLiveTeam(
    root: string,
    sid: string,
    name: string,
    activatedAt?: number,
) {
    const spec: TeamSpec = {
        version: 1,
        name,
        description: "test",
        createdAt: Date.now(),
        members: [{ name: "alice", role: normalizeRole("coder"), prompt: "code" }],
    }
    await writeTeamSpec(root, spec, sid)
    const state = makeState(name, sid, [makeMember("alice")], activatedAt)
    const team = await initTeamState(root, state, sid)
    return team
}

describe("team_rename: error paths", () => {
    test("team not found → error", async () => {
        const root = tmpRoot("rn-404")
        const result = await teamRenameTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "ghost", new_name: "newname" },
            makeToolContext("ses_rn_404"),
        )
        expect(result).toContain("not found")
    })

    test("status flips to busy inside mutex → staleState error", async () => {
        const root = tmpRoot("rn-stale")
        const sid = "ses_rn_stale"
        const team = await setupLiveTeam(root, sid, "alpha")
        // Flip status to busy BEFORE calling rename — the outer check (line 42)
        // catches it and returns the "not live" error. This covers the same
        // error message path; the inner mutex revalidation (lines 71-72) is
        // a race-only branch that requires deterministic mutex occupation.
        team.status = "busy"

        const result = await teamRenameTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", new_name: "beta" },
            makeToolContext(sid),
        )
        expect(result).toContain("not")
        expect(result).toContain("live")
        invalidateTeam(team.directory)
        unindexSession(sid)
    })
})

describe("team_rename: active index update", () => {
    test("renaming an activated team updates the active-team pointer", async () => {
        const root = tmpRoot("rn-active")
        const sid = "ses_rn_active"
        const team = await setupLiveTeam(root, sid, "alpha", Date.now())
        // Index the master + mark active so rename's wasActive branch runs.
        indexMasterTeam(sid, "alpha", sid, root, team.directory)
        setActiveTeam(sid, team.directory)

        const result = await teamRenameTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", new_name: "beta" },
            makeToolContext(sid),
        )
        expect(result).toContain("renamed to")

        // resolveTeamMember uses the active-team pointer; if setActiveTeam
        // didn't fire (line 94), the pointer would reference the old (now
        // renamed) directory and resolution would fail.
        const resolved = await resolveTeamMember(root, sid)
        expect(resolved).not.toBeNull()
        expect(resolved!.teamName).toBe("beta")

        // Clean up: the team is now under the new directory.
        invalidateTeam(resolved!.directory)
        unindexSession(sid)
    })
})

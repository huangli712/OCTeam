/**
 * Regression tests for the agent-field permission-hardening chokepoint (P0-2).
 *
 * Threat model: the `agent` field determines which OpenCode agent a member
 * runs as, and that agent's permission map is the runtime capability boundary.
 * role.ts documents "permissions are fixed by the oct-* definitions, not by
 * host configuration." Before the P0-2 fix, create/add/fix accepted ANY string
 * for `agent`, letting a member be assigned a bare host agent (e.g. "build"
 * with full edit/bash/task/webfetch) that bypassed the hardened oct-* maps.
 *
 * Fix: all three tool schemas validate `agent` against the OCTEAM_AGENTS
 * allowlist (role.ts) in their execute body; isValidTeamState rejects a
 * non-oct-* member agent on disk reload; dispatch uses safeMemberAgent (fails
 * safe to oct-oracle, never to "build").
 *
 * These tests verify the tool-layer rejection (the schema gate). The
 * dispatch-level fail-safe is covered by tests/dispatch-context.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { teamCreateTool } from "../src/tools/lifecycle/create.js"
import { teamAddMemberTool } from "../src/tools/lifecycle/add.js"
import { teamFixMemberTool } from "../src/tools/lifecycle/fixmember.js"
import { initTeamState, loadTeamState, writeTeamSpec } from "../src/state/store.js"
import { indexMasterTeam, setActiveTeam, unindexSession } from "../src/state/resolve.js"
import { makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"
import type { TeamSpec } from "../src/core/types.js"

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

/** Set up a live team with both config.json (TeamSpec) and state.json. */
async function setupLiveTeam(root: string, sid: string, members: ReturnType<typeof makeMember>[]): Promise<void> {
    const state = makeState("alpha", sid, members)
    state.status = "live"
    await initTeamState(root, state, sid)
    const spec: TeamSpec = {
        version: 1,
        name: "alpha",
        createdAt: Date.now(),
        members: members.map(m => ({
            name: m.name,
            role: "coder",
            prompt: "code",
            agent: "oct-junior",
        })),
    }
    await writeTeamSpec(root, spec, sid)
}

describe("team_create: agent must be a hardened oct-* agent (P0-2)", () => {
    test("'build' (bare host agent) is rejected", async () => {
        const root = tmpRoot("p02-crt-build")
        const sid = "ses_p02_crt_build"
        tracked.push(sid)

        const tool = teamCreateTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            {
                name: "alpha",
                members: [{ role: "coder", prompt: "code", agent: "build" }],
            },
            makeToolContext(sid),
        )

        expect(result).toMatch(/Error:.*not a hardened oct-\* agent/i)
        expect(result).toMatch(/build/)
    })

    test("'oracle' (bare host agent name, not oct-oracle) is rejected", async () => {
        const root = tmpRoot("p02-crt-oracle")
        const sid = "ses_p02_crt_oracle"
        tracked.push(sid)

        const tool = teamCreateTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            {
                name: "alpha",
                members: [{ role: "coder", prompt: "code", agent: "oracle" }],
            },
            makeToolContext(sid),
        )

        expect(result).toMatch(/Error:.*not a hardened oct-\* agent/i)
    })

    test("'oct-junior' (valid oct-* agent) is accepted", async () => {
        const root = tmpRoot("p02-crt-ok")
        const sid = "ses_p02_crt_ok"
        tracked.push(sid)

        const tool = teamCreateTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            {
                name: "alpha",
                members: [{ role: "coder", prompt: "code", agent: "oct-junior" }],
            },
            makeToolContext(sid),
        )

        // Accepted — no agent-validation error. The team is created.
        expect(result).not.toMatch(/not a hardened oct-\* agent/i)
        expect(result).toContain("created")
    })

    test("omitting agent entirely is accepted (derived from role)", async () => {
        const root = tmpRoot("p02-crt-omit")
        const sid = "ses_p02_crt_omit"
        tracked.push(sid)

        const tool = teamCreateTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            {
                name: "alpha",
                members: [{ role: "coder", prompt: "code" }],
            },
            makeToolContext(sid),
        )

        expect(result).not.toMatch(/not a hardened oct-\* agent/i)
        expect(result).toContain("created")
    })
})

describe("team_add_member: agent must be a hardened oct-* agent (P0-2)", () => {
    test("'build' is rejected", async () => {
        const root = tmpRoot("p02-add-build")
        const sid = "ses_p02_add_build"
        tracked.push(sid)
        await setupLiveTeam(root, sid, [makeMember("alice")])

        const tool = teamAddMemberTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            {
                team_id: "alpha",
                role: "coder",
                prompt: "code",
                agent: "build",
            },
            makeToolContext(sid),
        )

        expect(result).toMatch(/Error:.*not a hardened oct-\* agent/i)
    })

    test("'oct-oracle' is accepted", async () => {
        const root = tmpRoot("p02-add-ok")
        const sid = "ses_p02_add_ok"
        tracked.push(sid)
        await setupLiveTeam(root, sid, [makeMember("alice")])

        const tool = teamAddMemberTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            {
                team_id: "alpha",
                role: "reviewer",
                prompt: "review",
                agent: "oct-oracle",
            },
            makeToolContext(sid),
        )

        expect(result).not.toMatch(/not a hardened oct-\* agent/i)
        expect(result).toContain("added")
    })
})

describe("team_fix_member: new_agent must be a hardened oct-* agent (P0-2)", () => {
    test("'build' is rejected", async () => {
        const root = tmpRoot("p02-fix-build")
        const sid = "ses_p02_fix_build"
        tracked.push(sid)
        const team_state = makeState("alpha", sid, [makeMember("alice")])
        await initTeamState(root, team_state, sid)
        // fix uses resolveCallerInTeam with requireActive:false, but still
        // needs the master session indexed for this team so the caller resolves
        // to the synthetic master.
        const team = await loadTeamState(root, "alpha", sid)
        indexMasterTeam(sid, "alpha", sid, root, team.directory)
        setActiveTeam(sid, team.directory)

        const tool = teamFixMemberTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            {
                team_id: "alpha",
                member_name: "alice",
                new_agent: "build",
            },
            makeToolContext(sid),
        )

        expect(result).toMatch(/Error:.*not a hardened oct-\* agent/i)
    })

    test("'oct-explore' is accepted", async () => {
        const root = tmpRoot("p02-fix-ok")
        const sid = "ses_p02_fix_ok"
        tracked.push(sid)
        await initTeamState(root, makeState("alpha", sid, [makeMember("alice")]), sid)
        const team = await loadTeamState(root, "alpha", sid)
        indexMasterTeam(sid, "alpha", sid, root, team.directory)
        setActiveTeam(sid, team.directory)

        const tool = teamFixMemberTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            {
                team_id: "alpha",
                member_name: "alice",
                new_agent: "oct-explore",
            },
            makeToolContext(sid),
        )

        expect(result).not.toMatch(/not a hardened oct-\* agent/i)
        expect(result).toMatch(/updated/i)
    })
})

import { describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { TeamSpec } from "../src/core/types.js"
import { normalizeRole } from "../src/core/role.js"
import { teamAddMemberTool } from "../src/tools/lifecycle/add.js"
import { teamRemoveMemberTool } from "../src/tools/lifecycle/remove.js"
import { teamRenameTool } from "../src/tools/lifecycle/rename.js"
import { initTeamState, invalidateTeam, loadTeamState, readTeamSpec, writeTeamSpec } from "../src/state/store.js"
import { unindexSession } from "../src/state/resolve.js"
import { makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"

/** Create a live team with both state.json and config.json for testing member add/remove. */
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
        members: members.map(m => ({
            name: m.name,
            role: normalizeRole(m.role),
            prompt: m.prompt,
        })),
    }
    await writeTeamSpec(root, spec, sid)
    const state = makeState(name, sid, members.map(m => makeMember(m.name)))
    const team = await initTeamState(root, state, sid)
    return { team, spec }
}

describe("team_add_member", () => {
    test("adds member to live team → success, spec + state updated", async () => {
        const root = tmpRoot("add-ok")
        const sid = "ses_add_ok"
        const { team } = await setupLiveTeam(root, sid, "alpha", [
            { name: "alice", role: "coder", prompt: "code" },
            { name: "bob", role: "tester", prompt: "test" },
        ])

        const tool = teamAddMemberTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "alpha", role: "physicist", prompt: "do physics" },
            makeToolContext(sid),
        )

        expect(result).toContain("added to team")
        expect(result).toContain("3 members")
        const reloaded = await loadTeamState(root, "alpha", sid)
        expect(reloaded.members.length).toBe(3)
        const spec = await readTeamSpec(root, "alpha", sid)
        expect(spec?.members.length).toBe(3)

        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("adds member with explicit name → name honored", async () => {
        const root = tmpRoot("add-name")
        const sid = "ses_add_name"
        const { team } = await setupLiveTeam(root, sid, "beta", [
            { name: "alice", role: "coder", prompt: "code" },
        ])

        const tool = teamAddMemberTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "beta", name: "bob", role: "tester", prompt: "test" },
            makeToolContext(sid),
        )

        expect(result).toContain("bob")
        const reloaded = await loadTeamState(root, "beta", sid)
        expect(reloaded.members.find(m => m.name === "bob")).toBeTruthy()

        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("duplicate name → rejected", async () => {
        const root = tmpRoot("add-dup")
        const sid = "ses_add_dup"
        const { team } = await setupLiveTeam(root, sid, "gamma", [
            { name: "alice", role: "coder", prompt: "code" },
        ])

        const tool = teamAddMemberTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "gamma", name: "alice", role: "tester", prompt: "test" },
            makeToolContext(sid),
        )

        expect(result).toContain("already exists")

        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("reserved name 'master' → rejected", async () => {
        const root = tmpRoot("add-master")
        const sid = "ses_add_master"
        const { team } = await setupLiveTeam(root, sid, "delta", [
            { name: "alice", role: "coder", prompt: "code" },
        ])

        const tool = teamAddMemberTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "delta", name: "master", role: "coder", prompt: "c" },
            makeToolContext(sid),
        )

        expect(result).toContain("reserved")

        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("non-live team → rejected", async () => {
        const root = tmpRoot("add-notlive")
        const sid = "ses_add_notlive"
        const { team } = await setupLiveTeam(root, sid, "epsilon", [
            { name: "alice", role: "coder", prompt: "code" },
        ])
        // Force status to idle (simulating post-spawn).
        team.status = "idle"

        const tool = teamAddMemberTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "epsilon", role: "coder", prompt: "p" },
            makeToolContext(sid),
        )

        expect(result).toContain("not \"live\"")

        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("non-master caller → rejected", async () => {
        const root = tmpRoot("add-nonmaster")
        const sid = "ses_add_nonmaster"
        const { team } = await setupLiveTeam(root, undefined as never, "zeta", [
            { name: "alice", role: "coder", prompt: "code" },
        ])

        const ctx = { storageRoot: root, scope: "user" } as unknown as PluginContext
        const tool = teamAddMemberTool(ctx)
        const result = await tool.execute(
            { team_id: "zeta", role: "coder", prompt: "p" },
            makeToolContext("ses_other"),
        )

        expect(result).toContain("master-only")

        invalidateTeam(team.directory)
        unindexSession(sid)
    })
})

describe("team_remove_member", () => {
    test("removes member from live 2+ team → success", async () => {
        const root = tmpRoot("rm-ok")
        const sid = "ses_rm_ok"
        const { team } = await setupLiveTeam(root, sid, "alpha", [
            { name: "alice", role: "coder", prompt: "code" },
            { name: "bob", role: "tester", prompt: "test" },
        ])

        const tool = teamRemoveMemberTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "alpha", member_name: "bob" },
            makeToolContext(sid),
        )

        expect(result).toContain("removed")
        expect(result).toContain("1 members remaining")
        const reloaded = await loadTeamState(root, "alpha", sid)
        expect(reloaded.members.length).toBe(1)
        expect(reloaded.members[0].name).toBe("alice")
        const spec = await readTeamSpec(root, "alpha", sid)
        expect(spec?.members.length).toBe(1)

        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("last member → rejected", async () => {
        const root = tmpRoot("rm-last")
        const sid = "ses_rm_last"
        const { team } = await setupLiveTeam(root, sid, "beta", [
            { name: "solo", role: "coder", prompt: "code" },
        ])

        const tool = teamRemoveMemberTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "beta", member_name: "solo" },
            makeToolContext(sid),
        )

        expect(result).toContain("Cannot remove the last member")

        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("non-existent member → rejected", async () => {
        const root = tmpRoot("rm-missing")
        const sid = "ses_rm_missing"
        const { team } = await setupLiveTeam(root, sid, "gamma", [
            { name: "alice", role: "coder", prompt: "code" },
        ])

        const tool = teamRemoveMemberTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "gamma", member_name: "ghost" },
            makeToolContext(sid),
        )

        expect(result).toContain("not found")

        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("non-live team → rejected", async () => {
        const root = tmpRoot("rm-notlive")
        const sid = "ses_rm_notlive"
        const { team } = await setupLiveTeam(root, sid, "delta", [
            { name: "alice", role: "coder", prompt: "code" },
            { name: "bob", role: "tester", prompt: "test" },
        ])
        team.status = "idle"

        const tool = teamRemoveMemberTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "delta", member_name: "bob" },
            makeToolContext(sid),
        )

        expect(result).toContain("not \"live\"")

        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("non-master caller → rejected", async () => {
        const root = tmpRoot("rm-nonmaster")
        const sid = "ses_rm_nonmaster"
        const { team } = await setupLiveTeam(root, undefined as never, "epsilon", [
            { name: "alice", role: "coder", prompt: "code" },
            { name: "bob", role: "tester", prompt: "test" },
        ])

        const ctx = { storageRoot: root, scope: "user" } as unknown as PluginContext
        const tool = teamRemoveMemberTool(ctx)
        const result = await tool.execute(
            { team_id: "epsilon", member_name: "bob" },
            makeToolContext("ses_other"),
        )

        expect(result).toContain("master-only")

        invalidateTeam(team.directory)
        unindexSession(sid)
    })
})

describe("team_rename", () => {
    test("rename live team → success, state + spec + directory updated", async () => {
        const root = tmpRoot("rn-ok")
        const sid = "ses_rn_ok"
        await setupLiveTeam(root, sid, "old-name", [
            { name: "alice", role: "coder", prompt: "code" },
        ])

        const tool = teamRenameTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "old-name", new_name: "new-name" },
            makeToolContext(sid),
        )

        expect(result).toContain("renamed to")
        expect(result).toContain("new-name")
        // Old name should not be loadable.
        expect(
            loadTeamState(root, "old-name", sid),
        ).rejects.toThrow()
        // New name should be loadable.
        const reloaded = await loadTeamState(root, "new-name", sid)
        expect(reloaded.teamName).toBe("new-name")

        invalidateTeam(reloaded.directory)
        unindexSession(sid)
    })

    test("same name → idempotent no-op", async () => {
        const root = tmpRoot("rn-same")
        const sid = "ses_rn_same"
        const { team } = await setupLiveTeam(root, sid, "zeta", [
            { name: "alice", role: "coder", prompt: "code" },
        ])

        const tool = teamRenameTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "zeta", new_name: "zeta" },
            makeToolContext(sid),
        )

        expect(result).toContain("already named")

        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("name collision → rejected", async () => {
        const root = tmpRoot("rn-collide")
        const sid = "ses_rn_collide"
        const { team } = await setupLiveTeam(root, sid, "alpha", [
            { name: "alice", role: "coder", prompt: "code" },
        ])
        await setupLiveTeam(root, sid, "beta", [
            { name: "bob", role: "coder", prompt: "code" },
        ])

        const tool = teamRenameTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "alpha", new_name: "beta" },
            makeToolContext(sid),
        )

        expect(result).toContain("already exists")

        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("non-live team → rejected", async () => {
        const root = tmpRoot("rn-notlive")
        const sid = "ses_rn_notlive"
        const { team } = await setupLiveTeam(root, sid, "gamma", [
            { name: "alice", role: "coder", prompt: "code" },
        ])
        team.status = "idle"

        const tool = teamRenameTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            { team_id: "gamma", new_name: "delta" },
            makeToolContext(sid),
        )

        expect(result).toContain("not \"live\"")

        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("non-master caller → rejected", async () => {
        const root = tmpRoot("rn-nonmaster")
        const sid = "ses_rn_nonmaster"
        const { team } = await setupLiveTeam(root, undefined as never, "epsilon", [
            { name: "alice", role: "coder", prompt: "code" },
        ])

        const ctx = { storageRoot: root, scope: "user" } as unknown as PluginContext
        const tool = teamRenameTool(ctx)
        const result = await tool.execute(
            { team_id: "epsilon", new_name: "zeta" },
            makeToolContext("ses_other"),
        )

        expect(result).toContain("master-only")

        invalidateTeam(team.directory)
        unindexSession(sid)
    })

    test("invalid name format → rejected", async () => {
        const root = tmpRoot("rn-badfmt")
        const sid = "ses_rn_badfmt"
        const { team } = await setupLiveTeam(root, sid, "eta", [
            { name: "alice", role: "coder", prompt: "code" },
        ])

        const toolDef = teamRenameTool(makeCtx({ storageRoot: root }))
        // new_name regex: /^[a-z0-9-]+$/ — enforced at the MCP layer via Zod,
        // not inside execute(). Verify the schema directly.
        expect(toolDef.args.new_name.safeParse("INVALID").success).toBe(false)
        expect(toolDef.args.new_name.safeParse("valid-name").success).toBe(true)

        invalidateTeam(team.directory)
        unindexSession(sid)
    })
})

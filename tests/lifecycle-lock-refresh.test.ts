import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"

import type { TeamSpec, TeamState } from "../src/core/types.js"
import { unindexSession } from "../src/state/resolve.js"
import { statePath } from "../src/state/paths.js"
import { initTeamState, readTeamSpec, writeTeamSpec } from "../src/state/store.js"
import { teamAddMemberTool } from "../src/tools/lifecycle/add.js"
import { teamFixMemberTool } from "../src/tools/lifecycle/fixmember.js"
import { teamRemoveMemberTool } from "../src/tools/lifecycle/remove.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

const trackedSessions: string[] = []
afterEach(() => {
    for (const sessionId of trackedSessions.splice(0)) unindexSession(sessionId)
})

async function writeDiskState(filePath: string, mutate: (state: TeamState) => void): Promise<void> {
    const state = JSON.parse(await fs.readFile(filePath, "utf8")) as TeamState
    mutate(state)
    await fs.writeFile(filePath, JSON.stringify(state, null, 2))
}

describe("lifecycle tools refresh state after acquiring the file lock", () => {
    test("team_add_member sees a cross-process member that fills the capacity", async () => {
        const root = tmpRoot("lifecycle-refresh-add")
        const sid = "ses_lifecycle_refresh_add"
        trackedSessions.push(sid)
        const state = makeState("alpha", sid, [makeMember("alice")])
        state.bounds.maxMembers = 2
        const team = await initTeamState(root, state, sid)
        const spec: TeamSpec = {
            version: 1,
            name: "alpha",
            createdAt: Date.now(),
            members: [{ name: "alice", role: "coder", prompt: "a" }],
        }
        await writeTeamSpec(root, spec, sid)
        await writeDiskState(statePath(team.directory), disk => {
            disk.members.push(makeMember("bob"))
        })
        spec.members.push({ name: "bob", role: "coder", prompt: "b" })
        await writeTeamSpec(root, spec, sid)
        team._lastCacheCheck = Date.now()

        const result = await teamAddMemberTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", name: "carol", role: "coder", prompt: "c" },
            makeToolContext(sid),
        )

        expect(result).toContain("maximum")
        const disk = JSON.parse(await fs.readFile(statePath(team.directory), "utf8")) as TeamState
        expect(disk.members.map(member => member.name)).toEqual(["alice", "bob"])
    })

    test("team_remove_member sees that another process already removed the target", async () => {
        const root = tmpRoot("lifecycle-refresh-remove")
        const sid = "ses_lifecycle_refresh_remove"
        trackedSessions.push(sid)
        const team = await initTeamState(root, makeState("alpha", sid, [makeMember("alice"), makeMember("bob")]), sid)
        const spec: TeamSpec = {
            version: 1,
            name: "alpha",
            createdAt: Date.now(),
            members: [
                { name: "alice", role: "coder", prompt: "a" },
                { name: "bob", role: "coder", prompt: "b" },
            ],
        }
        await writeTeamSpec(root, spec, sid)
        await writeDiskState(statePath(team.directory), disk => {
            disk.members = disk.members.filter(member => member.name !== "bob")
        })
        const updatedSpec: TeamSpec = {
            ...spec,
            members: spec.members.filter(member => member.name !== "bob"),
        }
        await writeTeamSpec(root, updatedSpec, sid)
        team._lastCacheCheck = Date.now()

        const result = await teamRemoveMemberTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", member_name: "bob" },
            makeToolContext(sid),
        )

        expect(result).toMatch(/^Error:/)
        const disk = JSON.parse(await fs.readFile(statePath(team.directory), "utf8")) as TeamState
        expect(disk.members.map(member => member.name)).toEqual(["alice"])
    })

    test("team_fix_member sees that another process started the target member", async () => {
        const root = tmpRoot("lifecycle-refresh-fix")
        const sid = "ses_lifecycle_refresh_fix"
        trackedSessions.push(sid)
        const team = await initTeamState(root, makeState("alpha", sid, [makeMember("alice")]), sid)
        await writeTeamSpec(root, {
            version: 1,
            name: "alpha",
            createdAt: Date.now(),
            members: [{ name: "alice", role: "coder", prompt: "old" }],
        }, sid)
        await writeDiskState(statePath(team.directory), disk => {
            const alice = disk.members.find(member => member.name === "alice")
            if (alice) alice.status = "running"
        })
        team._lastCacheCheck = Date.now()

        const result = await teamFixMemberTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", member_name: "alice", new_prompt: "new" },
            makeToolContext(sid),
        )

        expect(result).toContain("running")
        expect((await readTeamSpec(root, "alpha", sid))?.members[0]?.prompt).toBe("old")
    })
})

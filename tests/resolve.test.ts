import { afterEach, describe, expect, test } from "bun:test"

import { teamDir } from "../src/state/paths.js"
import { initTeamState } from "../src/state/store.js"
import {
    indexMasterTeam,
    indexMember,
    resolveCallerInTeam,
    resolveMasterTeams,
    resolveTeamMember,
    setActiveTeam,
    unindexMasterTeam,
    unindexSession,
} from "../src/core/utils.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

const LEAD = "ses_lead"
const MEMBER = "ses_member"

afterEach(() => {
    unindexSession(LEAD)
    unindexSession(MEMBER)
})

describe("resolveTeamMember scoping", () => {
    test("master resolves with leadSessionId + leader's team dir", async () => {
        const root = tmpRoot("resolve-master")
        const team = await initTeamState(root, makeState("aaa", LEAD, [makeMember("bob", MEMBER)]), LEAD)
        indexMasterTeam(LEAD, "aaa", LEAD, root, team.directory)
        setActiveTeam(LEAD, team.directory)

        const resolved = await resolveTeamMember(root, LEAD)
        expect(resolved).not.toBeNull()
        expect(resolved?.isMaster).toBe(true)
        expect(resolved?.leadSessionId).toBe(LEAD)
        expect(resolved?.directory).toBe(teamDir(root, "aaa", LEAD))
    })

    test("master with NO active team resolves to null", async () => {
        const root = tmpRoot("resolve-master-inactive")
        const team = await initTeamState(root, makeState("aaa", LEAD, [makeMember("bob", MEMBER)]), LEAD)
        indexMasterTeam(LEAD, "aaa", LEAD, root, team.directory)
        // no setActiveTeam → no active pointer

        const resolved = await resolveTeamMember(root, LEAD)
        expect(resolved).toBeNull()
    })

    test("project-team member resolves to LEADER's session dir, not its own", async () => {
        const root = tmpRoot("resolve-member")
        await initTeamState(root, makeState("aaa", LEAD, [makeMember("bob", MEMBER)]), LEAD)
        indexMember(MEMBER, "aaa", "bob", LEAD, root)

        const resolved = await resolveTeamMember(root, MEMBER)
        expect(resolved).not.toBeNull()
        expect(resolved?.name).toBe("bob")
        expect(resolved?.leadSessionId).toBe(LEAD)
        // directory is the LEADER's session dir...
        expect(resolved?.directory).toBe(teamDir(root, "aaa", LEAD))
        expect(resolved?.directory).toContain(LEAD)
        // ...NOT a dir scoped to the member's own session id.
        expect(resolved?.directory).not.toContain(MEMBER)
    })
})

describe("master 1:many index", () => {
    test("master owns two teams → resolveMasterTeams returns both", async () => {
        const root = tmpRoot("multi-enum")
        const a = await initTeamState(root, makeState("aaa", LEAD), LEAD)
        const b = await initTeamState(root, makeState("bbb", LEAD), LEAD)
        indexMasterTeam(LEAD, "aaa", LEAD, root, a.directory)
        indexMasterTeam(LEAD, "bbb", LEAD, root, b.directory)

        const teams = resolveMasterTeams(LEAD)
        expect(teams.length).toBe(2)
        expect(teams.map(t => t.teamName).sort()).toEqual(["aaa", "bbb"])
    })

    test("resolveTeamMember returns the ACTIVE team among many", async () => {
        const root = tmpRoot("multi-active")
        const a = await initTeamState(root, makeState("aaa", LEAD), LEAD)
        const b = await initTeamState(root, makeState("bbb", LEAD, [], Date.now()), LEAD)
        indexMasterTeam(LEAD, "aaa", LEAD, root, a.directory)
        indexMasterTeam(LEAD, "bbb", LEAD, root, b.directory)
        setActiveTeam(LEAD, b.directory)

        const resolved = await resolveTeamMember(root, LEAD)
        expect(resolved?.teamName).toBe("bbb")
    })

    test("resolveCallerInTeam(inactive) → null by default; requireActive:false → master", async () => {
        const root = tmpRoot("multi-gate")
        const a = await initTeamState(root, makeState("aaa", LEAD, [], Date.now()), LEAD)
        const b = await initTeamState(root, makeState("bbb", LEAD), LEAD) // inactive
        indexMasterTeam(LEAD, "aaa", LEAD, root, a.directory)
        indexMasterTeam(LEAD, "bbb", LEAD, root, b.directory)
        setActiveTeam(LEAD, a.directory)

        // active team "aaa" → resolves
        expect(await resolveCallerInTeam(root, LEAD, "aaa")).not.toBeNull()
        // inactive team "bbb" → blocked (default requireActive)
        expect(await resolveCallerInTeam(root, LEAD, "bbb")).toBeNull()
        // inactive team "bbb" with requireActive:false → resolves (read-only path)
        const ro = await resolveCallerInTeam(root, LEAD, "bbb", { requireActive: false })
        expect(ro?.isMaster).toBe(true)
        expect(ro?.teamName).toBe("bbb")
    })

    test("unindexMasterTeam removes one team, keeps the other; clears active if matched", async () => {
        const root = tmpRoot("multi-unindex")
        const a = await initTeamState(root, makeState("aaa", LEAD, [], Date.now()), LEAD)
        const b = await initTeamState(root, makeState("bbb", LEAD), LEAD)
        indexMasterTeam(LEAD, "aaa", LEAD, root, a.directory)
        indexMasterTeam(LEAD, "bbb", LEAD, root, b.directory)
        setActiveTeam(LEAD, a.directory)

        unindexMasterTeam(LEAD, a.directory) // remove the active one

        const teams = resolveMasterTeams(LEAD)
        expect(teams.map(t => t.teamName)).toEqual(["bbb"])
        // active pointer cleared → bbb is NOT auto-activated
        expect(await resolveTeamMember(root, LEAD)).toBeNull()
    })

    test("unindexSession clears the whole master entry", async () => {
        const root = tmpRoot("multi-teardown")
        const a = await initTeamState(root, makeState("aaa", LEAD, [], Date.now()), LEAD)
        const b = await initTeamState(root, makeState("bbb", LEAD), LEAD)
        indexMasterTeam(LEAD, "aaa", LEAD, root, a.directory)
        indexMasterTeam(LEAD, "bbb", LEAD, root, b.directory)
        setActiveTeam(LEAD, a.directory)

        unindexSession(LEAD)
        expect(resolveMasterTeams(LEAD)).toEqual([])
    })
})

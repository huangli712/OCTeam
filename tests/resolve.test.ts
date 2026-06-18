import { afterEach, describe, expect, test } from "bun:test"

import { teamDir } from "../src/state/paths.js"
import { initTeamState } from "../src/state/store.js"
import {
    indexMaster,
    indexMember,
    resolveTeamMember,
    unindexSession,
} from "../src/utils.js"
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
        await initTeamState(root, makeState("aaa", LEAD, [makeMember("bob", MEMBER)]), LEAD)
        indexMaster(LEAD, "aaa", LEAD, root)

        const resolved = await resolveTeamMember(root, LEAD)
        expect(resolved).not.toBeNull()
        expect(resolved?.isMaster).toBe(true)
        expect(resolved?.leadSessionId).toBe(LEAD)
        expect(resolved?.directory).toBe(teamDir(root, "aaa", LEAD))
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

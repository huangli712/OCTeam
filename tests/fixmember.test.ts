import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { teamFixMemberTool } from "../src/tools/lifecycle/fixmember.js"
import { initTeamState, writeTeamSpec } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from './helpers.js';

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})
afterAll(cleanupTmpRoots)

describe("team_fix_member constraint (1)", () => {
    test("member session → rejected (master-only), even on an active team", async () => {
        const root = tmpRoot("fix-member-reject")
        const masterSid = "ses_master"
        const memberSid = "ses_alice"
        tracked.push(masterSid, memberSid)
        // active team with a member that has a real sessionId
        await initTeamState(
            root,
            makeState("alpha", masterSid, [makeMember("alice", memberSid)], Date.now()),
            masterSid,
        )
        await rebuildSessionIndex(root, `${root}__unused`)

        const result = await teamFixMemberTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", member_name: "alice", new_prompt: "new prompt" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("master-only")
    })

    test("master + inactive team → allowed (non-active teams may be modified)", async () => {
        const root = tmpRoot("fix-inactive")
        const masterSid = "ses_master2"
        tracked.push(masterSid)
        // inactive team (no activatedAt)
        await initTeamState(root, makeState("alpha", masterSid, [makeMember("alice")]), masterSid)
        await writeTeamSpec(root, { name: "alpha", version: 1 as const, createdAt: Date.now(), members: [{ name: "alice", role: "coder", prompt: "old" }] }, masterSid, root)
        await rebuildSessionIndex(root, `${root}__unused`)

        const result = await teamFixMemberTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", member_name: "alice", new_prompt: "updated prompt" },
            makeToolContext(masterSid),
        )
        expect(result).toContain("updated")
    })

    test("running member → rejected", async () => {
        const root = tmpRoot("fix-running")
        const masterSid = "ses_master3"
        tracked.push(masterSid)
        const alice = { ...makeMember("alice"), status: "running" as const }
        await initTeamState(root, makeState("alpha", masterSid, [alice]), masterSid)
        await rebuildSessionIndex(root, `${root}__unused`)

        const result = await teamFixMemberTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", member_name: "alice", new_prompt: "x" },
            makeToolContext(masterSid),
        )
        expect(result).toContain("running")
    })
})

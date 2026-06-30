import { afterEach, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import { teamFixMemberTool } from "../src/tools/fix.js"
import { initTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

function makeCtx(storageRoot: string): PluginContext {
    return { storageRoot, scope: "project" } as unknown as PluginContext
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

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

        const result = await teamFixMemberTool(makeCtx(root)).execute(
            { team_id: "alpha", member_name: "alice", new_prompt: "new prompt" },
            { sessionID: memberSid } as any,
        )
        expect(result).toContain("master-only")
    })

    test("master + inactive team → allowed (non-active teams may be modified)", async () => {
        const root = tmpRoot("fix-inactive")
        const masterSid = "ses_master2"
        tracked.push(masterSid)
        // inactive team (no activatedAt)
        await initTeamState(root, makeState("alpha", masterSid, [makeMember("alice")]), masterSid)
        await rebuildSessionIndex(root, `${root}__unused`)

        const result = await teamFixMemberTool(makeCtx(root)).execute(
            { team_id: "alpha", member_name: "alice", new_prompt: "updated prompt" },
            { sessionID: masterSid } as any,
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

        const result = await teamFixMemberTool(makeCtx(root)).execute(
            { team_id: "alpha", member_name: "alice", new_prompt: "x" },
            { sessionID: masterSid } as any,
        )
        expect(result).toContain("running")
    })
})

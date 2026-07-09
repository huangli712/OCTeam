/**
 * Regression test for confirmed finding "add-member-cap-race".
 *
 * Bug: src/tools/add.ts:43 checks team.members.length >= team.bounds.maxMembers
 * BEFORE acquiring team.mutex (line 97). The inside-mutex revalidation
 * (lines 102-105) only re-checks team.status, NOT the member count. Two
 * concurrent team_add_member calls can both read the same members.length
 * outside the mutex, both pass the cap check, and both push a member inside
 * the mutex — exceeding bounds.maxMembers.
 *
 * (A teammate's fix moved readTeamSpec inside the mutex to address a DIFFERENT
 * finding, stale-team-spec-overwrite. That fix does NOT close this race: the
 * maxMembers check at line 43 is still outside the lock, and the inside-lock
 * revalidation at lines 102-105 checks status only.)
 *
 * Fix: re-check team.members.length >= team.bounds.maxMembers INSIDE
 * team.mutex.runExclusive (alongside the existing status revalidation) and
 * refuse if the cap is reached.
 *
 * This test deterministically reproduces the race by pre-holding the mutex so
 * both adds read the same members.length before either enters the critical
 * section.
 */

import { afterEach, describe, expect, test } from "bun:test"

import type { ToolContext } from "@opencode-ai/plugin"
import type { TeamSpec } from "../src/core/types.js"
import { teamAddMemberTool } from "../src/tools/add.js"
import { initTeamState, loadTeamState, writeTeamSpec } from "../src/state/store.js"
import { unindexSession } from "../src/state/resolve.js"
import { makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"


const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("add-member cap race (finding: add-member-cap-race)", () => {
    test("two concurrent team_add_member calls must not exceed maxMembers", async () => {
        const root = tmpRoot("add-cap-race")
        const leadSid = "ses_add_cap_race"
        tracked.push(leadSid)

        // --- Live team with 2 members, maxMembers=3 (1 slot left). ---
        const alice = makeMember("alice")
        const bob = makeMember("bob")
        const state = makeState("alpha", leadSid, [alice, bob])
        state.bounds.maxMembers = 3
        await initTeamState(root, state, leadSid)
        const spec: TeamSpec = {
            version: 1,
            name: "alpha",
            createdAt: Date.now(),
            members: [
                { name: "alice", role: "coder", prompt: "code", agent: "oct-junior" },
                { name: "bob", role: "coder", prompt: "code", agent: "oct-junior" },
            ],
        }
        await writeTeamSpec(root, spec, leadSid)
        const team = await loadTeamState(root, "alpha", leadSid)

        // --- Pre-hold the mutex so both adds read members.length=2 BEFORE
        //     either enters the critical section. ---
        let releaseGate!: () => void
        const gate = new Promise<void>(r => { releaseGate = r })
        const mutexHold = team.mutex.runExclusive(async () => { await gate })

        // --- Fire two concurrent adds. Both:
        //   1. loadTeamState (cache hit)
        //   2. pass status==="live"
        //   3. pass members.length(2) >= maxMembers(3) → false (cap not reached)
        //   4. block on team.mutex.runExclusive ---
        const tool = teamAddMemberTool(makeCtx({ storageRoot: root }))
        const addCarol = tool.execute(
            { team_id: "alpha", name: "carol", role: "coder", prompt: "p", agent: "oct-junior" },
            { sessionID: leadSid } as unknown as ToolContext,
        )
        const addDave = tool.execute(
            { team_id: "alpha", name: "dave", role: "coder", prompt: "p", agent: "oct-junior" },
            { sessionID: leadSid } as unknown as ToolContext,
        )

        // Drain microtasks so both adds progress through loadTeamState, the
        // outside-mutex cap check (both see 2 < 3), and park on the mutex.
        await new Promise(r => setTimeout(r, 20))

        // --- Release: both critical sections serialize. On UNFIXED code,
        //     neither re-checks the cap inside the mutex → both push → 4
        //     members, exceeding maxMembers=3. ---
        releaseGate()
        await mutexHold
        const [resCarol, resDave] = await Promise.all([addCarol, addDave])

        // --- ASSERT: total members must NOT exceed maxMembers (3) ---
        // On UNFIXED code: both added → 4 members → FAIL.
        // On FIXED code: one rejected (cap reached inside mutex) → 3 → PASS.
        const finalTeam = await loadTeamState(root, "alpha", leadSid)
        expect(finalTeam.members.length).toBeLessThanOrEqual(3)
    })
})

/**
 * Regression test for confirmed finding "stale-team-spec-overwrite".
 *
 * Bug: src/tools/lifecycle/add.ts:49, remove.ts:46, and fix.ts:54 read config.json
 * (TeamSpec) BEFORE acquiring team.mutex, then write that stale spec snapshot
 * INSIDE the lock. The mutex serializes the critical sections, but each op
 * mutates its OWN stale spec copy — so the second writer's writeTeamSpec
 * clobbers the first writer's spec changes.
 *
 * Concrete scenario (two concurrent team_add_member calls on a live team):
 *   1. Op A reads spec → [alice]                 (outside mutex)
 *   2. Op B reads spec → [alice]                 (outside mutex, same snapshot)
 *   3. Op A enters mutex: pushes bob → spec_A=[alice,bob],
 *      writes config.json=[alice,bob], saves state.json
 *   4. Op B enters mutex: pushes carol → spec_B=[alice,carol]
 *      (STALE — doesn't know about bob!), writes config.json=[alice,carol]
 *
 * Final: config.json=[alice,carol] but state.json=[alice,bob,carol] (the
 * in-memory team.members singleton accumulates both correctly). config.json
 * is inconsistent with state.json — bob is silently lost from the spec.
 *
 * Fix: read config.json INSIDE team.mutex.runExclusive (re-read under the
 * lock) so the second op sees the first op's spec changes.
 *
 * NOTE: a teammate's status-revalidation fix (add.ts:110-113) addresses a
 * DIFFERENT finding (live-mutators-stale-state-check). It does NOT fix this:
 * both adds see status==="live" and proceed; the spec staleness is invisible
 * to a status check.
 *
 * This test deterministically reproduces the race by pre-holding the mutex so
 * both adds read their stale spec snapshots before either enters the lock.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import type { ToolContext } from "@opencode-ai/plugin"
import type { TeamSpec } from "../src/core/types.js"
import { teamAddMemberTool } from "../src/tools/lifecycle/add.js"
import { configPath, teamDir } from "../src/state/paths.js"
import { initTeamState, loadTeamState, writeTeamSpec } from "../src/state/store.js"
import { unindexSession } from "../src/state/resolve.js"
import { makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"


async function readSpecFromDisk(storageRoot: string, teamName: string, sid: string): Promise<TeamSpec> {
    const raw = await readFile(configPath(teamDir(storageRoot, teamName, sid)), "utf8")
    return JSON.parse(raw) as TeamSpec
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("stale team spec overwrite (finding: stale-team-spec-overwrite)", () => {
    test("two concurrent adds must not clobber each other's spec changes in config.json", async () => {
        const root = tmpRoot("spec-overwrite")
        const leadSid = "ses_spec_overwrite"
        tracked.push(leadSid)

        // --- Live team with alice + matching spec [alice] ---
        const alice = makeMember("alice")
        await initTeamState(root, makeState("alpha", leadSid, [alice]), leadSid)
        const spec: TeamSpec = {
            version: 1,
            name: "alpha",
            createdAt: Date.now(),
            members: [{ name: "alice", role: "coder", prompt: "code", agent: "oct-junior" }],
        }
        await writeTeamSpec(root, spec, leadSid)
        const team = await loadTeamState(root, "alpha", leadSid)

        // --- Pre-hold the mutex so both adds read their stale spec snapshots
        //     BEFORE either enters the critical section. ---
        let releaseGate!: () => void
        const gate = new Promise<void>(r => { releaseGate = r })
        const mutexHold = team.mutex.runExclusive(async () => { await gate })

        // --- Fire two concurrent adds. Both:
        //   1. loadTeamState (cache hit)
        //   2. pass status==="live" check
        //   3. readTeamSpec → [alice] (STALE snapshot, same for both)
        //   4. block on team.mutex.runExclusive ---
        const tool = teamAddMemberTool(makeCtx({ storageRoot: root }))
        const addBob = tool.execute(
            { team_id: "alpha", name: "bob", role: "coder", prompt: "p", agent: "oct-junior" },
            { sessionID: leadSid } as unknown as ToolContext,
        )
        const addCarol = tool.execute(
            { team_id: "alpha", name: "carol", role: "coder", prompt: "p", agent: "oct-junior" },
            { sessionID: leadSid } as unknown as ToolContext,
        )

        // Drain all microtasks so both adds progress through loadTeamState,
        // the outside-mutex status check, readTeamSpec (stale snapshot), and
        // park on team.mutex.runExclusive.
        await new Promise(r => setTimeout(r, 20))

        // --- Release: both critical sections serialize (A then B, or vice
        //     versa — order doesn't matter; the clobber is symmetric). ---
        releaseGate()
        await mutexHold
        const [resBob, resCarol] = await Promise.all([addBob, addCarol])

        // Both adds should report success (status stayed "live").
        expect(resBob).toContain("added")
        expect(resCarol).toContain("added")

        // --- ASSERT: config.json must contain ALL THREE members ---
        // (consistent with state.json / team.members)
        // On UNFIXED code: the second writer's stale spec snapshot
        // ([alice] + its own add) clobbers the first writer's member →
        // config.json has only 2 members, not 3 → FAILS.
        // On FIXED code (spec re-read inside mutex): the second writer sees
        // the first's changes → config.json has all 3 → PASSES.
        const finalSpec = await readSpecFromDisk(root, "alpha", leadSid)
        const specNames = finalSpec.members.map(m => m.name).sort()
        expect(specNames).toEqual(["alice", "bob", "carol"])

        // --- Cross-check: state.json (team.members singleton) IS correct ---
        // This proves the drift is config-only — the in-memory singleton
        // accumulates both adds, but config.json does not.
        const finalTeam = await loadTeamState(root, "alpha", leadSid)
        const stateNames = finalTeam.members.map(m => m.name).sort()
        expect(stateNames).toEqual(["alice", "bob", "carol"])
    })
})

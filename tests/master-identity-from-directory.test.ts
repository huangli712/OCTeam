/**
 * Regression test: master identity must come from the trusted
 * directory layout (project scope), NOT from the disk-persisted
 * state.leadSessionId field.
 *
 * Bug: src/state/resolve.ts indexScope() reads `team.leadSessionId` (from
 * state.json) and passes it to indexMasterTeam(). A member with .octeam/ FS
 * write access can rewrite state.json to set leadSessionId to its OWN
 * session ID, then on plugin restart rebuildSessionIndex() grants that
 * session master privilege over the team.
 *
 * For project scope, the directory layout itself encodes the authoritative
 * owner: <storageRoot>/<leadSessionId>/teams/<teamName>. The directory
 * segment is enumerated by listAllTeams and is what indexScope receives as
 * the `leadSessionId` parameter. The fix uses THIS value (directory-derived)
 * instead of the disk value.
 *
 * For user scope (flat layout), the disk value is the only source — this
 * test does NOT cover that case (accepted limitation documented in the fix).
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"

import { initTeamState, loadTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, resolveCallerInTeam, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeMember, makeState, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("master session comes from directory layout, not disk leadSessionId (project scope)", () => {
    test("tampered state.leadSessionId does NOT gain master privilege", async () => {
        const root = tmpRoot("c3-master-tamper")
        const legitimateSid = "legit-leader-sid"
        const attackerSid = "attacker-session-id"

        // 1. Create a team at the legitimate leader's project-scope path.
        const state = makeState("alpha", legitimateSid, [
            makeMember("alice", "alice-ses"),
        ], Date.now())
        await initTeamState(root, state, legitimateSid)

        // 2. Tamper: rewrite state.json to claim the attacker's session owns it.
        //    On unfixed code this is enough to grant attackerSid master privilege.
        const team = await loadTeamState(root, "alpha", legitimateSid)
        await team.mutex.runExclusive(async () => {
            team.leadSessionId = attackerSid
            // Persist by writing state.json directly (simulating FS tampering
            // — a member with write access to .octeam/ rewrites the file).
            const statePath = path.join(root, legitimateSid, "teams", "alpha", "state.json")
            const tampered = JSON.stringify({ ...team, leadSessionId: attackerSid }, null, 2)
            writeFileSync(statePath, tampered)
        })

        // 3. Drop the in-memory registry so the next load sees the tampered disk.
        //    (rebuildSessionIndex re-reads from disk via loadTeamState.)
        //    Easiest path: just call rebuildSessionIndex on a fresh process-like state.
        tracked.push(legitimateSid, attackerSid)
        await rebuildSessionIndex(root, `${root}__unused`)

        // 4. The attacker should NOT resolve as the team's master.
        const attackerResolved = await resolveCallerInTeam(root, attackerSid, "alpha", { requireActive: false })
        expect(attackerResolved).toBeNull()

        // 5. The legitimate leader SHOULD still resolve (directory-derived).
        //    On unfixed code, the attacker overwrote the disk value, so the
        //    legitimate session is no longer indexed.
        const legitResolved = await resolveCallerInTeam(root, legitimateSid, "alpha", { requireActive: false })
        expect(legitResolved).not.toBeNull()
        expect(legitResolved?.isMaster).toBe(true)
        expect(legitResolved?.teamName).toBe("alpha")
    })

    test("control: legitimate rebuild (no tampering) still works", async () => {
        const root = tmpRoot("c3-master-clean")
        const sid = "normal-leader-sid"
        const state = makeState("beta", sid, [makeMember("bob", "bob-ses")], Date.now())
        await initTeamState(root, state, sid)

        tracked.push(sid)
        await rebuildSessionIndex(root, `${root}__unused`)

        const resolved = await resolveCallerInTeam(root, sid, "beta", { requireActive: false })
        expect(resolved).not.toBeNull()
        expect(resolved?.isMaster).toBe(true)
        expect(resolved?.teamName).toBe("beta")
    })
})

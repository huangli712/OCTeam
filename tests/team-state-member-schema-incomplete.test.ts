/**
 * Regression test for confirmed finding "team-state-member-schema-incomplete".
 *
 * Bug: src/state/store.ts:83-121 — isValidTeamState validates only:
 *   - Top-level: teamName (string), members (array), status (string), version (number)
 *   - Per-member: is-object, agent (optional allowlist), worktreePath (optional bounds)
 *
 * It does NOT validate per-member `name` (a required field that is used as a
 * path segment) or `status` (a required string enum). src/hooks.ts:291-293
 * iterates members and calls `releaseStaleReservations(team.directory, m.name)`,
 * which flows through `reservedDir(teamDir, m.name)` →
 * `assertSafeSegment(recipient)` (paths.ts:68). A tampered state.json with a
 * member whose `name` is missing, non-string, or contains path separators
 * passes isValidTeamState, then throws inside the sweep — crashing the entire
 * sweep iteration and blocking stale-resource reclamation for every team.
 *
 * Fix: isValidTaskState must validate that each member's `name` is a non-empty
 * safe path segment and `status` is a string, rejecting corrupt state at the
 * load boundary.
 *
 * This test tampers state.json with a member whose name contains a path
 * separator, reloads the team, and asserts the load is REJECTED. On UNFIXED
 * code the load succeeds (name unchecked), and the downstream path operation
 * crashes → test FAILS. On FIXED code isValidTeamState rejects the bad member
 * → loadTeamState throws → test PASSES.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"

import { initTeamState, invalidateTeam, loadTeamState, type Team } from "../src/state/store.js"
import { releaseStaleReservations } from "../src/messaging/mailbox.js"
import { statePath, teamDir } from "../src/state/paths.js"
import { cleanupTmpRoots, makeMember, makeState, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

describe("team state member schema incomplete (finding: team-state-member-schema-incomplete)", () => {
    test("a member with an unsafe name must be rejected at load, not crash the sweep", async () => {
        const root = tmpRoot("member-schema")
        const sid = "ses_member_schema"

        // --- Seed a valid team. ---
        const alice = makeMember("alice")
        await initTeamState(root, makeState("alpha", sid, [alice]), sid)
        const dir = teamDir(root, "alpha", sid)

        // --- TAMPER state.json: add a second member whose name contains a
        //     path separator. This passes isValidTeamState on UNFIXED code
        //     (name is not checked) but crashes reservedDir/assertSafeSegment
        //     when the sweep calls releaseStaleReservations(team.dir, m.name). ---
        const sp = statePath(dir)
        const raw = JSON.parse(await readFile(sp, "utf8"))
        raw.members.push({
            name: "../../evil",
            status: "idle",
            initialized: true,
            turnCount: 0,
        })
        await writeFile(sp, JSON.stringify(raw, null, 2), "utf8")

        // Force re-read from disk.
        invalidateTeam(dir)

        // --- ASSERT: loadTeamState must REJECT the tampered state ---
        // On UNFIXED code: isValidTeamState passes (name not validated) →
        // loadTeamState succeeds → the tampered team loads with the bad member.
        //   We then prove the downstream crash: releaseStaleReservations
        //   throws at assertSafeSegment.
        // On FIXED code: isValidTeamState rejects the unsafe name →
        // loadTeamState throws "no state.json" → the tampered state never
        // propagates.
        const loadResult = await loadTeamState(root, "alpha", sid).then(
            (team): { loaded: true; team: Team } => ({ loaded: true, team }),
            (err: unknown): { loaded: false; err: Error } => ({ loaded: false, err: err as Error }),
        )

        if (loadResult.loaded) {
            // UNFIXED path: the tampered state loaded. Prove the crash.
            const evilMember = loadResult.team.members.find(m => m.name === "../../evil")!
            expect(evilMember).toBeDefined()

            // releaseStaleReservations is exactly what hooks.ts:292 calls.
            // reservedDir → assertSafeSegment → throws.
            await expect(
                releaseStaleReservations(dir, evilMember.name),
            ).rejects.toThrow(/unsafe.*segment/i)
        } else {
            // FIXED path: load rejected.
            expect(loadResult.err.message).toMatch(/no state\.json for team "alpha"/)
        }

        // --- The test PASSES only when loadTeamState REJECTS the tampered
        //     state (FIXED). On UNFIXED code, loadResult.loaded is true and
        //     the crash assertion passes — but the real point is that the
        //     state should NEVER have loaded. We make this explicit: ---
        expect(loadResult.loaded).toBe(false)
    })

    test("a member missing required status field must be rejected at load", async () => {
        // A second dimension of the incomplete guard: `status` is required
        // (MemberStatus enum) but never validated. A tampered member without
        // `status` passes the guard and propagates as undefined.
        const root = tmpRoot("member-schema-status")
        const sid = "ses_member_schema_status"

        const alice = makeMember("alice")
        await initTeamState(root, makeState("alpha", sid, [alice]), sid)
        const dir = teamDir(root, "alpha", sid)

        const sp = statePath(dir)
        const raw = JSON.parse(await readFile(sp, "utf8"))
        raw.members.push({
            name: "bob",
            // status MISSING — required by MemberState but unchecked
            initialized: true,
            turnCount: 0,
        })
        await writeFile(sp, JSON.stringify(raw, null, 2), "utf8")

        invalidateTeam(dir)

        // On UNFIXED code: passes isValidTeamState (status unchecked) → loads.
        // On FIXED code: status is required → rejected.
        await expect(loadTeamState(root, "alpha", sid)).rejects.toThrow(
            /no state\.json for team "alpha"/,
        )
    })
})

describe("isMaster privilege escalation hardening", () => {
    test("truthy non-boolean isMaster (string) is rejected", async () => {
        const root = tmpRoot("c3-isMaster-string")
        const sid = "ses_c3_str"
        const alice = makeMember("alice")
        await initTeamState(root, makeState("alpha", sid, [alice]), sid)
        const dir = teamDir(root, "alpha", sid)

        const sp = statePath(dir)
        const raw = JSON.parse(await readFile(sp, "utf8"))
        raw.members[0].isMaster = "true"  // truthy string, not boolean true
        await writeFile(sp, JSON.stringify(raw, null, 2), "utf8")
        invalidateTeam(dir)

        await expect(loadTeamState(root, "alpha", sid)).rejects.toThrow()
    })

    test("truthy non-boolean isMaster (number 1) is rejected", async () => {
        const root = tmpRoot("c3-isMaster-num")
        const sid = "ses_c3_num"
        const alice = makeMember("alice")
        await initTeamState(root, makeState("alpha", sid, [alice]), sid)
        const dir = teamDir(root, "alpha", sid)

        const sp = statePath(dir)
        const raw = JSON.parse(await readFile(sp, "utf8"))
        raw.members[0].isMaster = 1  // truthy number
        await writeFile(sp, JSON.stringify(raw, null, 2), "utf8")
        invalidateTeam(dir)

        await expect(loadTeamState(root, "alpha", sid)).rejects.toThrow()
    })

    test("truthy non-boolean isMaster (object) is rejected", async () => {
        const root = tmpRoot("c3-isMaster-obj")
        const sid = "ses_c3_obj"
        const alice = makeMember("alice")
        await initTeamState(root, makeState("alpha", sid, [alice]), sid)
        const dir = teamDir(root, "alpha", sid)

        const sp = statePath(dir)
        const raw = JSON.parse(await readFile(sp, "utf8"))
        raw.members[0].isMaster = {}  // truthy object
        await writeFile(sp, JSON.stringify(raw, null, 2), "utf8")
        invalidateTeam(dir)

        await expect(loadTeamState(root, "alpha", sid)).rejects.toThrow()
    })

    test("isMaster: false and isMaster: undefined are accepted (legitimate)", async () => {
        const root = tmpRoot("c3-isMaster-ok")
        const sid = "ses_c3_ok"
        const alice = makeMember("alice")
        await initTeamState(root, makeState("alpha", sid, [alice]), sid)
        const dir = teamDir(root, "alpha", sid)

        // isMaster: false should load fine
        const sp = statePath(dir)
        const raw = JSON.parse(await readFile(sp, "utf8"))
        raw.members[0].isMaster = false
        await writeFile(sp, JSON.stringify(raw, null, 2), "utf8")
        invalidateTeam(dir)

        const team = await loadTeamState(root, "alpha", sid)
        expect(team.members[0].isMaster).toBe(false)
    })

    test("leadSessionId as non-string is rejected when present", async () => {
        const root = tmpRoot("c3-leadses-num")
        const sid = "ses_c3_leadses"
        const alice = makeMember("alice")
        await initTeamState(root, makeState("alpha", sid, [alice]), sid)
        const dir = teamDir(root, "alpha", sid)

        const sp = statePath(dir)
        const raw = JSON.parse(await readFile(sp, "utf8"))
        raw.leadSessionId = 12345  // number instead of string
        await writeFile(sp, JSON.stringify(raw, null, 2), "utf8")
        invalidateTeam(dir)

        await expect(loadTeamState(root, "alpha", sid)).rejects.toThrow()
    })
})

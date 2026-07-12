/**
 * Regression test for confirmed finding
 * "persisted-worktreepath-session-escape".
 *
 * Threat model: member.worktreePath is persisted in state.json and, on reload,
 * is passed VERBATIM as the child session's `directory` at spawn time
 * (src/orchestration/runtime/dispatch.ts:130: `member.worktreePath ?? ctx.directory`)
 * and on every subsequent dispatch (dispatch.ts:232). The state-loader's only
 * schema gate is isValidTeamState (src/state/store.ts:80), which checks the
 * top-level identity fields and the per-member `agent` allowlist — it NEVER
 * inspects `worktreePath`. So a tampered state.json that wrote an arbitrary
 * absolute path (e.g. "/tmp/evil", "/etc", or a traversal like "../../x")
 * into a member's worktreePath would be loaded without complaint and the
 * spawned member session would run OUTSIDE the team/project worktree — a
 * breakout across the .octeam/ trust boundary.
 *
 * Fix: the loader must reject any persisted worktreePath that does not resolve
 * strictly inside the team's own worktrees/ directory.
 *
 * This test tampers state.json on disk, evicts the in-memory registry entry so
 * the next load re-reads disk, and asserts the tampered state is rejected. On
 * the UNFIXED code the load succeeds and the escaped path is observable on the
 * reloaded member, so this test FAILLES; once the validator is hardened the
 * load throws and the test PASSES.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"

import { statePath, teamDir, worktreesDir } from "../src/state/paths.js"
import { initTeamState, invalidateTeam, loadTeamState } from "../src/state/store.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

afterAll(() => {
    // helpers.cleanupTmpRoots is process-global; import it directly to avoid
    // coupling this suite to a shared afterEach in another file.
    // (Each tmpRoot below is tracked by helpers' internal list.)
})

describe("persisted worktreePath session-escape (finding: persisted-worktreepath-session-escape)", () => {
    test("state.json with an absolute worktreePath OUTSIDE the team dir is rejected on reload", async () => {
        const root = tmpRoot("wt-escape-abs")
        const sid = "ses_wt_escape_abs"
        const member = makeMember("alice")
        // Seed a valid state on disk + register the in-memory team.
        await initTeamState(root, makeState("alpha", sid, [member]), sid)
        const dir = teamDir(root, "alpha", sid)

        // --- TAMPER: flip alice's worktreePath to an absolute path that is
        //     clearly outside both the team dir and the storage root. This is
        //     exactly the shape a malicious/edited state.json would take. ---
        const sp = statePath(dir)
        const raw = JSON.parse(await readFile(sp, "utf8"))
        raw.members[0].worktreePath = "/tmp/octeam-escape-target"
        await writeFile(sp, JSON.stringify(raw))

        // Force the next load to re-read disk (the registry caches the prior
        // good in-memory copy otherwise — see store.ts loadTeamState).
        invalidateTeam(dir)

        // On the FIXED code the loader must reject this tampered state, which
        // surfaces as the standard "no state.json" load error. On the UNFIXED
        // code the load succeeds and hands back the escaped path.
        expect(loadTeamState(root, "alpha", sid)).rejects.toThrow(
            /no state\.json for team "alpha"/,
        )
    })

    test("state.json with a traversal worktreePath is rejected on reload", async () => {
        const root = tmpRoot("wt-escape-trav")
        const sid = "ses_wt_escape_trav"
        const member = makeMember("bob")
        await initTeamState(root, makeState("beta", sid, [member]), sid)
        const dir = teamDir(root, "beta", sid)

        const sp = statePath(dir)
        const raw = JSON.parse(await readFile(sp, "utf8"))
        // A relative traversal that escapes the team dir when resolved.
        raw.members[0].worktreePath = "../../escaped"
        await writeFile(sp, JSON.stringify(raw))

        invalidateTeam(dir)

        expect(loadTeamState(root, "beta", sid)).rejects.toThrow(
            /no state\.json for team "beta"/,
        )
    })

    test("control: a worktreePath INSIDE the team worktrees/ dir is accepted", async () => {
        // Proves the rejection above targets the ESCAPE, not worktreePath per
        // se — a legitimately placed worktree path must continue to load.
        const root = tmpRoot("wt-escape-ok")
        const sid = "ses_wt_escape_ok"
        const member = makeMember("carol")
        await initTeamState(root, makeState("gamma", sid, [member]), sid)
        const dir = teamDir(root, "gamma", sid)

        const sp = statePath(dir)
        const raw = JSON.parse(await readFile(sp, "utf8"))
        raw.members[0].worktreePath = `${worktreesDir(dir)}/carol`
        await writeFile(sp, JSON.stringify(raw))

        invalidateTeam(dir)

        const team = await loadTeamState(root, "gamma", sid)
        expect(team.members[0].worktreePath).toBe(`${worktreesDir(dir)}/carol`)
    })
})

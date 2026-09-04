/**
 * Regression: worktreePath in state.json is passed VERBATIM as the child
 * session's directory at spawn/dispatch time. isValidTeamState previously
 * did only a lexical path.resolve containment check, which cannot detect a
 * worktreePath that resolves inside worktrees/ lexically but is a symlink
 * pointing OUTSIDE the team root. The fix uses realpathSync to resolve the
 * symlink and re-checks containment.
 *
 * Note: saveTeamState's atomicWrite now also passes team.directory as
 * trustedRoot (defense-in-depth for state.json redirection via an intermediate
 * ancestor inside the team dir), but that vector is already covered by the
 * leaf-only refuseSymlink check on state.json itself. The realistic attack
 * vector here is worktreePath symlink escape, which the realpathSync check
 * closes.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { loadTeamState, initTeamState, invalidateTeam } from "../src/state/store.js"
import { statePath, teamDir, worktreesDir } from "../src/state/paths.js"
import { cleanupTmpRoots, makeMember, makeState, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

describe("worktreePath symlink hardening", () => {
    test("state.json with worktreePath that is a symlink to outside is rejected", async () => {
        const root = tmpRoot("c3-wt-symlink")
        const sid = "ses_c3_wt_symlink"
        const member = makeMember("alice")
        await initTeamState(root, makeState("alpha", sid, [member]), sid)
        const dir = teamDir(root, "alpha", sid)
        const outside = tmpRoot("c3-wt-symlink-outside")
        mkdirSync(outside, { recursive: true })

        // The worktree path resolves lexically INSIDE worktreesDir(dir), but
        // is a symlink pointing OUTSIDE. realpathSync must catch this.
        const wtName = "alice-wt"
        const wtInside = path.join(worktreesDir(dir), wtName)
        mkdirSync(path.dirname(wtInside), { recursive: true })
        symlinkSync(outside, wtInside)

        // Tamper state.json: write a worktreePath that lexically is inside
        // worktrees/, but is in fact a symlink.
        const sp = statePath(dir)
        const raw = JSON.parse(await readFile(sp, "utf8"))
        raw.members[0].worktreePath = wtInside
        await writeFile(sp, JSON.stringify(raw))
        invalidateTeam(dir)

        await expect(loadTeamState(root, "alpha", sid)).rejects.toThrow()
    })

    test("control: real directory worktreePath inside worktrees/ is accepted", async () => {
        const root = tmpRoot("c3-wt-clean")
        const sid = "ses_c3_wt_clean"
        const member = makeMember("alice")
        await initTeamState(root, makeState("alpha", sid, [member]), sid)
        const dir = teamDir(root, "alpha", sid)

        // Create a real worktree dir inside worktrees/.
        const wtInside = path.join(worktreesDir(dir), "alice-real")
        mkdirSync(wtInside, { recursive: true })

        const sp = statePath(dir)
        const raw = JSON.parse(await readFile(sp, "utf8"))
        raw.members[0].worktreePath = wtInside
        await writeFile(sp, JSON.stringify(raw))
        invalidateTeam(dir)

        const team = await loadTeamState(root, "alpha", sid)
        expect(team.members[0].worktreePath).toBe(wtInside)
    })

    test("control: worktreePath that does not exist yet is accepted (lexical check fallback)", async () => {
        // A worktree path that has not been created yet (worktree spawn happens
        // lazily on first dispatch) must NOT be rejected just because
        // realpathSync fails with ENOENT. The lexical check still gates it.
        const root = tmpRoot("c3-wt-pending")
        const sid = "ses_c3_wt_pending"
        const member = makeMember("alice")
        await initTeamState(root, makeState("alpha", sid, [member]), sid)
        const dir = teamDir(root, "alpha", sid)

        const wtInside = path.join(worktreesDir(dir), "alice-pending")

        const sp = statePath(dir)
        const raw = JSON.parse(await readFile(sp, "utf8"))
        raw.members[0].worktreePath = wtInside
        await writeFile(sp, JSON.stringify(raw))
        invalidateTeam(dir)

        const team = await loadTeamState(root, "alpha", sid)
        expect(team.members[0].worktreePath).toBe(wtInside)
    })
})

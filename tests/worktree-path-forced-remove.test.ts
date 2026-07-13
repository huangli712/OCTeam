/**
 * Regression test for confirmed finding "persisted-worktreepath-forced-remove".
 *
 * Bug: src/tools/lifecycle/delete.ts:81 calls cleanWorktree(ctx.directory,
 * m.worktreePath) with the member's worktreePath verbatim.
 * src/state/worktrees.ts:24 then runs `git worktree remove <path> --force`
 * WITHOUT checking that <path> is under the team's own worktrees/ directory.
 * A worktreePath pointing at ANY registered git worktree of the project repo
 * is force-removed — destroying an unrelated worktree the user relies on.
 *
 * NOTE on layering: a load-time validator (store.ts isValidTeamState) now
 * rejects out-of-bounds worktreePaths read from disk — that is the fix for the
 * SEPARATE "session-escape" finding. This finding targets a DIFFERENT layer:
 * cleanWorktree/delete.ts must validate INDEPENDENTLY (defense in depth, and
 * cleanWorktree is a reusable helper callable from other sites). The load
 * validator does not absolve cleanWorktree of its own bounds check.
 *
 * To exercise the unguarded cleanWorktree path past the now-present load
 * validator, this test sets the bad worktreePath on the CACHED in-memory Team
 * member (the object loadTeamState returns by reference, WITHOUT re-running
 * isValidTeamState on cache hits). This faithfully reaches delete.ts:81 →
 * cleanWorktree with an out-of-bounds path, which is exactly what the finding
 * describes. A load-only fix does NOT make this test pass; cleanWorktree (or
 * its caller delete.ts) must add its own bounds check.
 *
 * This test creates a real git repo with a registered "victim" worktree
 * OUTSIDE the team storage, sets a member's in-memory worktreePath at it,
 * calls team_delete --force, and asserts the victim SURVIVES. On UNFIXED
 * cleanWorktree the victim is force-removed (dir gone + registration dropped)
 * → test FAILS; once cleanWorktree/delete.ts validates bounds, the path is
 * refused → victim intact → test PASSES.
 */

import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { promisify } from "node:util"

import type { ToolContext } from "@opencode-ai/plugin"
import { teamDeleteTool } from "../src/tools/lifecycle/delete.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"

const execFileP = promisify(execFile)


async function initGitRepo(dir: string): Promise<void> {
    await execFileP("git", ["init", "-q"], { cwd: dir })
    await execFileP("git", ["config", "user.email", "test@test.test"], { cwd: dir })
    await execFileP("git", ["config", "user.name", "test"], { cwd: dir })
    await execFileP("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir })
}

/** True if `path` is a registered worktree of the repo at projectDir. */
async function isRegisteredWorktree(projectDir: string, path: string): Promise<boolean> {
    const { stdout } = await execFileP("git", ["worktree", "list", "--porcelain"], { cwd: projectDir })
    return stdout.split("\n").some(line => line.startsWith("worktree ") && line.slice("worktree ".length) === path)
}

describe("persisted worktreePath forced-remove (finding: persisted-worktreepath-forced-remove)", () => {
    test("team_delete --force must NOT remove a worktree outside the team worktrees/ dir", async () => {
        const projectDir = tmpRoot("wt-frm-proj")
        const storageRoot = tmpRoot("wt-frm-store")
        const victimRoot = tmpRoot("wt-frm-victim")
        const leadSid = "ses_wt_frm_lead"

        await initGitRepo(projectDir)

        // --- Create a registered "victim" worktree of projectDir, clearly
        //     OUTSIDE the team's storage root. This stands in for any
        //     unrelated user/project worktree. ---
        const victimPath = `${victimRoot}/victim`
        await execFileP("git", ["worktree", "add", victimPath, "-b", "victim-branch"], { cwd: projectDir })
        expect(await isRegisteredWorktree(projectDir, victimPath)).toBe(true)

        // --- Live team with a CLEAN member (no worktreePath) so initTeamState
        //     passes the load validator. ---
        const alice = makeMember("alice")
        await initTeamState(storageRoot, makeState("alpha", leadSid, [alice]), leadSid)

        // --- Set the bad worktreePath on the CACHED in-memory member. This is
        //     the object team_delete's loadTeamState returns by reference
        //     (cache hit → no re-validation), so cleanWorktree at delete.ts:81
        //     receives victimPath. This bypasses the load validator (which
        //     guards disk reads only) and directly exercises the unguarded
        //     cleanWorktree path that THIS finding targets. ---
        const team = await loadTeamState(storageRoot, "alpha", leadSid)
        team.members[0].worktreePath = victimPath

        // Sanity: the victim is NOT under the team's worktrees/ dir.
        expect(victimPath).not.toContain(`${team.directory}/worktrees/`)

        // --- Drive team_delete --force ---
        const tool = teamDeleteTool(makeCtx({ storageRoot, directory: projectDir }))
        const result = await tool.execute(
            { team_id: "alpha", force: true },
            { sessionID: leadSid } as unknown as ToolContext,
        )
        expect(result).toContain("deleted")

        // --- ASSERT 1: the victim worktree DIRECTORY must SURVIVE ---
        // On UNFIXED cleanWorktree: `git worktree remove victimPath --force`
        // ran → directory gone → access rejects (ENOENT) → test fails.
        // On FIXED cleanWorktree/delete.ts: out-of-bounds path refused →
        // victim intact → access resolves → test passes.
        // (bun resolves fs.access to null, so just await — a rejection fails.)
        await access(victimPath)

        // --- ASSERT 2: the victim must still be a REGISTERED worktree ---
        // On UNFIXED: `git worktree remove` drops the registration → false → FAILS.
        // On FIXED: registration untouched → true → PASSES.
        expect(await isRegisteredWorktree(projectDir, victimPath)).toBe(true)
    })
})

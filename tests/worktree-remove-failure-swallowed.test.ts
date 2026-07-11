/**
 * Regression test for confirmed finding "worktree-remove-failure-swallowed".
 *
 * Bug: src/state/worktrees.ts:42 — cleanWorktree does
 *   await execFileP("git", ["worktree", "remove", worktreePath, "--force"], { cwd: projectDir })
 *       .catch(() => { /* best effort *\/ })
 * swallowing ALL git worktree-remove failures. Whether git succeeds or fails,
 * cleanWorktree resolves with void and never throws.
 *
 * src/tools/delete.ts:82-83 then proceeds unconditionally: the delete loop
 * continues to the next member, unindexes, calls deleteTeamStorage, and
 * returns "Team ... deleted (forced)." at :94. The caller has NO indication
 * that the worktree registration + files remain in the project repo.
 *
 * Harm: a corrupted or busy worktree (locked files, broken .git admin file,
 * permissions, concurrent git process) silently survives team deletion. The
 * stale worktree registration persists in the project's git metadata, and
 * the worktree directory's files remain on disk. Subsequent `git worktree`
 * operations see orphaned entries; the orphaned files pollute the repo.
 *
 * Fix: cleanWorktree must propagate non-zero git failures (or at minimum
 * return a result the caller can check), so team_delete can surface the
 * failure instead of reporting success.
 *
 * This test reproduces the bug deterministically with NO mocking: it creates
 * a real git repo + worktree, then corrupts the worktree's .git admin file
 * so `git worktree remove --force` genuinely fails (exit 128). It then calls
 * cleanWorktree and asserts the failure must surface (not be swallowed).
 *   UNFIXED: .catch(()=>{}) swallows the git failure → cleanWorktree
 *            resolves normally → rejects assertion FAILS.
 *   FIXED:   git failure propagates → cleanWorktree rejects → PASSES.
 */

import { execFile } from "node:child_process"
import { rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterAll, describe, expect, test } from "bun:test"

import { cleanWorktree } from "../src/state/worktrees.js"
import { teamDir, worktreesDir } from "../src/state/paths.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

const execFileP = promisify(execFile)

async function gitInit(dir: string): Promise<void> {
    await execFileP("git", ["init", "-q"], { cwd: dir })
    await execFileP("git", ["config", "user.email", "t@t.com"], { cwd: dir })
    await execFileP("git", ["config", "user.name", "t"], { cwd: dir })
    await writeFile(join(dir, "README.md"), "init\n")
    await execFileP("git", ["add", "."], { cwd: dir })
    await execFileP("git", ["commit", "-q", "-m", "init"], { cwd: dir })
}

const createdDirs: string[] = []

afterAll(() => {
    for (const d of createdDirs.splice(0)) {
        // Best-effort cleanup of test git repos (may have locked files).
        rm(d, { recursive: true, force: true }).catch(() => {})
    }
    cleanupTmpRoots()
})

describe("cleanWorktree git failure swallowed (finding: worktree-remove-failure-swallowed)", () => {
    test("git worktree remove failure must surface, not be swallowed", async () => {
        // --- Fixture: real git repo + a registered worktree under the
        //     team's worktrees/ directory (matches production placement). ---
        const repoDir = tmpRoot("wt-swallow-repo")
        createdDirs.push(repoDir)
        await gitInit(repoDir)

        // The team's worktrees/ dir is where production createWorktree
        // places member worktrees. teamDir/worktreesDir are the real path
        // helpers so the bounds check in cleanWorktree (:36) passes.
        const storageRoot = tmpRoot("wt-swallow-store")
        const sid = "ses_wt_swallow"
        const tdir = teamDir(storageRoot, "alpha", sid)
        const wtRoot = worktreesDir(tdir)
        await mkdir(wtRoot, { recursive: true })
        const wtPath = join(wtRoot, "alice")

        await execFileP(
            "git",
            ["worktree", "add", "-q", wtPath, "-b", "team/alice"],
            { cwd: repoDir },
        )

        // Verify the worktree is registered + files exist.
        const listBefore = await execFileP("git", ["worktree", "list"], { cwd: repoDir })
        expect(listBefore.stdout).toContain(wtPath)
        await writeFile(join(wtPath, "marker.txt"), "worktree file\n")

        // --- Corrupt the worktree so `git worktree remove --force` genuinely
        //     fails. Removing the .git admin file inside the worktree causes
        //     git to refuse removal with exit 128:
        //       "fatal: validation failed ... '.git' does not exist"
        //     This is a realistic failure (corrupted/incomplete worktree,
        //     locked admin files, permissions) — no mocking required. ---
        await rm(join(wtPath, ".git"), { force: true })

        // Sanity: confirm git worktree remove now fails (proves the fixture
        // reproduces a genuine git failure, not a setup error).
        const gitRemoveResult = await execFileP(
            "git",
            ["worktree", "remove", wtPath, "--force"],
            { cwd: repoDir },
        ).then(
            () => "unexpected-success",
            (err: unknown) => (err as { code?: number }).code ?? "failed",
        )
        expect(gitRemoveResult).not.toBe("unexpected-success")

        // Re-add the worktree (the failed remove above may have left it
        // prunable). Re-create a fresh worktree to restore the pre-clean
        // state, then corrupt it again for the cleanWorktree call.
        await execFileP("git", ["worktree", "prune"], { cwd: repoDir }).catch(() => {})
        await execFileP(
            "git",
            ["worktree", "add", "-q", wtPath, "-b", "team/alice-2"],
            { cwd: repoDir },
        ).catch(() => {})
        await rm(join(wtPath, ".git"), { force: true })

        // --- Call cleanWorktree (the function under test). ---
        // UNFIXED: .catch(()=>{}) at worktrees.ts:42 swallows the git exit-128
        //          → cleanWorktree resolves with void → rejects FAILS.
        // FIXED:   git failure propagates → cleanWorktree rejects → PASSES.
        expect(
            cleanWorktree(repoDir, wtPath, wtRoot),
        ).rejects.toThrow()

        // Clean up the repo's worktree metadata so afterAll rm succeeds.
        await execFileP("git", ["worktree", "prune"], { cwd: repoDir }).catch(() => {})
    })
})

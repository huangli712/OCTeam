/**
 * Regression test: destroyWorktree must NOT delete the
 * `team/<team>/<member>` branch when the member never had a worktree
 * registered (worktreePath is undefined).
 *
 * Bug: src/state/worktrees.ts destroyWorktree() unconditionally executes
 * `git branch -D team/<team>/<member>` after the (early-returning on
 * undefined path) cleanWorktree call. If the user happens to have an
 * unmerged branch with the same name — e.g. a feature branch they named
 * `team/<teamName>/<memberName>` for unrelated reasons, or a leftover
 * from a manual git workflow — destroyWorktree silently destroys it.
 *
 * Fix: when worktreePath is undefined, destroyWorktree must skip the branch
 * deletion too. The branch deletion only makes sense as the symmetric
 * counterpart to createWorktree, which is the ONLY call site that registers
 * a worktree path. No registered worktree → no companion branch owned by
 * OCTeam → no deletion.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir } from "node:fs/promises"
import path from "node:path"

import { destroyWorktree } from "../src/state/worktrees.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

const execFileP = promisify(execFile)

afterAll(cleanupTmpRoots)

/** Initialize a git repo at `dir` and create an unmerged branch `team/<team>/<member>` in it. */
async function setupRepoWithUnmergedBranch(dir: string, team: string, member: string): Promise<void> {
    await execFileP("git", ["init", "--initial-branch=main"], { cwd: dir })
    await execFileP("git", ["config", "user.email", "test@example.com"], { cwd: dir })
    await execFileP("git", ["config", "user.name", "Test"], { cwd: dir })
    await execFileP("git", ["config", "commit.gpgsign", "false"], { cwd: dir })
    // Initial commit on main so the repo is non-empty.
    await execFileP("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir })
    // Create the unmerged branch.
    await execFileP("git", ["branch", `team/${team}/${member}`], { cwd: dir })
}

async function branchExists(dir: string, branch: string): Promise<boolean> {
    try {
        const { stdout } = await execFileP("git", ["branch", "--list", branch], { cwd: dir })
        return stdout.trim().length > 0
    } catch {
        return false
    }
}

describe("destroyWorktree refuses branch deletion when worktreePath is undefined", () => {
    test("does NOT delete an existing unmerged branch when worktreePath is undefined", async () => {
        const projectDir = tmpRoot("c10-no-worktree")
        const worktreesRoot = path.join(projectDir, ".octeam", "worktrees")
        await mkdir(worktreesRoot, { recursive: true })
        const teamName = "myteam"
        const memberName = "alice"

        // Project repo has an unmerged branch with the same name OCTeam would use.
        // This branch is NOT owned by OCTeam — no worktree was ever registered.
        await setupRepoWithUnmergedBranch(projectDir, teamName, memberName)
        expect(await branchExists(projectDir, `team/${teamName}/${memberName}`)).toBe(true)

        // destroyWorktree called with worktreePath=undefined (member never had one).
        await destroyWorktree(projectDir, undefined, worktreesRoot, teamName, memberName)

        // Pre-fix: branch silently deleted by the unconditional `git branch -D`.
        // Post-fix: branch preserved.
        expect(await branchExists(projectDir, `team/${teamName}/${memberName}`)).toBe(true)
    })

    test("control: still deletes the branch when worktreePath was registered", async () => {
        // Symmetric positive case: a member WITH a registered worktree path. The
        // companion branch was created by createWorktree, so destroyWorktree
        // SHOULD delete it. This proves the guard targets the undefined-path
        // case only, not a blanket "never delete branches".
        const projectDir = tmpRoot("c10-with-worktree")
        const worktreesRoot = path.join(projectDir, ".octeam", "worktrees")
        await mkdir(worktreesRoot, { recursive: true })
        const teamName = "myteam2"
        const memberName = "bob"

        await setupRepoWithUnmergedBranch(projectDir, teamName, memberName)

        // Create a fake worktree path under worktreesRoot so cleanWorktree finds
        // something to operate on. Use `git worktree add` so the path is real.
        const wtPath = path.join(worktreesRoot, memberName)
        await execFileP("git", ["worktree", "add", wtPath, `team/${teamName}/${memberName}`], { cwd: projectDir })

        await destroyWorktree(projectDir, wtPath, worktreesRoot, teamName, memberName)

        // After destroyWorktree (worktree removed + branch deleted), the branch
        // is gone (this is the documented symmetric teardown behavior).
        expect(await branchExists(projectDir, `team/${teamName}/${memberName}`)).toBe(false)
    })
})

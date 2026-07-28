/**
 * C15 (2026-07-28 audit): cleanWorktree validates `resolved` (relative to
 * worktreesRoot) but passes the original `worktreePath` to git (resolved
 * relative to projectDir as cwd). The two paths can diverge.
 *
 * Bug: cleanWorktree (worktrees.ts:86) runs:
 *   await execFileP("git", ["worktree", "remove", worktreePath, "--force"], { cwd: projectDir })
 *
 * Validation at line 75/82 checks `resolved` = path.resolve(worktreesRoot, worktreePath),
 * but git resolves `worktreePath` relative to `projectDir` (its cwd). When
 * worktreePath is relative, these two resolutions diverge:
 *   - validated path: <worktreesRoot>/<worktreePath>
 *   - git's path:     <projectDir>/<worktreePath>
 *
 * Fix: pass `resolved` (the already-validated absolute path) to git instead
 * of the original `worktreePath`. The git command accepts absolute paths.
 */
import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { access, mkdtemp, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { cleanWorktree } from "../src/state/worktrees.js"

const execFileP = promisify(execFile)

async function initGitRepo(dir: string): Promise<void> {
    await execFileP("git", ["init", "-q"], { cwd: dir })
    await execFileP("git", ["config", "user.email", "test@test.test"], { cwd: dir })
    await execFileP("git", ["config", "user.name", "test"], { cwd: dir })
    await execFileP("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir })
}

async function pathExists(p: string): Promise<boolean> {
    try { await access(p); return true } catch { return false }
}

describe("C15: cleanWorktree passes validated absolute path to git", () => {
    test("relative worktreePath is resolved against worktreesRoot, not projectDir", async () => {
        const projectDir = await mkdtemp(path.join(os.tmpdir(), "c15-project-"))
        const storageRoot = await mkdtemp(path.join(os.tmpdir(), "c15-storage-"))
        const worktreesRoot = path.join(storageRoot, "teams", "alpha", "worktrees")
        await mkdir(worktreesRoot, { recursive: true })

        await initGitRepo(projectDir)

        // Create a legitimate worktree under worktreesRoot.
        const wtAbsPath = path.join(worktreesRoot, "alice")
        await execFileP("git", ["worktree", "add", wtAbsPath, "-b", "team/alpha/alice"], { cwd: projectDir })
        expect(await pathExists(wtAbsPath)).toBe(true)

        // cleanWorktree with a RELATIVE path. Validation resolves it against
        // worktreesRoot (correct). On UNFIXED code, the original relative
        // "alice" is passed to git whose cwd is projectDir → git looks for
        // <projectDir>/alice (wrong, doesn't exist) → git fails silently →
        // the real worktree at <worktreesRoot>/alice SURVIVES.
        // On FIXED code, the validated absolute path is passed → git removes
        // the correct worktree → it's gone.
        await cleanWorktree(projectDir, "alice", worktreesRoot)

        // The worktree at <worktreesRoot>/alice MUST be removed.
        expect(await pathExists(wtAbsPath)).toBe(false)
    })
})

/**
 * Git worktree lifecycle helpers. Co-located with the state layer so git
 * operations are reusable (creation lives in orchestration/dispatch.ts;
 * teardown + dirty-check live here).
 *
 * All operations are best-effort: a git failure never blocks team lifecycle.
 */

import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

import { logger } from '../core/log.js';


const execFileP = promisify(execFile)

/**
 * Best-effort git worktree teardown. Removes the worktree registration + files
 * for a member that was created with worktree: true. Must run BEFORE the team
 * directory is deleted, while the worktree files still exist on disk.
 *
 * Defense-in-depth bounds check: `worktreePath` MUST resolve strictly inside
 * `worktreesRoot` (the team's own worktrees/ directory). A tampered or
 * hand-edited member.worktreePath — e.g. set on the in-memory Team object,
 * bypassing the load-time validator — could otherwise point at an unrelated
 * registered worktree of the project repo and `git worktree remove --force`
 * would destroy it. An out-of-bounds path is refused (warning + early return);
 * git errors remain best-effort as before.
 */
export async function cleanWorktree(
    projectDir: string,
    worktreePath: string | undefined,
    worktreesRoot: string,
): Promise<void> {
    if (!worktreePath) return
    const root = path.resolve(worktreesRoot)
    const resolved = path.resolve(root, worktreePath)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        logger.warn("cleanWorktree: refusing out-of-bounds worktreePath", { path: worktreePath })
        return
    }
    await execFileP("git", ["worktree", "remove", worktreePath, "--force"], {
        cwd: projectDir,
    })
}

/**
 * Best-effort check: does the worktree at `worktreePath` have uncommitted
 * changes (staged, unstaged, or untracked)? Returns false if the path is
 * missing, not a git repo, or git itself fails — never blocks deletion on a
 * git error.
 */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    try {
        const { stdout } = await execFileP("git", ["status", "--porcelain"], {
            cwd: worktreePath,
        })
        return stdout.trim().length > 0
    } catch {
        return false
    }
}

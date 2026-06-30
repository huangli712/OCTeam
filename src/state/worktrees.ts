/**
 * Git worktree lifecycle helpers. Co-located with the state layer so git
 * operations are reusable (creation lives in orchestration/dispatch.ts;
 * teardown + dirty-check live here).
 *
 * All operations are best-effort: a git failure never blocks team lifecycle.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileP = promisify(execFile)

/**
 * Best-effort git worktree teardown. Removes the worktree registration + files
 * for a member that was created with worktree: true. Must run BEFORE the team
 * directory is deleted, while the worktree files still exist on disk.
 */
export async function cleanWorktree(
    projectDir: string,
    worktreePath: string | undefined,
): Promise<void> {
    if (!worktreePath) return
    await execFileP("git", ["worktree", "remove", worktreePath, "--force"], {
        cwd: projectDir,
    }).catch(() => {
        // best effort
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

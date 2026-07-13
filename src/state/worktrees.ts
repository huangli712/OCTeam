/**
 * Git worktree lifecycle helpers. Co-located with the state layer so git
 * operations are reusable. All operations are best-effort: a git failure never
 * blocks team lifecycle.
 */

import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

import { logger } from '../core/log.js';
import { worktreePath } from "./paths.js";

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

/**
 * Create an isolated git worktree for a member: `git worktree add <path> -b team/<team>/<member>`.
 * Only called when the member spec has worktree: true. Runs git in the project
 * directory; the worktree path lives under the team's worktrees/ dir.
 */
export async function createWorktree(
    projectDir: string,
    teamDirectory: string,
    teamName: string,
    memberName: string,
): Promise<string> {
    const dest = worktreePath(teamDirectory, memberName);
    const branch = `team/${teamName}/${memberName}`;
    // Fail fast if branch/worktree already exists; team_create idempotency is
    // handled by the caller checking member.worktreePath.
    await execFileP("git", ["worktree", "add", dest, "-b", branch], {
        cwd: projectDir,
    }).catch((err) => {
        throw new Error(
            `createWorktree(${memberName}) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    });
    return dest;
}

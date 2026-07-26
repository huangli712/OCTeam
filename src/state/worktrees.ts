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

/** Promisified child_process.execFile for git operations. */
const execFileP = promisify(execFile)

/**
 * Safety check: does the worktree at `worktreePath` have uncommitted
 * changes (staged, unstaged, or untracked)? Returns false if the path is
 * missing or not a git repo. On a Git command failure (e.g. corrupt repo,
 * permission denied), returns TRUE (fail-closed) so that team_delete refuses
 * to proceed without force — protecting potentially uncommitted work that
 * could not be verified.
 */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    try {
        const { stdout } = await execFileP("git", ["status", "--porcelain"], {
            cwd: worktreePath,
        })
        return stdout.trim().length > 0
    } catch (err) {
        // Distinguish "not a git path" (safe) from "git failed" (unsafe).
        // A non-existent path or non-repo has no work to lose → return false.
        // Any other error means we CANNOT verify cleanliness → fail closed.
        const msg = err instanceof Error ? err.message : String(err)
        if (
            /not a git repository|does not exist|no such file/i.test(msg)
            || (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
            return false
        }
        logger.warn("hasUncommittedChanges: git status failed, treating as dirty (fail-closed)", {
            worktreePath, error: msg,
        })
        return true
    }
}

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

/**
 * Tear down a member's worktree AND its companion branch in one call.
 * Symmetric to {@link createWorktree}: removes the worktree registration +
 * files via {@link cleanWorktree}, then deletes the `team/<team>/<member>`
 * branch. The branch deletion is best-effort (matching spawn rollback's
 * original behavior): a git failure is swallowed so it never blocks team
 * teardown. Order matters — the worktree must be removed before its branch
 * can be deleted (a checked-out branch is locked while the worktree exists).
 */
export async function destroyWorktree(
    projectDir: string,
    worktreePath: string | undefined,
    worktreesRoot: string,
    teamName: string,
    memberName: string,
): Promise<void> {
    try {
        await cleanWorktree(projectDir, worktreePath, worktreesRoot);
    } catch (err) {
        logger.warn("destroyWorktree: cleanWorktree failed, proceeding with branch deletion", {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    const branch = `team/${teamName}/${memberName}`;
    await execFileP("git", ["branch", "-D", branch], {
        cwd: projectDir,
    }).catch(() => {
        // Best effort — matches the historical spawn-rollback behavior.
        // A missing or already-removed branch is not a teardown blocker.
    });
}

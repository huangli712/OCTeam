/**
 * Git worktree lifecycle helpers. Co-located with the state layer so git
 * operations are reusable. Best-effort semantics vary by operation:
 * destroyWorktree swallows git failures so they never block team lifecycle,
 * cleanWorktree itself rejects on a git failure (callers decide how to
 * compensate), and createWorktree always throws (a member cannot spawn
 * without its worktree).
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import path from "node:path"

import { logger } from '../core/log.js';
//
import { assertNoSymlinkTraversal } from "./locks.js";
import {
    worktreePath,
    worktreesDir
} from "./paths.js";

/** Promisified child_process.execFile for git operations. */
const execFileP = promisify(execFile)

/**
 * Safety check: does the worktree at `worktreePath` have uncommitted
 * changes (staged, unstaged, or untracked)? Returns false for a clean
 * worktree and for an absent worktree path. On any other git failure
 * (corrupt .git, not a git repo, permission denied) returns true
 * (fail-closed) so that team_delete refuses to proceed without force —
 * protecting potentially uncommitted work that could not be verified.
 */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    try {
        const { stdout } = await execFileP("git", ["status", "--porcelain"], {
            cwd: worktreePath,
            timeout: 10_000, // Bound git status to prevent indefinite hangs
        })
        return stdout.trim().length > 0
    } catch (err) {
        // Distinguish "not a git path" (safe — worktree: false members have
        // no git worktree) from "git failed" (unsafe).
        // A corrupted .git directory also produces "not a git repository", so
        // only an absent worktree path is considered clean. Every other failure
        // returns true, requiring force: true to proceed.
        // ENOENT can also mean the git binary itself is missing. Verify
        // the path exists independently before treating ENOENT as "path absent".
        const msg = err instanceof Error ? err.message : String(err)
        const isEnoent = (err as NodeJS.ErrnoException).code === "ENOENT"
        if (isEnoent || /does not exist|no such file/i.test(msg)) {
            // Confirm the worktree path itself is the missing entity, not
            // the git binary or some other ENOENT source. Only if the path is
            // genuinely absent is it safe to return false (no work to lose).
            try {
                await fs.access(worktreePath)
                // Path exists but we got ENOENT — the git binary is likely
                // missing or the cwd is inaccessible. Fail-closed.
                logger.warn(
                    "hasUncommittedChanges: ENOENT from git but path exists "
                        + "(git binary missing or cwd issue), "
                        + "treating as dirty (fail-closed)",
                    {
                        worktreePath, error: msg,
                    },
                )
                return true
            } catch (accessErr) {
                // Only ENOENT means the path doesn't exist. EACCES,
                // EIO, ELOOP etc. mean it exists but is inaccessible —
                // treat as dirty (fail-closed) to protect uncommitted work.
                const code = (accessErr as NodeJS.ErrnoException).code
                if (code === "ENOENT") {
                    logger.debug(
                        "hasUncommittedChanges: path does not exist (no work to lose)",
                        { worktreePath },
                    )
                    return false
                }
                logger.warn(
                    "hasUncommittedChanges: access error, treating as dirty (fail-closed)",
                    { worktreePath, error: String(accessErr) },
                )
                return true
            }
        }
        logger.warn(
            "hasUncommittedChanges: git status failed (including corrupted .git), "
                + "treating as dirty (fail-closed)",
            {
                worktreePath, error: msg,
            },
        )
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
 * would destroy it. An out-of-bounds path is refused (warning + false);
 * a git failure rejects (destroyWorktree catches it and returns false so the
 * caller can keep the member's worktree fields).
 */
export async function cleanWorktree(
    projectDir: string,
    worktreePath: string | undefined,
    worktreesRoot: string,
): Promise<boolean> {
    if (!worktreePath) return true
    const root = path.resolve(worktreesRoot)
    const resolved = path.resolve(root, worktreePath)
    // Walk ancestor chain with lstat (no follow) so an intermediate-directory
    // symlink cannot redirect `git worktree remove --force` outside the team's
    // worktrees root.
    try {
        await assertNoSymlinkTraversal(root, resolved)
    } catch (err) {
        logger.warn("cleanWorktree: refusing symlink-bearing worktreePath", {
            path: worktreePath, error: err instanceof Error ? err.message : String(err),
        })
        return false
    }
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        logger.warn("cleanWorktree: refusing out-of-bounds worktreePath", { path: worktreePath })
        return false
    }
    // Pass the validated `resolved` (absolute) path to git, not the
    // original `worktreePath`. The validation above checks `resolved` =
    // path.resolve(worktreesRoot, worktreePath), but git resolves a relative
    // worktreePath against its cwd (projectDir). When projectDir !=
    // worktreesRoot, the two resolutions diverge. Passing the already-
    // validated absolute path eliminates the divergence.
    await execFileP("git", ["worktree", "remove", resolved, "--force"], {
        cwd: projectDir,
        timeout: 30_000,
    })
    return true
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
    // Verify the worktrees/ path chain is not symlink-redirected before
    // handing it to git. A symlinked worktrees/ dir would let git check out the
    // full repository outside the trusted team root.
    await assertNoSymlinkTraversal(teamDirectory, dest);
    await assertNoSymlinkTraversal(teamDirectory, worktreesDir(teamDirectory));
    const branch = `team/${teamName}/${memberName}`;
    // Fail fast if branch/worktree already exists; team_create idempotency is
    // handled by the caller checking member.worktreePath.
    await execFileP("git", ["worktree", "add", dest, "-b", branch], {
        cwd: projectDir,
        timeout: 30_000,
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
 * branch. Branch deletion failures are swallowed so they never block team
 * teardown. Order matters — the worktree must be removed before its branch
 * can be deleted (a checked-out branch is locked while the worktree exists).
 *
 * When `worktreePath` is undefined (the member
 * never had a worktree registered with OCTeam — e.g. worktree: false was
 * set at create time, or the team was created without worktrees), the
 * companion `team/<team>/<member>` branch was NEVER created by OCTeam and
 * MUST NOT be deleted. An unconditional `git branch -D` would silently
 * destroy any user-defined unmerged branch that happens to share the same
 * name (a real risk — `team/<team>/<member>` is a plausible feature-branch
 * name). The branch is only OCTeam-owned when createWorktree created it,
 * which is the only call site that also registers a worktreePath.
 */
export async function destroyWorktree(
    projectDir: string,
    worktreePath: string | undefined,
    worktreesRoot: string,
    teamName: string,
    memberName: string,
): Promise<boolean> {
    // No registered worktree → no OCTeam-owned companion branch. Skip BOTH
    // the worktree removal (cleanWorktree already early-returns on undefined)
    // and the branch deletion to avoid destroying a user-defined branch.
    if (!worktreePath) return true
    try {
        const cleaned = await cleanWorktree(projectDir, worktreePath, worktreesRoot);
        if (!cleaned) return false
    } catch (err) {
        logger.warn("destroyWorktree: cleanWorktree failed, skipping branch deletion", {
            error: err instanceof Error ? err.message : String(err),
        });
        return false
    }
    const branch = `team/${teamName}/${memberName}`;
    await execFileP("git", ["branch", "-D", branch], {
        cwd: projectDir,
        timeout: 10_000,
    }).catch((err) => {
        // Log instead of silently swallowing so orphan branches
        // are diagnosable.
        logger.warn("destroyWorktree: branch deletion failed (best-effort)", {
            branch, error: err instanceof Error ? err.message : String(err),
        });
        // A missing or already-removed branch is not a teardown blocker.
    });
    return true
}

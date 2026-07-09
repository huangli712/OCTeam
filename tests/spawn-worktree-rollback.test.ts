/**
 * Regression test for confirmed finding "spawn-worktree-not-rolled-back".
 *
 * Bug: src/orchestration/dispatch.ts:117 calls createWorktree() BEFORE
 * session.create (dispatch.ts:125) and promptAsync (dispatch.ts:151). If
 * either later step throws, the worktree + git branch created at line 117
 * are never removed — they leak on disk. On a retry of ensureMembersReady,
 * the member (no sessionId, so still in toSpawn) hits createWorktree again,
 * which fails because `git worktree add <path> -b <branch>` sees the
 * existing branch/worktree → the team is permanently wedged.
 *
 * Fix: wrap the post-worktree steps in try/catch; on failure, remove the
 * worktree (`git worktree remove --force <path>`) and delete the branch
 * (`git branch -D team/<team>/<member>`), then clear member.worktreePath.
 *
 * This test sets up a real git repo, creates a team with a worktree-enabled
 * member, makes session.create fail, and asserts the worktree + branch are
 * cleaned up. On UNFIXED code the leak is observable (dir exists, branch
 * exists, worktreePath set) → test FAILS. On FIXED code all are gone → PASSES.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { promisify } from "node:util"

import type { TeamSpec } from "../src/core/types.js"
import { ensureMembersReady } from "../src/orchestration/dispatch.js"
import { initTeamState, loadTeamState, writeTeamSpec } from "../src/state/store.js"
import { unindexSession } from "../src/state/resolve.js"
import { worktreePath } from "../src/state/paths.js"
import { makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"

const execFileP = promisify(execFile)


/** Init a git repo with an initial commit (git worktree add needs HEAD). */
async function initGitRepo(dir: string): Promise<void> {
    await execFileP("git", ["init", "-q"], { cwd: dir })
    await execFileP("git", ["config", "user.email", "test@test.test"], { cwd: dir })
    await execFileP("git", ["config", "user.name", "test"], { cwd: dir })
    await execFileP("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir })
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("spawn worktree rollback (finding: spawn-worktree-not-rolled-back)", () => {
    test("worktree + branch are removed when session.create fails after createWorktree", async () => {
        const projectDir = tmpRoot("wt-rb-git")
        const storageRoot = tmpRoot("wt-rb-store")
        const leadSid = "ses_wt_rb_lead"

        await initGitRepo(projectDir)

        // --- Team with one worktree-enabled member, no sessionId yet ---
        const alice = makeMember("alice") // no sessionId → in toSpawn
        await initTeamState(storageRoot, makeState("alpha", leadSid, [alice]), leadSid)
        const spec: TeamSpec = {
            version: 1,
            name: "alpha",
            createdAt: Date.now(),
            members: [{ name: "alice", role: "coder", prompt: "code", worktree: true }],
        }
        await writeTeamSpec(storageRoot, spec, leadSid)
        const team = await loadTeamState(storageRoot, "alpha", leadSid)

        const wtPath = worktreePath(team.directory, "alice")
        const branchName = "team/alpha/alice"

        // Sanity: worktree doesn't exist yet.
        await expect(access(wtPath)).rejects.toThrow()

        // --- Drive ensureMembersReady; session.create fails ---
        await expect(ensureMembersReady(makeCtx({ storageRoot, directory: projectDir, overrides: { client: { app: { log: async () => ({}) }, session: { create: async () => { throw new Error("session.create boom") } } } } }), team))
            .rejects.toThrow("session.create boom")

        // --- ASSERT: the worktree directory must have been cleaned up ---
        // On UNFIXED code: createWorktree succeeded, session.create threw,
        // nothing cleaned up → wtPath still exists → access resolves → FAIL.
        // On FIXED code: rollback removed it → access rejects (ENOENT) → PASS.
        await expect(access(wtPath)).rejects.toThrow()

        // --- ASSERT: the git branch must have been deleted ---
        // On UNFIXED code: branch `team/alpha/alice` still exists → FAIL.
        // On FIXED code: branch was deleted → stdout empty → PASS.
        const branches = await execFileP(
            "git",
            ["branch", "--list", branchName],
            { cwd: projectDir },
        )
        expect(branches.stdout.trim()).toBe("")

        // --- ASSERT: member.worktreePath was cleared ---
        // On UNFIXED code: still set from createWorktree's return → FAIL.
        // On FIXED code: cleared by rollback → PASS.
        expect(team.members[0].worktreePath).toBeUndefined()
    })
})

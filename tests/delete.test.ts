import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import type { PluginContext } from "../src/core/context.js"
import { teamDeleteTool } from "../src/tools/lifecycle/delete.js"
import { initTeamState } from "../src/state/store.js"
import { teamDir, worktreesDir } from "../src/state/paths.js"
import { unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeMember, makeState, makeToolContext, tmpRoot } from './helpers.js';

afterAll(cleanupTmpRoots)

const execFileP = promisify(execFile)

async function gitInit(dir: string): Promise<void> {
    await execFileP("git", ["init", "-q"], { cwd: dir })
    await execFileP("git", ["config", "user.email", "t@t.com"], { cwd: dir })
    await execFileP("git", ["config", "user.name", "t"], { cwd: dir })
    await writeFile(join(dir, "README.md"), "init\n")
    await execFileP("git", ["add", "."], { cwd: dir })
    await execFileP("git", ["commit", "-q", "-m", "init"], { cwd: dir })
}

/** Set up a repo + a team whose member "alice" has a real git worktree.
 *
 * `label` only names the tmp directories (so parallel test runs don't collide);
 * the team's `teamName` is always "alpha" (matching the existing tests) and
 * the branch is `team/alpha/alice` — mirroring production createWorktree,
 * which derives the branch from team.teamName, NOT from any external label.
 */
async function setupTeamWithWorktree(
    label: string,
    dirty: boolean,
): Promise<{ tool: ReturnType<typeof teamDeleteTool>; sid: string; repoDir: string }> {
    const repoDir = tmpRoot(`${label}-repo`)
    const storageRoot = tmpRoot(`${label}-store`)
    const sid = `ses_${label}`
    await gitInit(repoDir)

    // Worktree lives under the team's worktrees/ dir, exactly as production
    // createWorktree (dispatch.ts) places it. The team dir must exist first
    // (created by initTeamState), so persist state before `git worktree add`.
    const wtPath = join(worktreesDir(teamDir(storageRoot, "alpha", sid)), "alice")
    const alice = { ...makeMember("alice"), worktreePath: wtPath }
    await initTeamState(storageRoot, makeState("alpha", sid, [alice]), sid)

    // Create a worktree for member "alice" under the team worktrees dir.
    // Branch name follows the production convention team/<teamName>/<member>.
    await execFileP("git", ["worktree", "add", "-q", wtPath, "-b", `team/alpha/alice`], {
        cwd: repoDir,
    })

    if (dirty) {
        await writeFile(join(wtPath, "uncommitted.txt"), "dirty\n")
    }

    const ctx = { storageRoot, directory: repoDir, scope: "project" } as unknown as PluginContext
    return { tool: teamDeleteTool(ctx), sid, repoDir }
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("team_delete uncommitted-changes guard", () => {
    test("dirty worktree + force:false → rejected, names the member", async () => {
        const { tool, sid } = await setupTeamWithWorktree("dirty-noforce", true)
        tracked.push(sid)
        const result = await tool.execute({ team_id: "alpha" }, makeToolContext(sid))
        expect(result).toContain("uncommitted changes")
        expect(result).toContain("alice")
    })

    test("dirty worktree + force:true → deleted (forced)", async () => {
        const { tool, sid } = await setupTeamWithWorktree("dirty-force", true)
        tracked.push(sid)
        const result = await tool.execute({ team_id: "alpha", force: true }, makeToolContext(sid))
        expect(result).toContain("deleted")
        expect(result).toContain("forced")
    })

    test("clean worktree + force:false → deleted normally", async () => {
        const { tool, sid } = await setupTeamWithWorktree("clean-noforce", false)
        tracked.push(sid)
        const result = await tool.execute({ team_id: "alpha" }, makeToolContext(sid))
        expect(result).toContain("deleted")
        expect(result).not.toContain("uncommitted")
    })

    test("no worktree (live team) + force:false → deleted (guard skipped)", async () => {
        const repoDir = tmpRoot("live-repo")
        const storageRoot = tmpRoot("live-store")
        const sid = "ses_live"
        await gitInit(repoDir)
        // member has no worktreePath (live team, never dispatched)
        await initTeamState(storageRoot, makeState("alpha", sid, [makeMember("alice")]), sid)
        const ctx = { storageRoot, directory: repoDir, scope: "project" } as unknown as PluginContext
        tracked.push(sid)
        const result = await teamDeleteTool(ctx).execute({ team_id: "alpha" }, makeToolContext(sid))
        expect(result).toContain("deleted")
        expect(result).not.toContain("uncommitted")
    })
})

describe("team_delete git branch cleanup", () => {
    test("team_delete also removes the member's companion git branch (team/<team>/<member>)", async () => {
        // Regression: previously team_delete called only cleanWorktree (which
        // runs `git worktree remove --force` but does NOT delete the branch).
        // The spawn-rollback path correctly deleted the branch, but team_delete
        // did not, leaving orphan `team/<team>/<member>` branches behind.
        // After the fix (destroyWorktree helper), team_delete must also drop
        // the branch.
        const { tool, sid, repoDir } = await setupTeamWithWorktree("branch-cleanup", false)
        tracked.push(sid)

        // Sanity: the branch exists before delete (setupTeamWithWorktree created it).
        const before = await execFileP(
            "git",
            ["branch", "--list", "team/alpha/alice"],
            { cwd: repoDir },
        )
        expect(before.stdout.trim()).not.toBe("")

        const result = await tool.execute({ team_id: "alpha" }, makeToolContext(sid))
        expect(result).toContain("deleted")

        // Assert: branch must be gone after delete.
        const after = await execFileP(
            "git",
            ["branch", "--list", "team/alpha/alice"],
            { cwd: repoDir },
        )
        expect(after.stdout.trim()).toBe("")
    })

    test("worktree cleanup runs before quarantine so paths are valid", async () => {
        const storageRoot = tmpRoot("quarantine-order-store")
        const projectDir = tmpRoot("quarantine-order-project")
        const binDir = tmpRoot("quarantine-order-bin")
        const sid = "ses_quarantine_order"
        const dir = teamDir(storageRoot, "alpha", sid)
        const wtPath = join(worktreesDir(dir), "alice")
        const logPath = join(binDir, "git.log")
        const gitPath = join(binDir, "git")
        const alice = { ...makeMember("alice"), worktreePath: wtPath }
        await initTeamState(storageRoot, makeState("alpha", sid, [alice]), sid)
        await mkdir(wtPath, { recursive: true })
        await writeFile(gitPath, `#!/bin/sh
if [ -e "$OCTEAM_S8_CANONICAL" ]; then
    printf 'present\\n'
else
    printf 'absent\\n'
fi >> "$OCTEAM_S8_LOG"
exit 0
`, { mode: 0o755 })

        const previousPath = process.env.PATH
        process.env.PATH = `${binDir}:${previousPath ?? ""}`
        process.env.OCTEAM_S8_CANONICAL = dir
        process.env.OCTEAM_S8_LOG = logPath
        tracked.push(sid)
        let result: string
        try {
            const ctx = { storageRoot, directory: projectDir, scope: "project" } as unknown as PluginContext
            result = await teamDeleteTool(ctx).execute(
                { team_id: "alpha", force: true },
                makeToolContext(sid),
            )
        } finally {
            if (previousPath === undefined) delete process.env.PATH
            else process.env.PATH = previousPath
            delete process.env.OCTEAM_S8_CANONICAL
            delete process.env.OCTEAM_S8_LOG
        }

        expect(result).toContain("deleted")
        const observations = (await readFile(logPath, "utf8")).trim().split("\n")
        expect(observations.length).toBeGreaterThan(0)
        // H26: worktree cleanup now runs BEFORE quarantine rename so the
        // worktree paths still exist when git is invoked. Pre-fix code ran
        // cleanup after quarantine, operating on non-existent paths.
        expect(observations.every(observation => observation === "present")).toBe(true)
    })
})

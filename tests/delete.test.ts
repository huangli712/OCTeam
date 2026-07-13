import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import { teamDeleteTool } from "../src/tools/lifecycle/delete.js"
import { initTeamState } from "../src/state/store.js"
import { teamDir, worktreesDir } from "../src/state/paths.js"
import { unindexSession } from "../src/state/resolve.js"
import { makeMember, makeState, makeToolContext, tmpRoot } from './helpers.js';

const execFileP = promisify(execFile)

async function gitInit(dir: string): Promise<void> {
    await execFileP("git", ["init", "-q"], { cwd: dir })
    await execFileP("git", ["config", "user.email", "t@t.com"], { cwd: dir })
    await execFileP("git", ["config", "user.name", "t"], { cwd: dir })
    await writeFile(join(dir, "README.md"), "init\n")
    await execFileP("git", ["add", "."], { cwd: dir })
    await execFileP("git", ["commit", "-q", "-m", "init"], { cwd: dir })
}

/** Set up a repo + a team whose member "alice" has a real git worktree. */
async function setupTeamWithWorktree(
    label: string,
    dirty: boolean,
): Promise<{ tool: ReturnType<typeof teamDeleteTool>; sid: string }> {
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
    await execFileP("git", ["worktree", "add", "-q", wtPath, "-b", `team/${label}/alice`], {
        cwd: repoDir,
    })

    if (dirty) {
        await writeFile(join(wtPath, "uncommitted.txt"), "dirty\n")
    }

    const ctx = { storageRoot, directory: repoDir, scope: "project" } as unknown as PluginContext
    return { tool: teamDeleteTool(ctx), sid }
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

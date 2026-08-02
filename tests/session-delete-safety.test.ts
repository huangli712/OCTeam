import { execFileSync } from "node:child_process"
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import type { PluginContext } from "../src/core/context.js"
import { handleSessionDeleted } from "../src/orchestration/lifecycle/reconcile.js"
import { deletedMarkerPath, teamDir, worktreePath } from "../src/state/paths.js"
import { initTeamState } from "../src/state/store.js"
import { cleanupTmpRoots, makeMember, makeState, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

function context(projectStorageRoot: string, directory: string): PluginContext {
    return {
        storageRoot: projectStorageRoot,
        projectStorageRoot,
        userStorageRoot: `${projectStorageRoot}__user`,
        directory,
        scope: "project",
        client: { app: { log: async () => ({}) } },
    } as unknown as PluginContext
}

describe("session deletion safety", () => {
    test("dirty member worktree prevents recursive session deletion", async () => {
        const root = tmpRoot("session-delete-dirty")
        const project = tmpRoot("session-delete-dirty-project")
        const sid = "ses_delete_dirty"
        const memberWorktree = worktreePath(teamDir(root, "alpha", sid), "alice")
        await fs.mkdir(memberWorktree, { recursive: true })
        execFileSync("git", ["init"], { cwd: memberWorktree, stdio: "ignore" })
        await fs.writeFile(path.join(memberWorktree, "uncommitted.txt"), "keep me")
        const alice = { ...makeMember("alice"), worktreePath: memberWorktree }
        await initTeamState(root, makeState("alpha", sid, [alice]), sid)
        const sessionDirectory = path.join(root, sid)

        await handleSessionDeleted(context(root, project), sid)

        expect((await fs.stat(sessionDirectory)).isDirectory()).toBe(true)
        expect(await fs.readFile(path.join(memberWorktree, "uncommitted.txt"), "utf8")).toBe("keep me")
    })

    test("deletion marker write does not follow a pre-positioned symlink", async () => {
        const root = tmpRoot("session-delete-marker")
        const project = tmpRoot("session-delete-marker-project")
        const sid = "ses_delete_marker"
        const team = await initTeamState(root, makeState("alpha", sid), sid)
        const outside = path.join(tmpRoot("session-delete-marker-outside"), "marker")
        await fs.writeFile(outside, "preserve")
        await fs.symlink(outside, deletedMarkerPath(team.directory))

        await handleSessionDeleted(context(root, project), sid)

        expect(await fs.readFile(outside, "utf8")).toBe("preserve")
        const teamStillExists = await fs.stat(teamDir(root, "alpha", sid)).then(
            () => true,
            () => false,
        )
        expect(teamStillExists).toBe(false)
    })
})

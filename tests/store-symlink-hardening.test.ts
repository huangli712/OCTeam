import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { deletedMarkerPath } from "../src/state/paths.js"
import { initTeamState, quarantineTeamStorage, saveTeamState } from "../src/state/store.js"
import { cleanupTmpRoots, makeState, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
    try {
        await promise
    } catch (error) {
        return error instanceof Error ? error.message : String(error)
    }
    throw new Error("expected promise to reject")
}

describe("store symlink hardening", () => {
    test("saveTeamState does not follow a symlinked deletion marker", async () => {
        const root = tmpRoot("store-marker-read")
        const sid = "ses_store_marker_read"
        const team = await initTeamState(root, makeState("alpha", sid), sid)
        const outside = path.join(tmpRoot("store-marker-read-outside"), "marker")
        await fs.writeFile(outside, team.teamRunId)
        await fs.symlink(outside, deletedMarkerPath(team.directory))

        expect(await rejectionMessage(saveTeamState(team))).toMatch(/symlink/i)
        expect(team.deleted).not.toBe(true)
        expect(await fs.readFile(outside, "utf8")).toBe(team.teamRunId)
    })

    test("quarantine checks the lifecycle lock under the trusted team root", async () => {
        const root = tmpRoot("store-quarantine-lock")
        const sid = "ses_store_quarantine_lock"
        const team = await initTeamState(root, makeState("alpha", sid), sid)
        const outside = tmpRoot("store-quarantine-lock-outside")
        const realDirectory = `${team.directory}.real`
        const originalLstat = fs.lstat
        let teamDirectoryChecks = 0

        Object.defineProperty(fs, "lstat", {
            configurable: true,
            value: async (...args: Parameters<typeof fs.lstat>) => {
                const stat = await originalLstat(...args)
                if (path.resolve(String(args[0])) === path.resolve(team.directory)) {
                    teamDirectoryChecks += 1
                    if (teamDirectoryChecks === 1) {
                        await fs.rename(team.directory, realDirectory)
                        await fs.symlink(outside, team.directory, "dir")
                    }
                }
                return stat
            },
        })

        try {
            const message = await rejectionMessage(quarantineTeamStorage(
                root,
                team.teamName,
                sid,
                team.directory,
                team.teamRunId,
            ))
            expect(message).toMatch(/symlink/i)
        } finally {
            Object.defineProperty(fs, "lstat", { configurable: true, value: originalLstat })
        }
    })
})

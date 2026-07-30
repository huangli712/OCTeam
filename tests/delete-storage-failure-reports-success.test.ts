import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { join, sep } from "node:path"

// Load the real module before installing targeted rename/rm failures.
const require = createRequire(import.meta.url)
const realFs = require("node:fs/promises") as typeof import("node:fs/promises")

let failTeamDirRename = false
let failQuarantineRm = false
let teamDirToFail: string | null = null
let quarantineRootToFail: string | null = null

const mockedFs = {
    ...realFs,
    rename: (async (source: string, destination: string) => {
        if (failTeamDirRename && teamDirToFail && source === teamDirToFail) {
            const err = new Error(
                `EPERM: simulated quarantine rename failure: rename '${source}' -> '${destination}'`,
            ) as NodeJS.ErrnoException
            err.code = "EPERM"
            throw err
        }
        return realFs.rename(source, destination)
    }) as typeof realFs.rename,
    rm: (async (target: string, opts?: Parameters<typeof realFs.rm>[1]) => {
        if (
            failQuarantineRm
            && quarantineRootToFail
            && target.startsWith(quarantineRootToFail + sep)
        ) {
            const err = new Error(
                `EPERM: simulated quarantine rm failure: rm '${target}'`,
            ) as NodeJS.ErrnoException
            err.code = "EPERM"
            throw err
        }
        return realFs.rm(target, opts)
    }) as typeof realFs.rm,
}

// `default` is required: store.ts and delete.ts do `import fs from`.
mock.module("node:fs/promises", () => ({ ...mockedFs, default: mockedFs }))

// Dynamic imports AFTER mock.module so all modules resolve the MOCKED fs.
const { teamDeleteTool } = await import("../src/tools/lifecycle/delete.js")
const { initTeamState } = await import("../src/state/store.js")

import { teamDir } from "../src/state/paths.js"
import { unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from './helpers.js';


async function pathExists(p: string): Promise<boolean> {
    try {
        await realFs.access(p)
        return true
    } catch {
        return false
    }
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
    failTeamDirRename = false
    failQuarantineRm = false
    teamDirToFail = null
    quarantineRootToFail = null
})
afterAll(cleanupTmpRoots)

describe("delete storage failure reports success (finding: delete-storage-failure-reports-success)", () => {
    test("quarantine rename failure leaves canonical storage and worktrees intact", async () => {
        const root = tmpRoot("delete-rename-fail")
        const sid = "ses_delete_rename_fail"
        tracked.push(sid)
        const teamName = "alpha"
        const dir = teamDir(root, teamName, sid)
        const worktreePath = join(dir, "worktrees", "alice")
        const alice = { ...makeMember("alice"), worktreePath }
        const team = await initTeamState(root, makeState(teamName, sid, [alice]), sid)
        await realFs.mkdir(worktreePath, { recursive: true })

        failTeamDirRename = true
        teamDirToFail = dir
        const result = await teamDeleteTool(makeCtx({ storageRoot: root })).execute(
            { team_id: teamName, force: true },
            makeToolContext(sid),
        )

        expect(result).not.toContain("deleted")
        expect(result).toMatch(/Error|fail/i)
        expect(await pathExists(dir)).toBe(true)
        expect(await pathExists(worktreePath)).toBe(true)
        expect(team.deleted).toBe(true)
    })

    test("quarantine removal failure does not restore the team as usable", async () => {
        const root = tmpRoot("delete-rm-fail")
        const sid = "ses_delete_rm_fail"
        tracked.push(sid)
        const teamName = "alpha"
        const dir = teamDir(root, teamName, sid)

        const team = await initTeamState(root, makeState(teamName, sid, [makeMember("alice")]), sid)
        expect(await pathExists(dir)).toBe(true)

        failQuarantineRm = true
        quarantineRootToFail = join(root, ".quarantine")

        const result = await teamDeleteTool(makeCtx({ storageRoot: root })).execute(
            { team_id: teamName, force: true },
            makeToolContext(sid),
        ).catch((err: unknown) => `THREW: ${(err as Error).message}`)

        expect(result).not.toContain("deleted")
        expect(result).toMatch(/Error|fail|THREW/i)
        expect(result).not.toContain("restored to a usable state")

        expect(await pathExists(dir)).toBe(false)
        expect(team.deleted).toBe(true)
    })
})

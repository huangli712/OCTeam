/**
 * Regression test for confirmed finding "delete-storage-failure-reports-success".
 *
 * Bug: src/state/store.ts:403-410 — deleteTeamStorage swallows ALL fs.rm
 * failures:
 *   await fs.rm(teamDir(...), { recursive: true, force: true })
 *       .catch((err) => { console.warn(...) })  // swallows + logs only
 * It ALWAYS resolves (never throws), regardless of whether the directory was
 * actually removed.
 *
 * src/tools/lifecycle/delete.ts:90-93 then unconditionally:
 *   :91  invalidateTeam(team.directory)  // removes in-memory registry entry
 *   :93  return `Team "${team_id}" deleted (forced).`  // reports success
 *
 * Harm: if fs.rm fails (EPERM, EBUSY, EROFS, locked files, ...), the team
 * directory remains on disk (state.json + config.json + mailbox + tasks all
 * intact), but the tool reports success and the in-memory registry entry is
 * wiped. On plugin restart, rebuildSessionIndex scans disk and the orphaned
 * team reappears — a "deleted" team silently resurrects, potentially with
 * stale orchestration state.
 *
 * Fix: deleteTeamStorage must propagate non-ENOENT fs.rm errors (force:true
 * already handles ENOENT), and delete.ts must surface the failure instead of
 * returning a success message.
 *
 * This test mocks node:fs/promises so fs.rm throws EPERM for the team
 * directory path. It asserts the delete tool must NOT report success when
 * storage deletion failed.
 *   UNFIXED: deleteTeamStorage swallows EPERM → resolves → delete returns
 *            "Team ... deleted (forced)." → assertion FAILS.
 *   FIXED:   EPERM propagates from deleteTeamStorage → delete surfaces the
 *            error (return string OR throw) → assertion PASSES.
 *
 * Mocking notes: node:fs/promises is pre-cached by bun's runtime, so
 * mock.module must (a) include a `default` export and (b) be in effect before
 * the modules are imported (dynamic `await import`). Only fs.rm for the
 * specific team directory path is intercepted; all other fs operations
 * (readFile for loadTeamState, atomicWrite for state init, mkdir, etc.) pass
 * through to the real implementation.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"

// --- Load the REAL node:fs/promises BEFORE mock.module registers so every
//     export except `rm` keeps its real implementation. ---
const require = createRequire(import.meta.url)
const realFs = require("node:fs/promises") as typeof import("node:fs/promises")

let failTeamDirRm = false
let teamDirToFail: string | null = null

const mockedFs = {
    ...realFs,
    rm: (async (target: string, opts?: Parameters<typeof realFs.rm>[1]) => {
        // Intercept only the team-directory rm from deleteTeamStorage.
        // Match by exact path so cleanup rms (e.g. from other tests' helpers)
        // are unaffected. The flag is gated so fixture setup (initTeamState)
        // is not impacted.
        if (failTeamDirRm && teamDirToFail && target === teamDirToFail) {
            const err = new Error(
                `EPERM: simulated deleteTeamStorage rm failure: rm '${target}'`,
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

import type { ToolContext } from "@opencode-ai/plugin"
import { teamDir } from "../src/state/paths.js"
import { unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"


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
    failTeamDirRm = false
    teamDirToFail = null
})
afterAll(cleanupTmpRoots)

describe("delete storage failure reports success (finding: delete-storage-failure-reports-success)", () => {
    test("fs.rm failure during delete must NOT report success", async () => {
        const root = tmpRoot("delete-rm-fail")
        const sid = "ses_delete_rm_fail"
        tracked.push(sid)
        const teamName = "alpha"
        const dir = teamDir(root, teamName, sid)

        // Fixture: create a live team on disk (state.json + directory).
        await initTeamState(root, makeState(teamName, sid, [makeMember("alice")]), sid)

        // Confirm the team directory exists before the delete attempt.
        expect(await pathExists(dir)).toBe(true)

        // Configure the mock to fail fs.rm for this exact team directory,
        // simulating EPERM (permissions/lock/EROFS) during deleteTeamStorage.
        failTeamDirRm = true
        teamDirToFail = dir

        // --- Call team_delete with force:true. ---
        // UNFIXED: deleteTeamStorage swallows the EPERM (store.ts:406 .catch)
        //          → resolves → invalidateTeam runs → returns "deleted".
        // FIXED:   EPERM propagates → execute either returns an error string
        //          or throws. Normalize both via .catch.
        const result = await teamDeleteTool(makeCtx({ storageRoot: root })).execute(
            { team_id: teamName, force: true },
            { sessionID: sid } as unknown as ToolContext,
        ).catch((err: unknown) => `THREW: ${(err as Error).message}`)

        // --- The delete must NOT report success when storage deletion failed.
        //     UNFIXED: result = "Team "alpha" deleted (forced)." → contains
        //              "deleted" → assertion FAILS.
        //     FIXED:   result is an error message or throw → does NOT contain
        //              "deleted" → assertion PASSES. ---
        expect(result).not.toContain("deleted")

        // Evidence of the harm: the team directory is still on disk (rm
        // genuinely failed). On restart, rebuildSessionIndex would scan disk
        // and resurrect this "deleted" team from its orphaned state.
        expect(await pathExists(dir)).toBe(true)
    })
})

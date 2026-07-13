/**
 * Regression test for confirmed finding "create-team-dir-not-rolled-back".
 *
 * Bug: src/tools/lifecycle/create.ts:167 — fs.mkdir(teamDir(...), { recursive: false })
 * atomically claims the team directory BEFORE the later config/model/state
 * writes. If any of those later writes throw — writeTeamSpec (:206),
 * initTeamState (:217), or indexMasterTeam (:230) — the just-created directory
 * is NEVER removed. The orphan directory then permanently reserves the team
 * name: the next team_create with the same name hits EEXIST at :167-170 and
 * returns "already exists".
 *
 * Harm: a transient write failure (disk full, permissions glitch, etc.) during
 * team creation permanently bricks that team name — no retry can ever succeed
 * without manual cleanup of the orphan directory under .octeam/.
 *
 * Note: the bounds.maxMembers check at :191-198 DOES clean up the directory on
 * failure (it was added for finding "create-max-members-bypass"), but the
 * subsequent writeTeamSpec / initTeamState / indexMasterTeam calls have NO such
 * rollback — so the directory leak window remains open for those failures.
 *
 * This test deterministically reproduces the bug by mocking store.js's
 * writeTeamSpec to throw on its first invocation (simulating a post-mkdir write
 * failure), then asserts:
 *   1. The orphan team directory must NOT remain after the failed create.
 *   2. A retry with the same name must NOT be blocked by a stale orphan.
 * Both assertions FAIL on the unfixed code (orphan remains, retry blocked) and
 * PASS once create.ts rolls back the directory on write failure.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import fs from "node:fs/promises"

import type { ToolContext } from "@opencode-ai/plugin"
import { teamDir } from "../src/state/paths.js"
import { unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, tmpRoot } from "./helpers.js"

// --- Load the REAL store.js BEFORE mock.module registers so every export
//     except writeTeamSpec keeps its real implementation. mock.module replaces
//     the module globally and permanently in bun; other test files use
//     writeTeamSpec normally, so the throw is gated by a runtime flag that
//     only fires during this file's tests. ---
const require = createRequire(import.meta.url)
const realStore = require("../src/state/store.js") as typeof import("../src/state/store.js")
// Capture the real fn reference BEFORE mock.module — bun's mock.module mutates
// the live exports object, so realStore.writeTeamSpec would become the mock and
// recurse infinitely. The standalone const is not affected by the mutation.
const realWriteTeamSpec = realStore.writeTeamSpec

let writeTeamSpecShouldFail = false

mock.module("../src/state/store.js", () => ({
    ...realStore,
    writeTeamSpec: async (...args: Parameters<typeof realWriteTeamSpec>) => {
        if (writeTeamSpecShouldFail) {
            throw new Error("simulated write failure (post-mkdir)")
        }
        return realWriteTeamSpec(...args)
    },
}))

import { teamCreateTool } from "../src/tools/lifecycle/create.js"


async function pathExists(p: string): Promise<boolean> {
    try {
        await fs.access(p)
        return true
    } catch {
        return false
    }
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
    writeTeamSpecShouldFail = false
})
afterAll(cleanupTmpRoots)

describe("team_create directory rollback (finding: create-team-dir-not-rolled-back)", () => {
    test("post-mkdir write failure must not leave an orphan team directory", async () => {
        const root = tmpRoot("create-rollback-orphan")
        const sid = "ses_rollback_orphan"
        tracked.push(sid)
        const ctx = makeCtx({ storageRoot: root })
        const teamName = "orphaned-team"
        const dir = teamDir(root, teamName, sid)

        // writeTeamSpec throws on the next call → simulates a write failure
        // AFTER the directory was claimed at create.ts:167.
        writeTeamSpecShouldFail = true

        // First create: a post-mkdir write fails. Whether it surfaces as a
        // throw or an error string is an implementation detail — what matters
        // is that the directory created at create.ts:167 is cleaned up.
        await teamCreateTool(ctx).execute(
            { name: teamName, members: [{ role: "coder", prompt: "code" }] },
            { sessionID: sid } as unknown as ToolContext,
        ).catch(() => {
            // expected failure — swallowed so we can inspect the on-disk state
        })

        // create.ts rolls back the directory on write failure.
        expect(await pathExists(dir)).toBe(false)
    })

    test("orphaned directory must not permanently reserve the team name", async () => {
        const root = tmpRoot("create-rollback-retry")
        const sid = "ses_rollback_retry"
        tracked.push(sid)
        const ctx = makeCtx({ storageRoot: root })
        const teamName = "retry-team"

        // writeTeamSpec throws on the FIRST call only, then succeeds —
        // simulating a transient write failure on the initial attempt.
        writeTeamSpecShouldFail = true
        await teamCreateTool(ctx).execute(
            { name: teamName, members: [{ role: "coder", prompt: "code" }] },
            { sessionID: sid } as unknown as ToolContext,
        ).catch(() => {
            // expected failure — swallowed so the retry can proceed
        })

        // Retry with the same name. writeTeamSpec now succeeds.
        writeTeamSpecShouldFail = false
        const result = await teamCreateTool(ctx).execute(
            { name: teamName, members: [{ role: "coder", prompt: "code" }] },
            { sessionID: sid } as unknown as ToolContext,
        )

        // The directory was rolled back on the first failure, so the retry succeeds.
        expect(result).not.toContain("already exists")
    })
})

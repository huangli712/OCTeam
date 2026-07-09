/**
 * Regression test for the sweep-timer tombstone guard (P0-1 fix).
 *
 * Root cause: startSweepTimer snapshots activeTeams() at tick start, then
 * acquires each team's mutex one-by-one. A team_delete that completes between
 * the snapshot and mutex acquisition leaves the sweep holding a stale reference
 * to a team whose on-disk directory is already removed. The sweep's first action
 * — releaseStaleReservations -> withLock -> acquireLock -> fs.mkdir({recursive:
 * true}) — would recreate the just-removed <teamDir>/mailbox/ directory,
 * defeating the C7 tombstone intent.
 *
 * Fix (hooks.ts sweepTeamOnce): `if (team.deleted) return` at the top of the
 * runExclusive callback, mirroring processIdle (handlers.ts:117) and
 * handleStatusEvent (handlers.ts:346).
 *
 * This test reproduces the stale-reference race deterministically: it gives the
 * sweep a reference to a team that was deleted (tombstone set + dir removed +
 * registry invalidated) BEFORE the sweep body runs, then verifies the mailbox
 * directory is NOT recreated.
 */

import { access } from "node:fs/promises"
import path from "node:path"

import { afterAll, describe, expect, mock, test } from "bun:test"

import type { ActiveTask, MemberState } from "../src/core/types.js"
import { initTeamState, invalidateTeam, loadTeamState } from "../src/state/store.js"
import { teamDir } from "../src/state/paths.js"
import { sweepTeamOnce } from "../src/hooks.js"
import { makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"

function parallelTask(): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300_000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
    }
}

describe("sweep tombstone guard", () => {
    const roots: string[] = []

    afterAll(() => {
        for (const r of roots) {
            try { require("node:fs").rmSync(r, { recursive: true, force: true }) } catch { /* best-effort */ }
        }
    })

    test("sweepTeamOnce on a stale (deleted) team reference does NOT recreate the directory", async () => {
        const root = tmpRoot("sweep-tomb-1")
        roots.push(root)
        const leadSid = "ses_sw_t_m"
        const aliceSid = "ses_sw_t_a"

        const alice = makeMember("alice", aliceSid)
        const state = makeState("alpha", leadSid, [alice], Date.now())
        await initTeamState(root, state, leadSid)

        // Load the team so we hold the in-memory reference (registry cache).
        const team = await loadTeamState(root, "alpha", leadSid)

        // Give it an active task so it would appear in activeTeams().
        team.activeTask = parallelTask()

        // Simulate team_delete completing BEFORE the sweep acquires the mutex:
        // 1. Set the tombstone (delete.ts:59 does this first).
        // 2. Remove the on-disk directory (deleteTeamStorage).
        // 3. Invalidate the registry entry.
        team.deleted = true
        const dir = team.directory
        const { rmSync } = await import("node:fs")
        rmSync(dir, { recursive: true, force: true })
        invalidateTeam(dir)

        // The directory must be gone before we run the sweep body.
        expect(await absent(dir)).toBe(true)

        // Simulate the sweep's stale-reference path: sweepTeamOnce runs on the
        // stale team reference with an empty statusMap. The tombstone guard at
        // the top of the runExclusive callback must bail BEFORE
        // releaseStaleReservations -> withLock -> acquireLock -> fs.mkdir can
        // recreate <teamDir>/mailbox/.
        const ctx = makeCtx({ storageRoot: root, promptAsync: async () => {}, abort: async () => {}, status: async () => ({ data: {} }) })
        await sweepTeamOnce(ctx, team, {})

        // The mailbox subdirectory (which releaseStaleReservations would
        // recreate via withLock->mkdir) must still be absent.
        expect(await absent(path.join(dir, "mailbox"))).toBe(true)
        // The team directory itself must still be absent.
        expect(await absent(dir)).toBe(true)
    })

    test("sweepTeamOnce on a live (non-deleted) team still runs release and does not throw", async () => {
        // Sanity check: the guard does not accidentally no-op for live teams.
        const root = tmpRoot("sweep-tomb-2")
        roots.push(root)
        const leadSid = "ses_sw_live_m"
        const aliceSid = "ses_sw_live_a"

        const alice = makeMember("alice", aliceSid)
        const state = makeState("beta", leadSid, [alice], Date.now())
        await initTeamState(root, state, leadSid)
        const team = await loadTeamState(root, "beta", leadSid)
        team.activeTask = parallelTask()

        const ctx = makeCtx({ storageRoot: root, promptAsync: async () => {}, abort: async () => {}, status: async () => ({ data: {} }) })
        // Should complete without throwing and without removing the directory.
        await sweepTeamOnce(ctx, team, {})

        // The live team's directory must still exist (sweep did real work, not
        // bail on a tombstone).
        expect(await absent(team.directory)).toBe(false)
    })
})

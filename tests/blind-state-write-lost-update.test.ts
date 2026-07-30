/**
 * Regression test for confirmed finding "blind-state-write-lost-update".
 *
 * Bug: src/state/store.ts:204-212 — saveTeamState persists the caller's whole
 * in-memory Team snapshot under a cross-process file lock
 * (withLock(stateLockPath)) WITHOUT re-reading state.json inside that lock.
 * This is a BLIND WRITE. If two writers hold different stale snapshots (the
 * documented scenario: two processes editing a user-scope team, store.ts:197),
 * the second writer's write clobbers the first's changes with no merge.
 *
 * The docstring at store.ts:190-196 explicitly documents this hazard ("This
 * is a blind write ... so a stale snapshot silently clobbers any concurrent
 * mutation") and names the deferred fix ("replace this blind write with a
 * locked read-merge-write"). This test locks the current broken behavior so
 * the fix can be verified.
 *
 * Fix: inside withLock(stateLockPath), re-read state.json, field-level-merge
 * the caller's changes onto the disk state, then write the merged result.
 *
 * Reproduction strategy: within a single test process, we construct TWO
 * independent Team objects pointing at the SAME on-disk directory — simulating
 * two processes with divergent in-memory snapshots. Writer A's snapshot has
 * alice=errored (a completed transition). Writer B's snapshot is STALE
 * (alice=idle — loaded before A's write). B mutates bob=completed and saves.
 * On UNFIXED code, B's blind write serializes its whole stale snapshot
 * (alice=idle) → clobbers A's alice=errored. On FIXED code, B re-reads inside
 * the lock, sees alice=errored, preserves it, applies only bob=completed.
 *
 * Bypassing the in-process AsyncMutex is deliberate and correct: the in-process
 * mutex is per-process single-threading; across two processes there is no
 * shared in-process mutex. saveTeamState is called directly to exercise the
 * file-lock-only path that is the documented hazard.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import type { TeamState } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { initTeamState, saveTeamState } from "../src/state/store.js"
import { statePath, teamDir } from "../src/state/paths.js"
import { cleanupTmpRoots, makeMember, makeState, makeTask, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

/**
 * Build a standalone Team object pointing at `directory` with a deep-cloned
 * TeamState. This simulates a SECOND process's in-memory snapshot — it has its
 * own mutex (irrelevant — we call saveTeamState directly) and its own member
 * copies, so mutations to it do not affect writer A's object. saveTeamState
 * only reads team.deleted, team.directory, and the TeamState fields.
 */
function makeStandaloneTeam(directory: string, state: TeamState): Team {
    const clone: TeamState = JSON.parse(JSON.stringify(state))
    return {
        ...clone,
        directory,
        // _diskSnapshot captures the state as "loaded" from disk — the ancestor
        // for the three-way merge in saveTeamState. For Writer B this is the
        // stale snapshot (seed state before A's mutation), so the merge can
        // detect which fields B actually changed vs carried along stalely.
        _diskSnapshot: JSON.parse(JSON.stringify(state)),
        // Minimal fake mutex — saveTeamState does not use it (the caller is
        // "expected to already hold" it; here we call saveTeamState directly).
        mutex: { runExclusive: <T>(fn: () => Promise<T>) => fn() } as Team["mutex"],
    }
}

/** Read state.json from disk, bypassing the registry cache. */
async function readDiskState(directory: string): Promise<TeamState> {
    const raw = await readFile(statePath(directory), "utf8")
    return JSON.parse(raw) as TeamState
}

describe("blind state write lost update (finding: blind-state-write-lost-update)", () => {
    test("a stale-snapshot save must not clobber a concurrent writer's on-disk mutation", async () => {
        const root = tmpRoot("blind-write")
        const sid = "ses_blind"
        const dir = teamDir(root, "alpha", sid)

        // --- Seed: team with alice + bob, both idle. ---
        const seedState = makeState("alpha", sid, [makeMember("alice"), makeMember("bob")])
        await initTeamState(root, seedState, sid)

        // --- Capture the stale snapshot for Writer B BEFORE A's mutation.
        //     B's snapshot is a deep clone of the seed (alice=idle, bob=idle). ---
        const staleStateB: TeamState = JSON.parse(JSON.stringify(seedState))
        const teamB = makeStandaloneTeam(dir, staleStateB)

        // --- Writer A: mutate alice → errored and save to disk. ---
        //     (Simulates process A completing a state transition.)
        const teamA = makeStandaloneTeam(dir, seedState)
        teamA.members.find(m => m.name === "alice")!.status = "errored"
        teamA.members.find(m => m.name === "alice")!.error = "crashed"
        await saveTeamState(teamA)

        // Sanity: A's write landed on disk.
        const afterA = await readDiskState(dir)
        expect(afterA.members.find(m => m.name === "alice")!.status).toBe("errored")

        // --- Writer B: its in-memory snapshot is STALE (alice=idle — captured
        //     before A's write). B mutates bob → running and saves. ---
        teamB.members.find(m => m.name === "bob")!.status = "running"
        await saveTeamState(teamB)

        // --- ASSERT: BOTH writers' mutations must survive on disk. ---
        // On UNFIXED code: B's blind write serialized its whole stale snapshot
        // (alice=idle) → clobbered A's alice=errored → FAILS here.
        // On FIXED code (read-merge-write under the lock): B re-read inside the
        // lock, saw alice=errored, preserved it, applied bob=running → PASSES.
        const final = await readDiskState(dir)
        expect(final.members.find(m => m.name === "alice")!.status).toBe("errored")
        expect(final.members.find(m => m.name === "bob")!.status).toBe("running")
    })

    test("merged removals are synchronized back into the stale live object", async () => {
        const root = tmpRoot("live-sync-removals")
        const sid = "ses_live_sync_removals"
        const dir = teamDir(root, "alpha", sid)
        const seedState = makeState("alpha", sid, [makeMember("alice"), makeMember("bob")])
        seedState.lastInterruptedTask = makeTask({ runId: "run-checkpoint" })
        seedState.activeTask = makeTask({
            runId: "run-active",
            responses: { alice: "kept", bob: "removed" },
        })
        await initTeamState(root, seedState, sid)

        const teamA = makeStandaloneTeam(dir, seedState)
        const teamB = makeStandaloneTeam(dir, seedState)
        teamA.lastInterruptedTask = undefined
        teamA.members = teamA.members.filter(member => member.name !== "bob")
        delete teamA.activeTask!.responses.bob
        await saveTeamState(teamA)

        await saveTeamState(teamB)

        expect(teamB.lastInterruptedTask).toBeUndefined()
        expect(teamB.members.map(member => member.name)).toEqual(["alice"])
        expect(teamB.activeTask!.responses).toEqual({ alice: "kept" })
    })

    test("concurrent messagesSent increments are merged as ancestor deltas", async () => {
        const root = tmpRoot("messages-sent-delta")
        const sid = "ses_messages_sent_delta"
        const dir = teamDir(root, "alpha", sid)
        const seedState = makeState("alpha", sid)
        seedState.activeTask = makeTask({ runId: "run-messages", messagesSent: 10 })
        await initTeamState(root, seedState, sid)

        const teamA = makeStandaloneTeam(dir, seedState)
        const teamB = makeStandaloneTeam(dir, seedState)
        teamA.activeTask!.messagesSent += 1
        await saveTeamState(teamA)
        teamB.activeTask!.messagesSent += 1
        await saveTeamState(teamB)

        const persisted = await readDiskState(dir)
        expect(persisted.activeTask!.messagesSent).toBe(12)
    })
})

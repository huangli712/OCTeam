/**
 * Regression tests for a concurrency bug: deleted team directories were
 * unconditionally resurrected by racing event-handler write paths.
 *
 * Root cause: loadTeamState returns the SAME in-memory Team reference to every
 * caller (registry cache). A handler can register the Team, then lose the mutex
 * race to team_delete (which rm -rf's the dir + invalidateTeam). When the
 * handler finally acquires the mutex and runs processIdle, the unconditional
 * saveTeamState -> atomicWrite -> mkdir({recursive:true}) recreates the
 * just-deleted directory (+ state.json). captureMemberOutput, recordEvent, and
 * persistRun have the same flaw.
 *
 * Fix: a runtime `deleted` tombstone on the Team object, set FIRST inside the
 * delete mutex. processIdle and saveTeamState check it at the top and bail
 * before any persistence. stripRuntimeFields excludes `deleted` so the tombstone
 * is never persisted to state.json (which would brick the team on reload).
 *
 * These tests reproduce the race deterministically and verify every resurrecting
 * write path is covered.
 */

import { access, readFile } from "node:fs/promises"
import { rmSync } from "node:fs"

import { afterEach, describe, expect, mock, test } from "bun:test"

import type { ActiveTask, MemberState } from "../src/core/types.js"
import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import { deletedMarkerPath, runEventsPath, runsDir, runDir, runMemberOutputPath, statePath } from "../src/state/paths.js"
import {
    deleteQuarantinedTeamStorage,
    initTeamState,
    invalidateTeam,
    loadTeamState,
    quarantineTeamStorage,
    saveTeamState,
} from "../src/state/store.js"
import { teamDir } from "../src/state/paths.js"
import { teamDeleteTool } from "../src/tools/lifecycle/delete.js"
import { makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"

/** True iff no entry exists at `p` (resolves ENOENT as absent). */
async function absent(p: string): Promise<boolean> {
    try {
        await access(p)
        return false
    } catch {
        return true
    }
}


/** Synthetic master member (mirrors hooks.ts masterPseudoMember, not exported). */
function masterMember(): MemberState {
    return { name: "master", isMaster: true, status: "idle", initialized: true, turnCount: 0 }
}

/** Minimal active parallel task so processIdle's captureMemberOutput/recordEvent
 *  paths are reachable (exercising the full set of resurrecting writes). */
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
        runId: "run-tomb-test",
    } as ActiveTask
}

// tmp roots created across tests; cleaned once at suite end.
const roots: string[] = []
afterEach(() => {
    for (const r of roots.splice(0)) {
        try {
        rmSync(r, { recursive: true, force: true })
        } catch {
            // best-effort
        }
    }
})

// --- main race (integration) ---

describe("processIdle does not resurrect a just-deleted team dir", () => {
    test("handler holds team ref → delete completes → processIdle no-ops; state.json/runs/events.jsonl absent", async () => {
        const root = tmpRoot("tomb-1")
        roots.push(root)
        const sid = "ses_t1_master"
        const memberSession = "ses_t1_alice"
        const ctx = makeCtx({ storageRoot: root })

        // Live team with one initialized member that has a sessionId (so the
        // member-idle path would reach saveTeamState at idle.ts:134 even
        // without an activeTask; an activeTask is set to also exercise the
        // captureMemberOutput/recordEvent paths).
        const alice = { ...makeMember("alice", memberSession), initialized: true }
        const state = makeState("alpha", sid, [alice], Date.now())
        const team = await initTeamState(root, state, sid)
        await team.mutex.runExclusive(async () => {
            team.activeTask = parallelTask()
            alice.status = "running"
            await saveTeamState(team)
        })

        // `team` is the handler's ref (same registry object the delete tool will
        // load). Run delete to completion: tombstone set, dir rm -rf'd, registry
        // invalidated. The `team` local still holds the (now deleted=true) ref.
        const deleteTool = teamDeleteTool(ctx)
        const result = await deleteTool.execute({ team_id: "alpha" }, makeToolContext(sid))
        expect(result).toContain("deleted")
        expect(team.deleted).toBe(true)

        // The race: handler acquires the mutex AFTER delete released it and calls
        // processIdle on the stale ref. Before the fix this recreated state.json
        // via saveTeamState → atomicWrite → mkdir({recursive:true}).
        const liveAlice = team.members.find(m => m.name === "alice")!
        await team.mutex.runExclusive(async () => {
            await processIdle(ctx, team, liveAlice, memberSession)
        })

        // CRITICAL: assert ALL three resurrecting targets are absent, not just
        // state.json. The original bug was missed because tests only checked
        // state.json; captureMemberOutput + recordEvent resurrect runs/ and
        // events.jsonl through the same mkdir mechanism.
        const dir = teamDir(root, "alpha", sid)
        expect(await absent(statePath(dir))).toBe(true)
        expect(await absent(runsDir(dir))).toBe(true)
        // The specific runId subdir and events file are also gone:
        expect(await absent(runDir(dir, "run-tomb-test"))).toBe(true)
        expect(await absent(runEventsPath(dir, "run-tomb-test"))).toBe(true)
        expect(await absent(runMemberOutputPath(dir, "run-c1-test", "alice"))).toBe(true)
    })
})

// --- saveTeamState guard (unit, covers handleStatusEvent path) ---

describe("saveTeamState guard skips persistence for tombstoned team", () => {
    test("team.deleted=true → saveTeamState no-ops; state.json is NOT recreated", async () => {
        const root = tmpRoot("c1-t2")
        roots.push(root)
        const sid = "ses_t2_master"

        const team = await initTeamState(root, makeState("alpha", sid, [makeMember("alice")], Date.now()), sid)
        const dir = team.directory

        // Simulate the post-delete filesystem state: dir removed, but the
        // in-memory Team ref (held by a racing handleStatusEvent caller) still
        // exists with the tombstone set.
        const { rmSync } = require("node:fs")
        rmSync(dir, { recursive: true, force: true })
        team.deleted = true

        // handleStatusEvent (handlers.ts:348,356,408,412) reaches saveTeamState
        // via a path processIdle's guard does NOT cover. This guard is the
        // defense-in-depth chokepoint for every non-processIdle save site.
        await saveTeamState(team)

        expect(await absent(statePath(dir))).toBe(true)
    })
})

// --- stripRuntimeFields excludes `deleted` (integration) ---

describe("stripRuntimeFields never persists the tombstone to state.json", () => {
    test("team.deleted=true + saveTeamState → state.json has NO `deleted` key (anti-bricking)", async () => {
        const root = tmpRoot("c1-t3")
        roots.push(root)
        const sid = "ses_t3_master"

        // Scenario: delete ran, set the tombstone, but deleteTeamStorage's rm
        // FAILED (best-effort swallow) so the dir + state.json survive. A racing
        // handler then calls saveTeamState on the tombstoned ref. Without Mod 2
        // (stripRuntimeFields excluding `deleted`), state.json would be written
        // WITH `deleted:true`, and the next loadTeamState would rebuild a Team
        // with deleted===true — permanently bricking the team (processIdle /
        // saveTeamState early-return forever).
        const team = await initTeamState(root, makeState("alpha", sid, [makeMember("alice")], Date.now()), sid)
        team.deleted = true
        await saveTeamState(team)

        const raw = await readFile(statePath(team.directory), "utf8")
        const persisted = JSON.parse(raw) as Record<string, unknown>
        expect(persisted.deleted).toBeUndefined()
        // Sanity: the persisted fields that DO matter are still present.
        expect(persisted.teamName).toBe("alpha")
        expect(persisted.mutex).toBeUndefined()
        expect(persisted.directory).toBeUndefined()
    })
})

// --- force-delete mid-orchestration (integration) ---

describe("force-delete of a busy team → subsequent handler processIdle is a no-op", () => {
    test("busy team with activeTask + running member → team_delete(force) → processIdle → no resurrection", async () => {
        const root = tmpRoot("c1-t4")
        roots.push(root)
        const sid = "ses_t4_master"
        const memberSession = "ses_t4_alice"
        const abort = mock(async (_req: unknown) => {})
        const ctx = makeCtx({ storageRoot: root, abort })

        // Build a BUSY team with an active parallel task and a running member
        // (the force-delete mid-orchestration scenario). The delete tool's busy
        // branch aborts the session, clears activeTask, and flips status — all
        // in memory, intentionally NOT persisted.
        const alice = { ...makeMember("alice", memberSession), initialized: true, status: "running" as const }
        const state = makeState("alpha", sid, [alice], Date.now())
        state.status = "busy"
        const team = await initTeamState(root, state, sid)
        await team.mutex.runExclusive(async () => {
            team.activeTask = parallelTask()
            await saveTeamState(team)
        })

        const deleteTool = teamDeleteTool(ctx)
        const result = await deleteTool.execute({ team_id: "alpha", force: true }, makeToolContext(sid))
        expect(result).toContain("deleted")
        expect(result).toContain("forced")
        expect(team.deleted).toBe(true)

        // A dispatch/tollgate handler that registered the Team before the delete
        // and acquires the mutex after it calls processIdle here. The tombstone
        // (set FIRST inside the delete mutex) is visible on the same ref.
        const liveAlice = team.members.find(m => m.name === "alice")!
        await team.mutex.runExclusive(async () => {
            await processIdle(ctx, team, liveAlice, memberSession)
        })

        const dir = teamDir(root, "alpha", sid)
        expect(await absent(statePath(dir))).toBe(true)
        expect(await absent(runsDir(dir))).toBe(true)
        expect(await absent(runEventsPath(dir, "run-c1-test"))).toBe(true)
    })
})

// --- master idle path race (unit) ---

describe("master idle event during master-team delete → processIdle no-ops via tombstone", () => {
    test("master pseudo-member processIdle on deleted team → guard fires before master branch", async () => {
        const root = tmpRoot("c1-t5")
        roots.push(root)
        const sid = "ses_t5_master"
        const ctx = makeCtx({ storageRoot: root })

        // hooks.ts:85-94 drains every team a master session owns on idle via
        // processIdle(ctx, team, masterPseudoMember(), sessionID). The master
        // branch (Step 0) calls deliverQueuedResultsToMaster BEFORE any save,
        // but the tombstone guard at the top of processIdle fires even earlier,
        // so the master branch (and every downstream write) is skipped.
        const team = await initTeamState(root, makeState("alpha", sid, [], Date.now()), sid)
        const dir = team.directory
        const { rmSync } = require("node:fs")
        rmSync(dir, { recursive: true, force: true })
        team.deleted = true

        await team.mutex.runExclusive(async () => {
            await processIdle(ctx, team, masterMember(), sid)
        })

        // No resurrection: the guard returned before deliverQueuedResultsToMaster
        // or any save path could touch the filesystem.
        expect(await absent(statePath(dir))).toBe(true)
    })
})

// --- self-heal on registry rebuild (integration) ---

describe("tombstone does not survive a registry rebuild (self-heal)", () => {
    test("deleted=true → saveTeamState → invalidateTeam → reload yields deleted===undefined", async () => {
        const root = tmpRoot("c1-t6")
        roots.push(root)
        const sid = "ses_t6_master"

        // deleteTeamStorage is best-effort: if rm fails, the dir + state.json
        // survive. invalidateTeam still runs, so the next loadTeamState rebuilds
        // the Team from disk. Because stripRuntimeFields excluded `deleted` at
        // save time, state.json carries no tombstone, and the rebuilt Team has
        // deleted === undefined — the team self-heals instead of bricking.
        const team = await initTeamState(root, makeState("alpha", sid, [makeMember("alice")], Date.now()), sid)
        team.deleted = true
        await saveTeamState(team)
        expect(team.deleted).toBe(true)

        invalidateTeam(team.directory)

        const reloaded = await loadTeamState(root, "alpha", sid)
        expect(reloaded.deleted).toBeUndefined()
        // Fresh mutex/directory, same identity fields.
        expect(reloaded.teamName).toBe("alpha")
        expect(reloaded.leadSessionId).toBe(sid)
    })
})

describe("deletion markers are scoped to a team run", () => {
    test("a replacement team removes the previous run's marker and persists its first save", async () => {
        const root = tmpRoot("s3-marker-generation")
        roots.push(root)
        const sid = "ses_s3_marker_generation"
        const originalState = makeState("alpha", sid, [makeMember("alice")])
        const original = await initTeamState(root, originalState, sid)
        const dir = original.directory
        const marker = deletedMarkerPath(dir)

        const quarantineDirectory = await quarantineTeamStorage(
            root,
            "alpha",
            sid,
            dir,
            original.teamRunId,
        )
        expect(await readFile(marker, "utf8")).toBe(original.teamRunId)
        await deleteQuarantinedTeamStorage(root, quarantineDirectory)
        invalidateTeam(dir)

        const replacementState = makeState("alpha", sid, [makeMember("alice")])
        replacementState.teamRunId = `${original.teamRunId}-replacement`
        const replacement = await initTeamState(root, replacementState, sid)
        replacement.status = "idle"
        await saveTeamState(replacement)

        expect(replacement.deleted).toBeUndefined()
        expect(await absent(marker)).toBe(true)
        const persisted = JSON.parse(await readFile(statePath(dir), "utf8")) as Record<string, unknown>
        expect(persisted.status).toBe("idle")
    })
})

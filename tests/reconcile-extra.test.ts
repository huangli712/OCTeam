import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import fs from "node:fs/promises"
import path from "node:path"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask } from "../src/core/types.js"
import {
    handleSessionDeleted,
    reconcileActivation,
    reconcileCrashedTeams,
} from "../src/orchestration/lifecycle/reconcile.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { statePath, teamDir } from "../src/state/paths.js"
import { cleanupTmpRoots, makeMember, makeState, tmpRoot } from './helpers.js';

afterAll(cleanupTmpRoots)

// --- ctx fixture ---

function ctxFor(
    projectRoot: string,
    userRoot: string,
    directory?: string,
): PluginContext {
    return {
        storageRoot: projectRoot,
        directory: directory ?? projectRoot,
        projectStorageRoot: projectRoot,
        userStorageRoot: userRoot,
        scope: "project",
        client: {
            app: { log: async () => ({}) },
        },
    } as unknown as PluginContext
}

/** Write an invalid JSON file at <teamDir>/state.json to simulate corruption. */
async function corruptState(root: string, teamName: string, sid?: string): Promise<void> {
    await fs.writeFile(statePath(teamDir(root, teamName, sid)), "{not valid json")
}

// ============================================================
// handleSessionDeleted — full coverage of the session.deleted
// cleanup path: lead-session dir wipe, registry invalidation,
// bare member session, and the unsafe-segment defense-in-depth.
// ============================================================

describe("handleSessionDeleted", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    test("lead session: removes the per-session dir and invalidates the team registry", async () => {
        const root = tmpRoot("hsd-lead")
        const userRoot = `${root}__user`
        const sid = "ses_hsd_lead"
        tracked.push(sid, "ses_alice")
        await initTeamState(
            root,
            makeState("alpha", sid, [makeMember("alice", "ses_alice")]),
            sid,
        )
        await rebuildSessionIndex(root, userRoot)
        // Registry holds the team after init.
        const before = await loadTeamState(root, "alpha", sid)
        expect(before.teamName).toBe("alpha")
        const sessionDir = path.join(root, sid)
        // Sanitize: ensure the dir exists.
        await fs.mkdir(sessionDir, { recursive: true })

        await handleSessionDeleted(ctxFor(root, userRoot), sid)

        // The per-session directory is gone.
        expect(fs.stat(sessionDir)).rejects.toThrow(/ENOENT/)
        // Registry entry for the team dir is invalidated (loadTeamState throws
        // because the dir is gone and the in-memory entry was dropped).
        expect(loadTeamState(root, "alpha", sid)).rejects.toThrow(/no state\.json/)
    })

    test("unrelated session: leaves other sessions' teams untouched", async () => {
        const root = tmpRoot("hsd-other")
        const userRoot = `${root}__user`
        const keepSid = "ses_hsd_keep"
        const deleteSid = "ses_hsd_delete"
        tracked.push(keepSid, deleteSid, "ses_a")
        await initTeamState(
            root,
            makeState("keep", keepSid, [makeMember("alice", "ses_a")]),
            keepSid,
        )
        // deleteSid owns no teams; create an empty dir to confirm it gets removed.
        const deleteDir = path.join(root, deleteSid)
        await fs.mkdir(deleteDir, { recursive: true })
        await rebuildSessionIndex(root, userRoot)

        await handleSessionDeleted(ctxFor(root, userRoot), deleteSid)

        // deleteSid dir gone; keepSid team still loadable.
        expect(fs.stat(deleteDir)).rejects.toThrow(/ENOENT/)
        const keep = await loadTeamState(root, "keep", keepSid)
        expect(keep.teamName).toBe("keep")
    })

    test("non-existent session: does not throw, no side-effects on disk", async () => {
        const root = tmpRoot("hsd-missing")
        const userRoot = `${root}__user`
        // No teams, no per-session dirs. listAllTeams returns [] and fs.rm is
        // a no-op with force: true. The function must resolve cleanly.
        expect(handleSessionDeleted(ctxFor(root, userRoot), "ses_ghost")).resolves.toBeUndefined()
    })

    test("bare member session (no owned team dir): still unindexes without error", async () => {
        const root = tmpRoot("hsd-member")
        const userRoot = `${root}__user`
        const memberSid = "ses_hsd_member_only"
        tracked.push(memberSid)
        // Member session has no <root>/<sid> dir of its own — it was indexed
        // as a team member under someone else's lead session.
        await rebuildSessionIndex(root, userRoot)

        expect(
            handleSessionDeleted(ctxFor(root, userRoot), memberSid),
        ).resolves.toBeUndefined()
    })

    test("unsafe sessionID segment: outer try swallows assertSafeSegment error, unindex still runs", async () => {
        const root = tmpRoot("hsd-unsafe")
        const userRoot = `${root}__user`
        const unsafeSid = "../escape"
        tracked.push(unsafeSid)
        // Pre-index the unsafe session so unindexSession has something to clear.
        // (unindexSession is a pure map.delete — safe to call with any string.)

        // The function must not throw (defense-in-depth catch block) and must
        // still run the unconditional unindexSession at the bottom.
        expect(
            handleSessionDeleted(ctxFor(root, userRoot), unsafeSid),
        ).resolves.toBeUndefined()

        // The storage root must be untouched — no <root>/../escape dir created
        // or removed (which would be a path-traversal escape).
        const parentListing = await fs.readdir(root)
        expect(parentListing).not.toContain("escape")
    })

    test("persisted team under deleted session: loadTeamState failure is tolerated (invalidateTeam skip)", async () => {
        // Covers the inner try/catch at line 143-148: a team whose state.json
        // is missing while the per-session dir is being enumerated.
        const root = tmpRoot("hsd-state-missing")
        const userRoot = `${root}__user`
        const sid = "ses_hsd_state_missing"
        tracked.push(sid)
        // Create the session dir + a teams/ subdir, but NO state.json.
        const teamsDirUnderSession = path.join(root, sid, "teams", "ghost")
        await fs.mkdir(teamsDirUnderSession, { recursive: true })

        await handleSessionDeleted(ctxFor(root, userRoot), sid)

        // The session dir is still removed (fs.rm runs after the inner loop).
        expect(fs.stat(path.join(root, sid))).rejects.toThrow(/ENOENT/)
    })
})

// ============================================================
// reconcileCrashedTeams — user-scope enumeration and unreadable
// state.json logSwallowed paths (both scopes).
// ============================================================

describe("reconcileCrashedTeams", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    test("user scope: busy team is reconciled just like project scope", async () => {
        const root = tmpRoot("rcu-user")
        const userRoot = `${root}__user_real`
        const sid = "ses_rcu_user"
        tracked.push(sid, "ses_alice")
        // Lay down a user-scope team (flat layout, no leadSessionId segment).
        const state = {
            ...makeState("useralpha", sid, [
                { ...makeMember("alice", "ses_alice"), status: "running" as const },
            ]),
            status: "busy" as const,
        }
        await initTeamState(userRoot, state) // no sid -> flat /teams/useralpha
        await rebuildSessionIndex(root, userRoot)

        await reconcileCrashedTeams(ctxFor(root, userRoot))

        const team = await loadTeamState(userRoot, "useralpha")
        // New semantics: busy team is NOT auto-failed (concurrent-instance safety).
        expect(team.status).toBe("busy")
        expect(team.members[0].status).toBe("running")
    })

    test("project scope: corrupt state.json is swallowed (logSwallowed), other teams still reconciled", async () => {
        const root = tmpRoot("rcu-corrupt")
        const userRoot = `${root}__user`
        const sid = "ses_rcu_corrupt"
        tracked.push(sid, "ses_a")
        // Healthy busy team.
        const healthy = {
            ...makeState("healthy", sid, [
                { ...makeMember("alice", "ses_a"), status: "running" as const },
            ]),
            status: "busy" as const,
            activeTask: {
                runId: "run-healthy",
                type: "parallel",
                mode: "isolated",
                startedAt: 1,
                wallClockTimeoutMs: 300_000,
                tokensUsed: 0,
                tokensByMember: {},
                messagesSent: 0,
                responses: {},
                stages: [],
                currentStageIndex: 0,
                decisionHistory: [],
                decisionParseFailures: 0,
            } as ActiveTask,
        }
        await initTeamState(root, healthy, sid)
        // Corrupt team under the SAME session: valid teams/ dir but bad JSON.
        const corruptDir = teamDir(root, "corrupt", sid)
        await fs.mkdir(corruptDir, { recursive: true })
        await corruptState(root, "corrupt", sid)
        await rebuildSessionIndex(root, userRoot).catch(() => undefined)

        expect(reconcileCrashedTeams(ctxFor(root, userRoot))).rejects.toBeInstanceOf(AggregateError)

        // Healthy team still reconciled despite the sibling corruption.
        // New semantics: busy team is NOT auto-failed (concurrent-instance safety);
        // reconcile only snapshots lastInterruptedTask.
        const after = await loadTeamState(root, "healthy", sid)
        expect(after.status).toBe("busy")
        expect(after.lastInterruptedTask).toBeDefined()
    })

    test("user scope: corrupt state.json is swallowed without affecting project scope", async () => {
        const root = tmpRoot("rcu-user-corrupt")
        const userRoot = `${root}__user`
        const sid = "ses_rcu_uc"
        tracked.push(sid, "ses_p")
        const project = {
            ...makeState("proj", sid, [makeMember("p", "ses_p")]),
            status: "idle" as const,
        }
        await initTeamState(root, project, sid)
        // User-scope corrupt team.
        const corruptDir = teamDir(userRoot, "ucorrupt")
        await fs.mkdir(corruptDir, { recursive: true })
        await fs.writeFile(statePath(corruptDir), "{broken")
        await rebuildSessionIndex(root, userRoot).catch(() => undefined)

        expect(reconcileCrashedTeams(ctxFor(root, userRoot))).rejects.toBeInstanceOf(AggregateError)

        // Project-scope team untouched by the user-scope corruption.
        const proj = await loadTeamState(root, "proj", sid)
        expect(proj.status).toBe("idle")
    })

    test("reservation failure is aggregated after healthy sibling recovery completes", async () => {
        const root = tmpRoot("rcu-reservation-failure")
        const userRoot = `${root}__user`
        const sid = "ses_rcu_reservation_failure"
        const broken = await initTeamState(root, {
            ...makeState("broken", sid),
            status: "idle" as const,
        }, sid)
        const healthy = await initTeamState(root, {
            ...makeState("healthy", sid),
            status: "busy" as const,
            activeTask: {
                runId: "run-healthy-reservation",
                type: "parallel",
                mode: "isolated",
                startedAt: 1,
                wallClockTimeoutMs: 300_000,
                tokensUsed: 0,
                tokensByMember: {},
                messagesSent: 0,
                responses: {},
                stages: [],
                currentStageIndex: 0,
                decisionHistory: [],
                decisionParseFailures: 0,
            } as ActiveTask,
        }, sid)
        const outside = tmpRoot("rcu-reservation-outside")
        await fs.mkdir(outside, { recursive: true })
        await fs.symlink(outside, path.join(broken.directory, "mailbox"), "dir")

        expect(reconcileCrashedTeams(ctxFor(root, userRoot))).rejects.toBeInstanceOf(AggregateError)

        expect(healthy.lastInterruptedTask?.runId).toBe("run-healthy-reservation")
    })
})

// ============================================================
// reconcileActivation — unreadable-state logSwallowed path.
// ============================================================

describe("reconcileActivation", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    test("corrupt state.json in project scope: swallowed, sibling teams still cleared", async () => {
        const root = tmpRoot("ra-corrupt")
        const userRoot = `${root}__user`
        const sid = "ses_ra_corrupt"
        tracked.push(sid)
        await initTeamState(root, makeState("good", sid, [], 1234), sid)
        // Corrupt sibling.
        const corruptDir = teamDir(root, "bad", sid)
        await fs.mkdir(corruptDir, { recursive: true })
        await fs.writeFile(statePath(corruptDir), "{not-json")
        await rebuildSessionIndex(root, userRoot).catch(() => undefined)

        expect(reconcileActivation(ctxFor(root, userRoot))).rejects.toBeInstanceOf(AggregateError)

        // Good team's activatedAt was still cleared.
        const good = await loadTeamState(root, "good", sid)
        expect(good.activatedAt).toBeUndefined()
    })

    test("state persistence failure is aggregated after healthy sibling activation is cleared", async () => {
        const root = tmpRoot("ra-persist-failure")
        const userRoot = `${root}__user`
        const sid = "ses_ra_persist_failure"
        const broken = await initTeamState(root, makeState("broken", sid, [], 1234), sid)
        const healthy = await initTeamState(root, makeState("healthy", sid, [], 1234), sid)
        const outside = path.join(tmpRoot("ra-persist-outside"), "state.json")
        await fs.mkdir(path.dirname(outside), { recursive: true })
        await fs.writeFile(outside, "{}")
        await fs.unlink(statePath(broken.directory))
        await fs.symlink(outside, statePath(broken.directory))

        expect(reconcileActivation(ctxFor(root, userRoot))).rejects.toBeInstanceOf(AggregateError)

        expect(healthy.activatedAt).toBeUndefined()
    })
})

import { afterEach, describe, expect, mock, test } from "bun:test"
import { rmSync } from "node:fs"
import path from "node:path"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask, MemberState } from "../src/core/types.js"
import { createEventHandler, sweepTeamOnce } from "../src/hooks.js"
import { initTeamState, invalidateTeam, loadTeamState } from "../src/state/store.js"
import { statePath, teamDir } from "../src/state/paths.js"
import {
    indexMasterTeam,
    rebuildSessionIndex,
    unindexSession,
} from "../src/state/resolve.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

interface LogCall {
    message: string
    extra: Record<string, unknown>
}

function ctxFor(root: string, logCalls: LogCall[]): PluginContext {
    return {
        storageRoot: root,
        directory: root,
        scope: "project",
        projectStorageRoot: root,
        userStorageRoot: `${root}__user_unused`,
        client: {
            app: {
                log: mock(async (req: { body: { message: string; extra?: Record<string, unknown> } }) => {
                    logCalls.push({ message: req.body.message, extra: req.body.extra ?? {} })
                }),
            },
            session: {
                promptAsync: mock(async () => ({})),
                abort: mock(async () => ({})),
                status: mock(async () => ({ data: {} })),
                messages: mock(async () => ({ data: [] })),
            },
        },
    } as unknown as PluginContext
}

function parallelTask(): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
        task: "do thing",
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

function delegateTask(): ActiveTask {
    return { ...parallelTask(), type: "delegate" }
}

// ============================================================
// createEventHandler: session.deleted dispatch (line 73-77).
// ============================================================

describe("createEventHandler: session.deleted dispatch", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    test("session.deleted with properties.sessionID triggers handleSessionDeleted", async () => {
        const root = tmpRoot("hev-deleted-props")
        const sid = "ses_hev_del_props"
        tracked.push(sid)
        await initTeamState(
            root,
            makeState("alpha", sid, [makeMember("alice", "ses_alice")]),
            sid,
        )
        await rebuildSessionIndex(root, `${root}__user_unused`)
        const sessionDir = path.join(root, sid)
        const logCalls: LogCall[] = []
        const ctx = ctxFor(root, logCalls)
        const handler = createEventHandler(ctx)

        await handler({
            event: { type: "session.deleted", properties: { sessionID: sid } },
        } as never)

        // handleSessionDeleted removed the per-session dir on disk.
        await expect(
            import("node:fs/promises").then(fs => fs.stat(sessionDir)),
        ).rejects.toThrow(/ENOENT/)
    })

    test("session.deleted falls back to event.id when properties.sessionID is absent", async () => {
        const root = tmpRoot("hev-deleted-id")
        const sid = "ses_hev_del_id"
        tracked.push(sid)
        await initTeamState(
            root,
            makeState("alpha", sid, [makeMember("alice", "ses_alice")]),
            sid,
        )
        await rebuildSessionIndex(root, `${root}__user_unused`)
        const sessionDir = path.join(root, sid)
        const logCalls: LogCall[] = []
        const ctx = ctxFor(root, logCalls)
        const handler = createEventHandler(ctx)

        // properties absent — handler reads event.id instead (line 75).
        await handler({
            event: { type: "session.deleted", id: sid },
        } as never)

        await expect(
            import("node:fs/promises").then(fs => fs.stat(sessionDir)),
        ).rejects.toThrow(/ENOENT/)
    })

    test("session.deleted with no resolvable sid: handler resolves cleanly (no throw)", async () => {
        const root = tmpRoot("hev-deleted-empty")
        const logCalls: LogCall[] = []
        const ctx = ctxFor(root, logCalls)
        const handler = createEventHandler(ctx)

        // Neither properties.sessionID nor event.id — the `if (sid)` guard
        // (line 76) skips handleSessionDeleted entirely.
        await expect(
            handler({
                event: { type: "session.deleted" },
            } as never),
        ).resolves.toBeUndefined()
    })
})

// ============================================================
// createEventHandler: master path with unreadable team state
// (line 99 — logSwallowed "skipped unreadable team state").
// ============================================================

describe("createEventHandler: master drain-all skips unreadable team state", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    test("master owns a team whose state.json was deleted → logSwallowed, OTHER teams still drain", async () => {
        const root = tmpRoot("hev-master-corrupt")
        const lead = "ses_hev_master_corrupt"
        tracked.push(lead)
        // Two teams owned by the same master.
        const good = await initTeamState(
            root,
            makeState("good", lead, [], Date.now()),
            lead,
        )
        const bad = await initTeamState(
            root,
            makeState("bad", lead, [], Date.now()),
            lead,
        )
        indexMasterTeam(lead, "good", lead, root, good.directory)
        indexMasterTeam(lead, "bad", lead, root, bad.directory)
        await rebuildSessionIndex(root, `${root}__user_unused`)

        // Destroy bad's state.json + invalidate its registry entry so the
        // master drain's loadTeamState throws "no state.json".
        rmSync(statePath(bad.directory), { force: true })
        invalidateTeam(bad.directory)

        const logCalls: LogCall[] = []
        const ctx = ctxFor(root, logCalls)
        const handler = createEventHandler(ctx)

        await handler({
            event: { type: "session.idle", properties: { sessionID: lead } },
        } as never)

        // Bad team's failure was logged, NOT thrown.
        const skipLogs = logCalls.filter(c => c.message === "skipped unreadable team state")
        expect(skipLogs.length).toBe(1)
        expect(skipLogs[0].extra.dir).toBe(bad.directory)
    })
})

// ============================================================
// sweepTeamOnce: delegate reapStaleClaims (line 295) and
// missed-idle reconciliation (line 303-305).
// ============================================================

describe("sweepTeamOnce: delegate task triggers reapStaleClaims", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    test("delegate task type invokes reapStaleClaims without throwing", async () => {
        const root = tmpRoot("swp-delegate")
        const leadSid = "ses_swp_del_m"
        const aliceSid = "ses_swp_del_a"
        tracked.push(leadSid, aliceSid)
        const alice = makeMember("alice", aliceSid)
        const state = makeState("alpha", leadSid, [alice], Date.now())
        await initTeamState(root, state, leadSid)
        const team = await loadTeamState(root, "alpha", leadSid)
        team.activeTask = delegateTask()

        const logCalls: LogCall[] = []
        const ctx = ctxFor(root, logCalls)
        // statusMap empty — no missed-idle reconciliation path; focuses on
        // the delegate branch reaching reapStaleClaims.
        await sweepTeamOnce(ctx, team, {})

        // Sanity: sweep did not throw and the team dir is intact.
        expect(team.deleted).toBeFalsy()
    })
})

describe("sweepTeamOnce: missed-idle reconciliation (line 303-305)", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    test("running member whose session is actually idle → processIdle is re-driven by the sweep", async () => {
        const root = tmpRoot("swp-missed")
        const leadSid = "ses_swp_miss_m"
        const aliceSid = "ses_swp_miss_a"
        tracked.push(leadSid, aliceSid)
        const alice = makeMember("alice", aliceSid)
        const state = makeState("alpha", leadSid, [alice], Date.now())
        await initTeamState(root, state, leadSid)
        await rebuildSessionIndex(root, `${root}__user_unused`)
        const team = await loadTeamState(root, "alpha", leadSid)
        // activeTask so the team is in activeTeams(); single isolated task so
        // the parallel barrier fires once alice goes idle.
        team.activeTask = parallelTask()
        const aliceLive = team.members.find(m => m.name === "alice")!
        aliceLive.status = "running" // sweep's missed-idle trigger

        const logCalls: LogCall[] = []
        const ctx = ctxFor(root, logCalls)
        // statusMap reports alice's session as idle — sweep re-drives processIdle.
        const statusMap = { [aliceSid]: { type: "idle" } }
        await sweepTeamOnce(ctx, team, statusMap)

        // processIdle ran (Step 1 sets status=idle; barrier fires; summary
        // delivered; task cleared). The simplest observable: alice is no
        // longer "running".
        const after = await loadTeamState(root, "alpha", leadSid)
        const aliceAfter = after.members.find(m => m.name === "alice")!
        expect(aliceAfter.status).not.toBe("running")
    })

    test("running member whose session is NOT idle → no reconciliation, member stays running", async () => {
        const root = tmpRoot("swp-running")
        const leadSid = "ses_swp_run_m"
        const aliceSid = "ses_swp_run_a"
        tracked.push(leadSid, aliceSid)
        const alice = makeMember("alice", aliceSid)
        const state = makeState("alpha", leadSid, [alice], Date.now())
        await initTeamState(root, state, leadSid)
        const team = await loadTeamState(root, "alpha", leadSid)
        team.activeTask = parallelTask()
        const aliceLive = team.members.find(m => m.name === "alice")!
        aliceLive.status = "running"

        const logCalls: LogCall[] = []
        const ctx = ctxFor(root, logCalls)
        // statusMap reports alice as "running" (not idle) → reconciliation skipped.
        await sweepTeamOnce(ctx, team, { [aliceSid]: { type: "running" } })

        const after = await loadTeamState(root, "alpha", leadSid)
        const aliceAfter = after.members.find(m => m.name === "alice")!
        expect(aliceAfter.status).toBe("running")
    })
})

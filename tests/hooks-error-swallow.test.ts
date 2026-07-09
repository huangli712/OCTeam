/**
 * Regression tests for bug H1: the event handler in src/hooks.ts had two paths
 * (session.status at :62, member-idle at :102-118) with NO top-level try/catch.
 * A throw from handleStatusEvent, loadTeamState (deleted team), or processIdle
 * would reject the event-handler promise and poison subsequent event handling
 * (the "stall family"). The master path (:85-100) already had try/catch.
 *
 * Fix: both paths now wrap their work in try/catch + logSwallowed, mirroring
 * the master path. resolveTeamMember stays OUTSIDE the try so the common
 * "not a member" case stays silent.
 */
import { rmSync } from "node:fs"

import { afterAll, describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import { createEventHandler } from "../src/hooks.js"
import { statePath } from "../src/state/paths.js"
import { indexMember, unindexSession } from "../src/state/resolve.js"
import { initTeamState, invalidateTeam } from "../src/state/store.js"
import { cleanupTmpRoots, makeMember, makeState, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

interface LogCall {
    message: string
    extra: Record<string, unknown>
}

function ctxFor(root: string, logCalls: LogCall[]): PluginContext {
    return {
        storageRoot: root,
        directory: root,
        scope: "project",
        client: {
            app: {
                log: mock(async (req: { body: { message: string; extra?: Record<string, unknown> } }) => {
                    logCalls.push({ message: req.body.message, extra: req.body.extra ?? {} })
                }),
            },
            session: {
                promptAsync: mock(async () => {}),
                abort: mock(async () => {}),
                messages: mock(async () => ({ data: [] })),
            },
        },
    } as unknown as PluginContext
}

describe("H1 T1: member-idle for a deleted team -> loadTeamState throws -> swallowed", () => {
    test("handler resolves; logSwallowed called with 'member-idle handler failed'", async () => {
        const root = tmpRoot("hooks-err-1")
        const lead = "ses_h1_lead"
        const memberSession = "ses_h1_alice"

        const team = await initTeamState(
            root,
            makeState("alpha", lead, [makeMember("alice", memberSession)], Date.now()),
            lead,
        )
        indexMember(memberSession, "alpha", "alice", lead, root)

        // Destroy state.json + invalidate registry so loadTeamState throws
        // "no state.json" — the post-C1 deleted-team scenario. Pre-H1 this
        // reject poisoned the host; post-H1 it is swallowed + logged.
        rmSync(statePath(team.directory), { force: true })
        invalidateTeam(team.directory)

        const logCalls: LogCall[] = []
        const ctx = ctxFor(root, logCalls)
        const handler = createEventHandler(ctx)

        // Must NOT reject.
        await handler({
            event: { type: "session.idle", properties: { sessionID: memberSession } },
        } as never)

        const failLogs = logCalls.filter(c => c.message === "member-idle handler failed")
        expect(failLogs.length).toBe(1)
        expect(failLogs[0].extra.sessionID).toBe(memberSession)

        unindexSession(memberSession)
    })
})

describe("H1 T2: non-member idle -> NO logSwallowed (common case stays silent)", () => {
    test("unknown session -> resolveTeamMember returns null -> handler returns without logging", async () => {
        const root = tmpRoot("hooks-err-2")
        const stranger = "ses_h1_stranger"

        const logCalls: LogCall[] = []
        const ctx = ctxFor(root, logCalls)
        const handler = createEventHandler(ctx)

        await handler({
            event: { type: "session.idle", properties: { sessionID: stranger } },
        } as never)

        // resolveTeamMember returned null (not a team member). This is the
        // common case. The try/catch starts AFTER `if (!member) return`, so no
        // logSwallowed fires — the common case must stay silent.
        const failLogs = logCalls.filter(c => c.message === "member-idle handler failed")
        expect(failLogs).toHaveLength(0)
    })
})

describe("H1 T3: session.status event -> handler resolves (try/catch in place)", () => {
    test("session.status for an unknown session -> handler does not reject", async () => {
        const root = tmpRoot("hooks-err-3")
        const logCalls: LogCall[] = []
        const ctx = ctxFor(root, logCalls)
        const handler = createEventHandler(ctx)

        // A session.status event. The key assertion is the handler resolves
        // without rejection regardless of whether handleStatusEvent throws
        // internally — the try/catch at hooks.ts:62 guarantees it.
        await handler({
            event: { type: "session.status", properties: { sessionID: "ses_h1_x", status: "idle" } },
        } as never)

        // Handler resolved without rejection. (We do not assert on logSwallowed
        // here because handleStatusEvent is internally defensive for unknown
        // sessions; the try/catch is the safety net for unexpected throws.)
    })
})

describe("H1 T4: member-idle with a live team does not regress (happy path)", () => {
    test("live team + member idle -> handler resolves normally, no error log", async () => {
        const root = tmpRoot("hooks-err-4")
        const lead = "ses_h1_lead4"
        const memberSession = "ses_h1_bob"

        await initTeamState(
            root,
            makeState("beta", lead, [makeMember("bob", memberSession)], Date.now()),
            lead,
        )
        indexMember(memberSession, "beta", "bob", lead, root)

        const logCalls: LogCall[] = []
        const ctx = ctxFor(root, logCalls)
        const handler = createEventHandler(ctx)

        await handler({
            event: { type: "session.idle", properties: { sessionID: memberSession } },
        } as never)

        // Happy path: no member-idle failure logged (processIdle ran cleanly,
        // saveTeamState succeeded or its own .catch handled persistence).
        const failLogs = logCalls.filter(c => c.message === "member-idle handler failed")
        expect(failLogs).toHaveLength(0)

        unindexSession(memberSession)
    })
})

import { describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import { createEventHandler } from "../src/hooks.js"
import { reconcileCrashedTeams } from "../src/orchestration/reconcile.js"
import { countUnreadMessages, writeMailboxMessage } from "../src/messaging/mailbox.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import type { ActiveTask, Message, TeamState } from "../src/core/types.js"
import { indexMasterTeam, setActiveTeam, unindexSession } from "../src/state/resolve.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

const LEAD = "ses_lead_drain"

function masterResult(id: string, body: string): Message {
    return {
        version: 1,
        id,
        from: "orchestrator",
        to: "master",
        kind: "message",
        body,
        timestamp: Date.now(),
        deliveryStatus: "pending",
    }
}

/**
 * Event handler ctx: drain-all calls processIdle's master branch, which uses
 * ctx.client.session.promptAsync. Capture the calls so we can assert each team's
 * mailbox was delivered.
 */
function ctxFor(root: string, calls: string[]): PluginContext {
    return {
        storageRoot: root,
        directory: root,
        client: {
            session: {
                promptAsync: async (req: { path: { id: string } }) => {
                    calls.push(req.path.id)
                    return {}
                },
            },
        },
    } as unknown as PluginContext
}

describe("event handler master drain-all", () => {
    test("master owning two teams drains BOTH master mailboxes on session.idle", async () => {
        const root = tmpRoot("drain-all")
        const a = await initTeamState(root, makeState("aaa", LEAD, [], Date.now()), LEAD)
        const b = await initTeamState(root, makeState("bbb", LEAD), LEAD) // inactive sibling
        indexMasterTeam(LEAD, "aaa", LEAD, root, a.directory)
        indexMasterTeam(LEAD, "bbb", LEAD, root, b.directory)
        setActiveTeam(LEAD, a.directory)

        // Queue a result in EACH team's master mailbox (drain-all is independent
        // of which team is active).
        await writeMailboxMessage(a.directory, "master", masterResult("ra", "result-a"))
        await writeMailboxMessage(b.directory, "master", masterResult("rb", "result-b"))

        const calls: string[] = []
        const handler = createEventHandler(ctxFor(root, calls))
        await handler({
            event: { type: "session.idle", properties: { sessionID: LEAD } },
        } as never)

        // Both mailboxes drained, regardless of active/inactive status.
        expect(await countUnreadMessages(a.directory, "master")).toBe(0)
        expect(await countUnreadMessages(b.directory, "master")).toBe(0)
        // Master was prompted once per team that had a queued result.
        expect(calls.filter(id => id === LEAD).length).toBe(2)

        unindexSession(LEAD)
    })

    test("single-team master still drains (no regression)", async () => {
        const root = tmpRoot("drain-single")
        const a = await initTeamState(root, makeState("solo", LEAD, [], Date.now()), LEAD)
        indexMasterTeam(LEAD, "solo", LEAD, root, a.directory)
        setActiveTeam(LEAD, a.directory)
        await writeMailboxMessage(a.directory, "master", masterResult("r1", "done"))

        const calls: string[] = []
        const handler = createEventHandler(ctxFor(root, calls))
        await handler({
            event: { type: "session.idle", properties: { sessionID: LEAD } },
        } as never)

        expect(await countUnreadMessages(a.directory, "master")).toBe(0)
        expect(calls.length).toBe(1)

        unindexSession(LEAD)
    })
})

/** Minimal ActiveTask fixture for reconcile tests. */
function makeActiveTask(overrides?: Partial<ActiveTask>): ActiveTask {
    return {
        type: "parallel",
        mode: "collaborative",
        startedAt: 1000,
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        ...overrides,
    }
}

/**
 * Reconcile ctx: reconcileCrashedTeams scans both scopes and only touches
 * ctx.client on error paths. userStorageRoot points at a non-existent dir so the
 * user-scope scan is a no-op; the team lives under project scope.
 */
function reconcileCtx(root: string): PluginContext {
    return {
        storageRoot: root,
        directory: root,
        projectStorageRoot: root,
        userStorageRoot: `${root}/__user_scope_unused__`,
        client: {
            app: { log: async () => ({}) },
        },
    } as unknown as PluginContext
}

describe("reconcileCrashedTeams preserves lastInterruptedTask (T3)", () => {
    test("busy crash: lastInterruptedTask === original activeTask; status → failed; running member → errored", async () => {
        const root = tmpRoot("reconcile-busy")
        const sid = "ses_crash_busy"
        const task = makeActiveTask({ runId: "run-x", type: "parallel" })
        const state: TeamState = {
            ...makeState("crashed", sid, [{ ...makeMember("alice", "ses_alice"), status: "running" }]),
            status: "busy",
            activeTask: task,
        }
        await initTeamState(root, state, sid)

        await reconcileCrashedTeams(reconcileCtx(root))

        const team = await loadTeamState(root, "crashed", sid)
        // Force-fail semantics unchanged.
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        expect(team.members[0].status).toBe("errored")
        // T3: the interrupted task is preserved for an explicit team_resume.
        expect(team.lastInterruptedTask).toEqual(task)
    })

    test("double crash: most-recent interrupted task overwrites the older one", async () => {
        const root = tmpRoot("reconcile-double")
        const sid = "ses_crash_double"
        const older = makeActiveTask({ runId: "run-old", type: "loop" })
        const newer = makeActiveTask({ runId: "run-new", type: "parallel" })
        const state: TeamState = {
            ...makeState("crashed2", sid, [makeMember("bob", "ses_bob")]),
            status: "busy",
            activeTask: newer,
            lastInterruptedTask: older,
        }
        await initTeamState(root, state, sid)

        await reconcileCrashedTeams(reconcileCtx(root))

        const team = await loadTeamState(root, "crashed2", sid)
        expect(team.lastInterruptedTask).toEqual(newer)
        expect(team.lastInterruptedTask?.runId).toBe("run-new")
    })

    test("idle team with no activeTask: lastInterruptedTask stays undefined", async () => {
        const root = tmpRoot("reconcile-idle")
        const sid = "ses_crash_idle"
        const state: TeamState = {
            ...makeState("idleteam", sid, [makeMember("carol", "ses_carol")]),
            status: "idle",
        }
        await initTeamState(root, state, sid)

        await reconcileCrashedTeams(reconcileCtx(root))

        const team = await loadTeamState(root, "idleteam", sid)
        expect(team.lastInterruptedTask).toBeUndefined()
        expect(team.status).toBe("idle")
    })

    test("live team is skipped entirely: lastInterruptedTask undefined, status unchanged", async () => {
        const root = tmpRoot("reconcile-live")
        const sid = "ses_crash_live"
        await initTeamState(root, makeState("liveteam", sid, [makeMember("dave", "ses_dave")]), sid)

        await reconcileCrashedTeams(reconcileCtx(root))

        const team = await loadTeamState(root, "liveteam", sid)
        expect(team.lastInterruptedTask).toBeUndefined()
        expect(team.status).toBe("live")
    })
})

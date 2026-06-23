import { describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import { createEventHandler } from "../src/hooks.js"
import { countUnreadMessages, writeMailboxMessage } from "../src/messaging/mailbox.js"
import { initTeamState } from "../src/state/store.js"
import type { Message } from "../src/core/types.js"
import { indexMasterTeam, setActiveTeam, unindexSession } from "../src/core/utils.js"
import { makeState, tmpRoot } from "./helpers.js"

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

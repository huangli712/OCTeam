import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"

import type { Message } from "../src/core/types.js"
import { createEventHandler, createTransformHook } from "../src/hooks.js"
import { writeMailboxMessage } from "../src/messaging/mailbox.js"
import { teamDir } from "../src/state/paths.js"
import { indexMember, unindexSession } from "../src/state/resolve.js"
import { initTeamState } from "../src/state/store.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"

const LEAD = "ses_p7_lead"
const MEMBER = "ses_p7_member"
const TEAM = "p7-dropped-turn"
const MEMBER_NAME = "worker"

type LogCall = {
    level: string
    message: string
    extra: Record<string, unknown>
}

function contextFor(root: string, logCalls: LogCall[]) {
    return makeCtx({
        storageRoot: root,
        directory: root,
        client: true,
        overrides: {
            client: {
                app: {
                    log: mock(async (request: {
                        body: { level: string; message: string; extra?: Record<string, unknown> }
                    }) => {
                        logCalls.push({
                            level: request.body.level,
                            message: request.body.message,
                            extra: request.body.extra ?? {},
                        })
                    }),
                },
                session: {
                    promptAsync: mock(async () => ({})),
                    abort: mock(async () => ({})),
                    messages: mock(async () => ({ data: [] })),
                },
            },
        },
    })
}

function mailboxMessage(): Message {
    return {
        version: 1,
        id: "p7-message",
        from: "master",
        to: MEMBER_NAME,
        kind: "message",
        body: "work item",
        timestamp: Date.now(),
        deliveryStatus: "pending",
    }
}

afterEach(() => {
    unindexSession(MEMBER)
})

afterAll(cleanupTmpRoots)

describe("transform ACK observability", () => {
    test("counts a dropped mailbox turn when session.error follows transform ACK", async () => {
        const root = tmpRoot("hooks-p7-dropped-turn")
        const member = makeMember(MEMBER_NAME, MEMBER)
        await initTeamState(root, makeState(TEAM, LEAD, [member]), LEAD)
        indexMember(MEMBER, TEAM, MEMBER_NAME, LEAD, root)

        const directory = teamDir(root, TEAM, LEAD)
        await writeMailboxMessage(directory, MEMBER_NAME, mailboxMessage())

        const logCalls: LogCall[] = []
        const ctx = contextFor(root, logCalls)
        const output: Parameters<ReturnType<typeof createTransformHook>>[1] = {
            messages: [{
                info: {
                    role: "user",
                    id: "p7-user-message",
                    sessionID: MEMBER,
                    time: { created: Date.now() },
                    agent: "oct-junior",
                    model: { providerID: "provider", modelID: "model" },
                },
                parts: [],
            }],
        }

        await createTransformHook(ctx)({}, output)
        await createEventHandler(ctx)({
            event: {
                type: "session.error",
                properties: { sessionID: MEMBER, error: "provider failed" },
            },
        } as never)

        const dropped = logCalls.find(call =>
            call.message === "mailbox turn failed after transform ACK; messages cannot be redelivered"
        )
        expect(dropped).toBeDefined()
        expect(dropped?.level).toBe("error")
        expect(dropped?.extra.acknowledgedMessages).toBe(1)
        expect(dropped?.extra.droppedTurnsSinceStartup).toBeGreaterThanOrEqual(1)
    })
})

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"

import type { Message } from "../src/core/types.js"
import { processedPath, reservedPath, teamDir } from "../src/state/paths.js"
import { indexMember, unindexSession } from "../src/state/resolve.js"
import { initTeamState } from "../src/state/store.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"

const require = createRequire(import.meta.url)
const realFs = require("node:fs/promises") as typeof import("node:fs/promises")

let failProcessedMessageId: string | undefined
const mockedFs = {
    ...realFs,
    // Mock fs.open to intercept processed.jsonl writes. appendJsonl now uses
    // fd-based open+appendFile (handle.appendFile) instead of fs.appendFile,
    // so the mock must intercept at the open level.
    open: (async (file: Parameters<typeof realFs.open>[0], flags: Parameters<typeof realFs.open>[1]) => {
        const filePath = String(file)
        const realHandle = await realFs.open(file as Parameters<typeof realFs.open>[0], flags as Parameters<typeof realFs.open>[1])
        if (
            failProcessedMessageId !== undefined
            && filePath.endsWith(".processed.jsonl")
        ) {
            const originalAppendFile = realHandle.appendFile.bind(realHandle)
            realHandle.appendFile = (async (data: Parameters<typeof realHandle.appendFile>[0]) => {
                const str = Buffer.isBuffer(data) ? data.toString("utf8") : String(data)
                if (str.includes(failProcessedMessageId!)) {
                    const error = new Error("EIO: simulated processed append failure") as NodeJS.ErrnoException
                    error.code = "EIO"
                    throw error
                }
                return originalAppendFile(data)
            }) as typeof realHandle.appendFile
        }
        return realHandle
    }) as typeof realFs.open,
}

mock.module("node:fs/promises", () => ({ ...mockedFs, default: mockedFs }))

const { createTransformHook } = await import("../src/hooks.js")
const { writeMailboxMessage } = await import("../src/messaging/mailbox.js")

const LEAD = "ses_partial_ack_lead"
const MEMBER = "ses_partial_ack_member"
const TEAM = "partial-ack"
const MEMBER_NAME = "worker"

function message(id: string, body: string): Message {
    return {
        version: 1,
        id,
        from: "master",
        to: MEMBER_NAME,
        kind: "message",
        body,
        timestamp: Date.now(),
        deliveryStatus: "pending",
    }
}

afterEach(() => {
    failProcessedMessageId = undefined
    unindexSession(MEMBER)
})

afterAll(() => {
    cleanupTmpRoots()
})

describe("transform hook partial ACK", () => {
    test("retains only messages whose processed writes committed", async () => {
        const root = tmpRoot("transform-partial-ack")
        await initTeamState(root, makeState(TEAM, LEAD, [makeMember(MEMBER_NAME, MEMBER)]), LEAD)
        indexMember(MEMBER, TEAM, MEMBER_NAME, LEAD, root)
        const directory = teamDir(root, TEAM, LEAD)
        const first = message("ack-first", "FIRST_ACKED_BODY")
        const second = message("ack-second", "SECOND_UNACKED_BODY")
        await writeMailboxMessage(directory, MEMBER_NAME, first)
        await writeMailboxMessage(directory, MEMBER_NAME, second)
        failProcessedMessageId = second.id

        const output: Parameters<ReturnType<typeof createTransformHook>>[1] = {
            messages: [{
                info: {
                    role: "user",
                    id: "user-message",
                    sessionID: MEMBER,
                    time: { created: 0 },
                    agent: "oct-junior",
                    model: { providerID: "provider", modelID: "model" },
                },
                parts: [],
            }],
        }
        await createTransformHook(makeCtx({ storageRoot: root, client: true }))({}, output)

        const injected = output.messages[0]?.parts.find(part => part.type === "text")
        expect(injected?.type).toBe("text")
        if (injected?.type !== "text") throw new Error("expected text injection")
        expect(injected.text).toContain(first.body)
        expect(injected.text).not.toContain(second.body)

        const processed = await realFs.readFile(processedPath(directory, MEMBER_NAME), "utf8")
        expect(processed).toContain(first.id)
        expect(processed).not.toContain(second.id)
        expect(realFs.stat(reservedPath(directory, MEMBER_NAME, first.id))).rejects.toThrow(/ENOENT/)
        expect(await realFs.stat(reservedPath(directory, MEMBER_NAME, second.id))).toBeDefined()
    })
})

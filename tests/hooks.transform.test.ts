import fs from "node:fs/promises"

import { afterEach, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/context.js"
import { createCompactingHook, createTransformHook } from "../src/hooks.js"
import { countUnreadMessages, writeMailboxMessage } from "../src/mailbox.js"
import { processedPath, reservedDir, teamDir } from "../src/state/paths.js"
import { initTeamState } from "../src/state/store.js"
import type { Message } from "../src/types.js"
import { indexMaster, indexMember, unindexSession } from "../src/utils.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

const LEAD = "ses_lead"
const MEMBER = "ses_member"
const TEAM = "math"
const MEMBER_NAME = "solver"

type TestPart = { type: string; text?: string; synthetic?: boolean }
type TestMsg = { info: { sessionID: string; role: string }; parts: TestPart[] }
type TransformOutput = Parameters<ReturnType<typeof createTransformHook>>[1]

/** The transform hook only reads ctx.storageRoot; a thin stub is enough. */
function ctxFor(root: string): PluginContext {
    return { storageRoot: root } as unknown as PluginContext
}

/** Fresh transform output each call (parts get mutated on injection). */
function makeOutput(sessionID: string, role: "user" | "assistant" = "user"): {
    messages: TestMsg[]
} {
    return { messages: [{ info: { sessionID, role }, parts: [] }] }
}

function makeMsg(id: string, body: string, to: string = MEMBER_NAME): Message {
    return {
        version: 1,
        id,
        from: "verifier",
        to,
        kind: "message",
        body,
        timestamp: Date.now(),
        deliveryStatus: "pending",
    }
}

async function exists(p: string): Promise<boolean> {
    try {
        await fs.stat(p)
        return true
    } catch {
        return false
    }
}

afterEach(() => {
    unindexSession(LEAD)
    unindexSession(MEMBER)
})

describe("transform hook delivery (Q1 fix)", () => {
    test("drains member mailbox and injects unread as a synthetic part", async () => {
        const root = tmpRoot("transform-deliver")
        await initTeamState(root, makeState(TEAM, LEAD, [makeMember(MEMBER_NAME, MEMBER)]), LEAD)
        indexMember(MEMBER, TEAM, MEMBER_NAME, LEAD, root)
        const dir = teamDir(root, TEAM, LEAD)
        await writeMailboxMessage(dir, MEMBER_NAME, makeMsg("m1", "x=2"))

        const transform = createTransformHook(ctxFor(root))
        const output = makeOutput(MEMBER)
        await transform({}, output as unknown as TransformOutput)

        // Injected into the (only) user message.
        expect(output.messages[0].parts).toHaveLength(1)
        expect(output.messages[0].parts[0].text).toContain("x=2")
        expect(output.messages[0].parts[0].text).toContain("team_message")
        // Inbox drained, message committed to processed.
        expect(await countUnreadMessages(dir, MEMBER_NAME)).toBe(0)
        expect(await exists(processedPath(dir, MEMBER_NAME))).toBe(true)
    })
})

describe("transform hook compaction guard (Q2 — no silent message loss)", () => {
    test("compaction-clone turn does NOT reserve/ack/inject; message preserved", async () => {
        const root = tmpRoot("transform-compact")
        await initTeamState(root, makeState(TEAM, LEAD, [makeMember(MEMBER_NAME, MEMBER)]), LEAD)
        indexMember(MEMBER, TEAM, MEMBER_NAME, LEAD, root)
        const dir = teamDir(root, TEAM, LEAD)
        await writeMailboxMessage(dir, MEMBER_NAME, makeMsg("m1", "x=2"))

        // Mark the session compacting, then fire the transform on the clone turn.
        const markCompacting = createCompactingHook()
        await markCompacting({ sessionID: MEMBER }, { context: [] })
        const transform = createTransformHook(ctxFor(root))
        const output = makeOutput(MEMBER)
        await transform({}, output as unknown as TransformOutput)

        // Nothing injected into the throwaway clone.
        expect(output.messages[0].parts).toHaveLength(0)
        // Message fully preserved: inbox intact, never reserved, never processed.
        expect(await countUnreadMessages(dir, MEMBER_NAME)).toBe(1)
        expect(await exists(reservedDir(dir, MEMBER_NAME))).toBe(false)
        expect(await exists(processedPath(dir, MEMBER_NAME))).toBe(false)
    })

    test("consume-once: the live turn AFTER compaction delivers normally", async () => {
        const root = tmpRoot("transform-consume-once")
        await initTeamState(root, makeState(TEAM, LEAD, [makeMember(MEMBER_NAME, MEMBER)]), LEAD)
        indexMember(MEMBER, TEAM, MEMBER_NAME, LEAD, root)
        const dir = teamDir(root, TEAM, LEAD)
        await writeMailboxMessage(dir, MEMBER_NAME, makeMsg("m1", "x=2"))

        const markCompacting = createCompactingHook()
        await markCompacting({ sessionID: MEMBER }, { context: [] })
        const transform = createTransformHook(ctxFor(root))

        // First turn (the compaction clone) is skipped.
        const skipped = makeOutput(MEMBER)
        await transform({}, skipped as unknown as TransformOutput)
        expect(skipped.messages[0].parts).toHaveLength(0)
        expect(await countUnreadMessages(dir, MEMBER_NAME)).toBe(1)

        // Next live turn delivers the still-pending message.
        const delivered = makeOutput(MEMBER)
        await transform({}, delivered as unknown as TransformOutput)
        expect(delivered.messages[0].parts).toHaveLength(1)
        expect(await countUnreadMessages(dir, MEMBER_NAME)).toBe(0)
    })
})

describe("transform hook master exclusion (Q3)", () => {
    test("master session is not drained by the transform hook", async () => {
        const root = tmpRoot("transform-master")
        await initTeamState(root, makeState(TEAM, LEAD, [makeMember(MEMBER_NAME, MEMBER)]), LEAD)
        indexMaster(LEAD, TEAM, LEAD, root)
        const dir = teamDir(root, TEAM, LEAD)
        await writeMailboxMessage(dir, "master", makeMsg("m1", "result", "master"))

        const transform = createTransformHook(ctxFor(root))
        const output = makeOutput(LEAD)
        await transform({}, output as unknown as TransformOutput)

        // Not injected here; the master mailbox is left for the event-handler drain.
        expect(output.messages[0].parts).toHaveLength(0)
        expect(await countUnreadMessages(dir, "master")).toBe(1)
    })
})

/**
 * Concurrency stress tests for pollMailbox (src/messaging/mailbox.ts) — the
 * atomic read-and-reserve protocol that is the duplicate-delivery guard between
 * the two master drainers (event-handler proactive drain + Transform hook).
 *
 * GAP CLOSED: c2-mailbox-ack-lock.test.ts covers concurrent ACK and the
 * read-truncate race vs writeMailboxMessage, but NO test fires two concurrent
 * pollMailbox drainers on the SAME inbox to prove they see DISJOINT sets (the
 * "first wins, second sees empty" core guarantee in the mailbox.ts:139-145
 * docstring). This is the exactly-once invariant the whole messaging layer
 * rests on.
 */
import { afterAll, describe, expect, test } from "bun:test"

import type { Message } from "../src/core/types.js"
import { pollMailbox, writeMailboxMessage } from "../src/messaging/mailbox.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

function msg(id: string): Message {
    return {
        version: 1,
        id,
        from: "master",
        to: "alice",
        kind: "message",
        body: `body-${id}`,
        timestamp: Date.now(),
        deliveryStatus: "pending",
    }
}

describe("pollMailbox concurrent drainers see disjoint sets", () => {
    test("two simultaneous drains of the same inbox never double-deliver", async () => {
        const dir = tmpRoot("poll-disjoint")
        const recipient = "alice"
        // Seed 30 messages into the inbox.
        const ids = Array.from({ length: 30 }, (_, i) => `m${i}`)
        for (const id of ids) {
            await writeMailboxMessage(dir, recipient, msg(id))
        }

        // Two drainers race on the SAME inbox (mirrors event-handler drain +
        // Transform hook firing together). The mailbox lock must serialize them
        // so each message is returned to AT MOST one drainer.
        const [a, b] = await Promise.all([
            pollMailbox(dir, recipient),
            pollMailbox(dir, recipient),
        ])

        const allDelivered = [...a, ...b].map(m => m.id).sort()
        const unique = new Set(allDelivered)

        // No duplicate delivery: union has no repeats.
        expect(allDelivered.length).toBe(unique.size)
        // No loss: every seeded message was delivered exactly once across both.
        expect(unique.size).toBe(30)
        expect([...unique].sort()).toEqual([...ids].sort())
        // First-wins semantics: one drainer typically gets all, the other empty
        // (they are serialized by the lock). Whatever the split, it is disjoint.
        const aIds = new Set(a.map(m => m.id))
        for (const m of b) {
            expect(aIds.has(m.id)).toBe(false)
        }
    })

    test("five concurrent drainers partition the inbox with zero overlap", async () => {
        const dir = tmpRoot("poll-five")
        const recipient = "bob"
        const ids = Array.from({ length: 50 }, (_, i) => `x${i}`)
        for (const id of ids) {
            await writeMailboxMessage(dir, recipient, msg(id))
        }

        const drains = await Promise.all(
            Array.from({ length: 5 }, () => pollMailbox(dir, recipient)),
        )

        const flat = drains.flat().map(m => m.id)
        const unique = new Set(flat)
        // Exactly-once: union size == flat length (no dup) AND == 50 (no loss).
        expect(flat.length).toBe(50)
        expect(unique.size).toBe(50)

        // The inbox is now empty: a final drain returns nothing.
        const leftover = await pollMailbox(dir, recipient)
        expect(leftover).toHaveLength(0)
    })

    test("interleaved writes + drains never lose or duplicate a message", async () => {
        const dir = tmpRoot("poll-interleave")
        const recipient = "carol"
        // Interleave 20 writes with 20 drains all racing together.
        const writeIds = Array.from({ length: 20 }, (_, i) => `w${i}`)
        const ops: Promise<unknown>[] = []
        const drained: string[] = []
        for (let i = 0; i < 20; i++) {
            ops.push(writeMailboxMessage(dir, recipient, msg(writeIds[i])))
            ops.push(
                pollMailbox(dir, recipient).then(got => {
                    for (const m of got) drained.push(m.id)
                }),
            )
        }
        await Promise.all(ops)
        // Drain whatever remains after the storm settles.
        const tail = await pollMailbox(dir, recipient)
        for (const m of tail) drained.push(m.id)

        const unique = new Set(drained)
        // No message delivered twice.
        expect(drained.length).toBe(unique.size)
        // Every written message was eventually delivered exactly once.
        expect([...unique].sort()).toEqual([...writeIds].sort())
    })
})

/**
 * Regression tests for concurrency bug C2: ackMessages ran append+unlink
 * OUTSIDE the mailbox lock, racing releaseStaleReservations at the reservation
 * TTL boundary -> a message could land in BOTH processed.jsonl AND inbox.
 *
 * Fix: ackMessages holds the mailbox lock for the whole batch (matching
 * pollMailbox/releaseStaleReservations). pruneProcessedLog was split into an
 * unlocked helper (_pruneProcessedLogUnlocked) so ack prunes under its own
 * lock without re-acquiring the non-reentrant mailbox lock (self-deadlock).
 */
import { existsSync } from "node:fs"
import path from "node:path"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"

import { afterAll, describe, expect, test } from "bun:test"

import type { Message } from "../src/core/types.js"
import { ackMessages, pollMailbox, releaseStaleReservations, writeMailboxMessage } from "../src/messaging/mailbox.js"
import { RESERVATION_TTL_MS } from "../src/state/locks.js"
import { inboxPath, processedPath, reservedPath } from "../src/state/paths.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

function makeMessage(id: string): Message {
    return {
        version: 1,
        id,
        from: "orchestrator",
        to: "alice",
        kind: "message",
        body: `body-${id}`,
        timestamp: Date.now(),
        deliveryStatus: "pending",
    } as Message
}

async function readJsonl(p: string): Promise<Array<Record<string, unknown>>> {
    try {
        const raw = await readFile(p, "utf8")
        return raw.split("\n").filter(l => l.length > 0).map(l => JSON.parse(l) as Record<string, unknown>)
    } catch {
        return []
    }
}

describe("C2 T1: ackMessages processes reserved messages atomically", () => {
    test("reserved msg -> ack -> in processed.jsonl, reservation gone, inbox empty", async () => {
        const teamDir = tmpRoot("c2-t1")
        const recipient = "alice"
        const msg = makeMessage("m1")

        await writeMailboxMessage(teamDir, recipient, msg)
        const reserved = await pollMailbox(teamDir, recipient)
        expect(reserved).toHaveLength(1)
        expect(existsSync(reservedPath(teamDir, recipient, "m1"))).toBe(true)

        await ackMessages(teamDir, recipient, reserved)

        const processed = await readJsonl(processedPath(teamDir, recipient))
        expect(processed).toHaveLength(1)
        expect(processed[0].id).toBe("m1")
        expect(existsSync(reservedPath(teamDir, recipient, "m1"))).toBe(false)
        expect((await readJsonl(inboxPath(teamDir, recipient)))).toHaveLength(0)
    })
})

describe("C2 T2: ackMessages with prune does NOT self-deadlock", () => {
    test("processed.jsonl over cap -> ack triggers prune -> returns < 2s (not 30s deadlock)", async () => {
        const teamDir = tmpRoot("c2-t2")
        const recipient = "alice"
        const pp = processedPath(teamDir, recipient)

        // Pre-fill processed.jsonl beyond PROCESSED_MAX_LINES (1000) so ack's
        // prune step runs. Pre-fix (naive lock-wrap calling the locked
        // pruneProcessedLog), this would hang 30s on the non-reentrant lock.
        // H14: entries now carry a timestamp so the time-based pruner can age
        // them out. Use an expired timestamp so they get pruned on ack.
        const expiredTs = Date.now() - RESERVATION_TTL_MS * 5
        const filler = Array.from({ length: 1001 }, (_, i) =>
            JSON.stringify({ id: `old-${i}`, deliveryStatus: "processed", timestamp: expiredTs }),
        ).join("\n") + "\n"
        await mkdir(path.dirname(pp), { recursive: true })
        await writeFile(pp, filler)

        const msg = makeMessage("m-new")
        await writeMailboxMessage(teamDir, recipient, msg)
        const reserved = await pollMailbox(teamDir, recipient)

        const start = Date.now()
        await ackMessages(teamDir, recipient, reserved)
        const elapsed = Date.now() - start

        expect(elapsed).toBeLessThan(2000)
        const processed = await readJsonl(pp)
        // Old entries are aged out; only the new acked message survives.
        expect(processed.some(m => m.id === "m-new")).toBe(true)
    })
})

describe("C2 T3: after ack completes, releaseStaleReservations finds nothing to re-add", () => {
    test("stale reservation -> ack first -> release sees empty reserved dir -> no re-delivery", async () => {
        const teamDir = tmpRoot("c2-t3")
        const recipient = "alice"
        const msg = makeMessage("m1")

        await writeMailboxMessage(teamDir, recipient, msg)
        const reserved = await pollMailbox(teamDir, recipient)

        // Make the reservation appear stale (age > TTL) so release WOULD re-add
        // it to the inbox if it could still see the file.
        const rp = reservedPath(teamDir, recipient, "m1")
        await writeFile(rp, JSON.stringify({
            ...msg,
            deliveryStatus: "delivered",
            reservedAt: Date.now() - RESERVATION_TTL_MS - 5000,
        }))

        // ack runs first (holds the lock, appends to processed, unlinks the
        // reservation file). release runs after: readdir reserved dir is empty,
        // nothing to re-add. Pre-fix (no lock), release could interleave
        // between ack's append and unlink and re-add the stale reservation.
        await ackMessages(teamDir, recipient, reserved)
        await releaseStaleReservations(teamDir, recipient)

        const processed = await readJsonl(processedPath(teamDir, recipient))
        const inbox = await readJsonl(inboxPath(teamDir, recipient))
        expect(processed.some(m => m.id === "m1")).toBe(true)
        expect(inbox).toHaveLength(0)
    })
})

describe("C2 T4: concurrent ack for different recipients does not serialize", () => {
    test("ack alice + ack bob concurrently -> both finish fast (separate locks)", async () => {
        const teamDir = tmpRoot("c2-t4")
        const msgA = makeMessage("a1")
        const msgB = makeMessage("b1")
        await writeMailboxMessage(teamDir, "alice", msgA)
        await writeMailboxMessage(teamDir, "bob", msgB)
        const resA = await pollMailbox(teamDir, "alice")
        const resB = await pollMailbox(teamDir, "bob")

        const start = Date.now()
        await Promise.all([
            ackMessages(teamDir, "alice", resA),
            ackMessages(teamDir, "bob", resB),
        ])
        const elapsed = Date.now() - start

        expect(elapsed).toBeLessThan(2000)
        expect((await readJsonl(processedPath(teamDir, "alice"))).length).toBe(1)
        expect((await readJsonl(processedPath(teamDir, "bob"))).length).toBe(1)
    })
})

describe("C2 T5: prune during ack keeps most recent entries", () => {
    test("1000 old + 2 new -> ack -> processed trimmed to 1000, newest kept", async () => {
        const teamDir = tmpRoot("c2-t5")
        const recipient = "alice"
        const pp = processedPath(teamDir, recipient)

        // H14: old entries carry an expired timestamp so the time-based
        // pruner removes them. New messages (m1, m2) have a current timestamp.
        const expiredTs = Date.now() - RESERVATION_TTL_MS * 5
        const filler = Array.from({ length: 1000 }, (_, i) =>
            JSON.stringify({ id: `old-${i}`, deliveryStatus: "processed", timestamp: expiredTs }),
        ).join("\n") + "\n"
        await mkdir(path.dirname(pp), { recursive: true })
        await writeFile(pp, filler)

        const m1 = makeMessage("m1")
        const m2 = makeMessage("m2")
        await writeMailboxMessage(teamDir, recipient, m1)
        await writeMailboxMessage(teamDir, recipient, m2)
        const reserved = await pollMailbox(teamDir, recipient)

        await ackMessages(teamDir, recipient, reserved)

        const processed = await readJsonl(pp)
        // H14: prune is now time-based, not line-based. The 1000 old entries
        // (expired timestamp) are pruned; the 2 new entries survive.
        expect(processed.some(m => m.id === "m1")).toBe(true)
        expect(processed.some(m => m.id === "m2")).toBe(true)
        expect(processed.every(m => m.id !== "old-0")).toBe(true)
        const ids = processed.slice(-2).map(m => m.id)
        expect(ids).toEqual(["m1", "m2"])
    })

    test("processed log over 1 MiB is compacted to the recent byte window", async () => {
        const teamDir = tmpRoot("c2-t5-large")
        const recipient = "alice"
        const pp = processedPath(teamDir, recipient)
        const recentTs = Date.now()
        const largeEntry = JSON.stringify({
            id: "recent-filler",
            deliveryStatus: "processed",
            timestamp: recentTs,
            processedAt: recentTs,
            padding: "x".repeat(1024),
        }) + "\n"
        const filler = largeEntry.repeat(Math.ceil(1_048_576 / Buffer.byteLength(largeEntry)) + 1)
        await mkdir(path.dirname(pp), { recursive: true })
        await writeFile(pp, filler)

        const message = makeMessage("large-log-new")
        await writeMailboxMessage(teamDir, recipient, message)
        const reserved = await pollMailbox(teamDir, recipient)
        await ackMessages(teamDir, recipient, reserved)

        expect((await stat(pp)).size).toBeLessThanOrEqual(524_288)
        const processed = await readJsonl(pp)
        expect(processed.some(entry => entry.id === message.id)).toBe(true)
    })

    test("stale reservation dedupe reads the recent window of an oversized processed log", async () => {
        const teamDir = tmpRoot("c2-t5-large-dedupe")
        const recipient = "alice"
        const pp = processedPath(teamDir, recipient)
        const message = makeMessage("large-log-deduped")
        const recentTs = Date.now()
        const largeEntry = JSON.stringify({
            id: "recent-filler",
            deliveryStatus: "processed",
            timestamp: recentTs,
            processedAt: recentTs,
            padding: "x".repeat(1024),
        }) + "\n"
        const filler = largeEntry.repeat(Math.ceil(1_048_576 / Buffer.byteLength(largeEntry)) + 1)
        await mkdir(path.dirname(pp), { recursive: true })
        await writeFile(pp, filler + JSON.stringify({
            ...message,
            deliveryStatus: "processed",
            processedAt: recentTs,
        }) + "\n")
        const rp = reservedPath(teamDir, recipient, message.id)
        await mkdir(path.dirname(rp), { recursive: true })
        await writeFile(rp, JSON.stringify({
            ...message,
            deliveryStatus: "delivered",
            reservedAt: Date.now() - RESERVATION_TTL_MS - 1_000,
        }))

        await releaseStaleReservations(teamDir, recipient)

        expect(existsSync(rp)).toBe(false)
        expect(await readJsonl(inboxPath(teamDir, recipient))).toHaveLength(0)
    })
})

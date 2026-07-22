/**
 * Coverage-gap tests for src/messaging/mailbox.ts:
 *   - readJsonl skip paths (malformed JSON, wrong-shape JSON)
 *   - releaseStaleReservations stale/fresh/unreadable/ENOENT branches
 *
 * Existing tests (mailbox-ack-lock, poll-mailbox-truncate-rollback,
 * mailbox-concurrent-drain, hooks-transform) cover the happy paths of
 * write/poll/ack/release. This file fills the remaining branches.
 */
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import type { Message } from "../src/core/types.js"
import {
    countUnreadMessages,
    releaseStaleReservations,
    writeMailboxMessage,
} from "../src/messaging/mailbox.js"
import { RESERVATION_TTL_MS } from "../src/state/locks.js"
import { reservedDir, reservedPath } from "../src/state/paths.js"
import { cleanupTmpRoots, tmpRoot, writeRawInboxLine } from './helpers.js';

afterAll(cleanupTmpRoots)

function makeMessage(id: string, body = `body-${id}`): Message {
    return {
        version: 1,
        id,
        from: "orchestrator",
        to: "alice",
        kind: "message",
        body,
        timestamp: Date.now(),
        deliveryStatus: "pending",
    } as Message
}

/** Write a reserved file directly, bypassing pollMailbox (for stale/fresh/unreadable scenarios). */
async function writeReservedFile(
    teamDir: string,
    recipient: string,
    msgId: string,
    content: Record<string, unknown>,
): Promise<string> {
    const p = reservedPath(teamDir, recipient, msgId)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, JSON.stringify(content), "utf8")
    return p
}

// ============================================================
// readJsonl: malformed / wrong-shape line skip (mailbox.ts:92-100)
// ============================================================

describe("readJsonl: invalid line handling", () => {
    test("malformed JSON line is skipped (JSON.parse catch, line 92-94)", async () => {
        const teamDir = tmpRoot("mbj-badjson")
        const recipient = "alice"
        // One valid message + one broken line.
        await writeMailboxMessage(teamDir, recipient, makeMessage("good"))
        await writeRawInboxLine(teamDir, recipient, "{not valid json")

        const count = await countUnreadMessages(teamDir, recipient)
        // Only the valid message counts.
        expect(count).toBe(1)
    })

    test("valid JSON but wrong shape (missing id/from/body) is skipped (line 96-100)", async () => {
        const teamDir = tmpRoot("mbj-wrongshape")
        const recipient = "alice"
        // Valid JSON, but missing required fields → isValidMessage returns false.
        await writeRawInboxLine(teamDir, recipient, JSON.stringify({ foo: "bar" }))
        // One valid message alongside the bad-shape line.
        await writeMailboxMessage(teamDir, recipient, makeMessage("good"))

        const count = await countUnreadMessages(teamDir, recipient)
        expect(count).toBe(1)
    })

    test("all lines invalid → empty result, no throw", async () => {
        const teamDir = tmpRoot("mbj-allbad")
        const recipient = "alice"
        await writeRawInboxLine(teamDir, recipient, "garbage line 1")
        await writeRawInboxLine(teamDir, recipient, "{another bad}")

        const count = await countUnreadMessages(teamDir, recipient)
        expect(count).toBe(0)
    })
})

// ============================================================
// releaseStaleReservations: stale / fresh / unreadable / ENOENT
// (mailbox.ts:239-281)
// ============================================================

describe("releaseStaleReservations: stale reservation re-injection", () => {
    test("stale reserved message (age > TTL) → re-injected to inbox, reserved file unlinked", async () => {
        const teamDir = tmpRoot("rsr-stale")
        const recipient = "alice"
        const msg = makeMessage("stale-1")
        // Write a reserved file with reservedAt in the distant past.
        await writeReservedFile(teamDir, recipient, msg.id, {
            ...msg,
            deliveryStatus: "delivered",
            reservedAt: Date.now() - RESERVATION_TTL_MS - 5_000, // 5s past TTL
        })

        await releaseStaleReservations(teamDir, recipient)

        // Message is back in the inbox (pending) ...
        const inbox = await countUnreadMessages(teamDir, recipient)
        expect(inbox).toBe(1)
        // ... and the reserved file is gone.
        expect(existsSync(reservedPath(teamDir, recipient, msg.id))).toBe(false)
    })

    test("fresh reserved message (age < TTL) → NOT re-injected, reserved file stays", async () => {
        const teamDir = tmpRoot("rsr-fresh")
        const recipient = "alice"
        const msg = makeMessage("fresh-1")
        await writeReservedFile(teamDir, recipient, msg.id, {
            ...msg,
            deliveryStatus: "delivered",
            reservedAt: Date.now() - 1_000, // 1s ago, well within TTL
        })

        await releaseStaleReservations(teamDir, recipient)

        // Inbox still empty (reservation not stale enough).
        expect(await countUnreadMessages(teamDir, recipient)).toBe(0)
        // Reserved file untouched.
        expect(existsSync(reservedPath(teamDir, recipient, msg.id))).toBe(true)
    })

    test("multiple reservations: only stale ones are re-injected", async () => {
        const teamDir = tmpRoot("rsr-mixed")
        const recipient = "alice"
        const stale = makeMessage("stale-mix")
        const fresh = makeMessage("fresh-mix")
        await writeReservedFile(teamDir, recipient, stale.id, {
            ...stale,
            deliveryStatus: "delivered",
            reservedAt: Date.now() - RESERVATION_TTL_MS - 1_000,
        })
        await writeReservedFile(teamDir, recipient, fresh.id, {
            ...fresh,
            deliveryStatus: "delivered",
            reservedAt: Date.now(),
        })

        await releaseStaleReservations(teamDir, recipient)

        // Only the stale one came back.
        expect(await countUnreadMessages(teamDir, recipient)).toBe(1)
        expect(existsSync(reservedPath(teamDir, recipient, stale.id))).toBe(false)
        expect(existsSync(reservedPath(teamDir, recipient, fresh.id))).toBe(true)
    })
})

describe("releaseStaleReservations: edge cases", () => {
    test("unreadable reserved file (malformed JSON) → silently skipped", async () => {
        const teamDir = tmpRoot("rsr-unreadable")
        const recipient = "alice"
        // Write a file that is NOT valid JSON → JSON.parse throws → skip (line 259-261).
        const p = reservedPath(teamDir, recipient, "corrupt")
        await fs.mkdir(path.dirname(p), { recursive: true })
        await fs.writeFile(p, "not json at all", "utf8")

        await releaseStaleReservations(teamDir, recipient)

        // Nothing re-injected; the corrupt file is left in place (best-effort skip).
        expect(await countUnreadMessages(teamDir, recipient)).toBe(0)
        expect(existsSync(p)).toBe(true)
    })

    test("reserved dir does not exist (ENOENT) → no-op, no throw", async () => {
        const teamDir = tmpRoot("rsr-noent")
        const recipient = "alice"
        // Deliberately do NOT create the reserved dir.
        await expect(releaseStaleReservations(teamDir, recipient)).resolves.toBeUndefined()
        expect(await countUnreadMessages(teamDir, recipient)).toBe(0)
    })

    test("empty reserved dir → no-op", async () => {
        const teamDir = tmpRoot("rsr-empty")
        const recipient = "alice"
        // Create the dir but leave it empty.
        await fs.mkdir(reservedDir(teamDir, recipient), { recursive: true })

        await expect(releaseStaleReservations(teamDir, recipient)).resolves.toBeUndefined()
        expect(await countUnreadMessages(teamDir, recipient)).toBe(0)
    })
})

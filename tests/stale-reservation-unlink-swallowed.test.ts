/**
 * Regression test for confirmed finding "stale-reservation-unlink-swallowed".
 *
 * Bug: src/messaging/mailbox.ts:363-369 — releaseStaleReservations requeues a
 * stale reservation to the inbox BEFORE unlinking it:
 *   await appendJsonl(inboxPath, { ...parsed, deliveryStatus: "pending" })  // :363
 *   await fs.unlink(p).catch(() => { /* already gone *\/ })                 // :367
 * The .catch swallows ALL unlink failures, not just ENOENT. If the unlink
 * fails (EPERM, EBUSY, EROFS, ...), the reservation file survives on disk
 * even though it was just requeued to the inbox.
 *
 * Harm: on the NEXT sweep, the reaper sees the same reservation file (still
 * stale, still on disk), requeues it AGAIN → the inbox accumulates duplicate
 * copies of the same message on every sweep. The dedup guard at :357 only
 * covers messages in processed.jsonl, so a never-acked stale reservation
 * (crash between reserve and ack) bypasses it and is re-reaped indefinitely.
 *
 * Fix: unlink the reservation file BEFORE requeuing — only append to the
 * inbox on successful unlink (or propagate non-ENOENT so the caller knows
 * the requeue did not complete).
 *
 * This test mocks node:fs/promises so fs.unlink throws EPERM for ".reserved/"
 * paths during the reaper. It runs the reaper TWICE (simulating two sweeps)
 * and asserts the inbox does NOT contain duplicate copies of the same stale
 * message — i.e., a single reservation must produce at most one requeue.
 *   UNFIXED: sweep 1 requeues (append ok) + unlink fails (swallowed) → file
 *            remains. Sweep 2 re-requeues the same file → inbox has 2 copies
 *            → assertion FAILS (duplicates).
 *   FIXED:   unlink-first means a failed unlink prevents the requeue → inbox
 *            has 0 copies across both sweeps → assertion PASSES.
 *
 * Mocking notes: node:fs/promises is pre-cached by bun's runtime, so
 * mock.module must (a) include a `default` export and (b) be in effect before
 * mailbox.ts is imported (dynamic `await import`). Only ".reserved/" paths
 * are intercepted; inbox append (fs.appendFile), mailbox lock release
 * (".lock" paths), and all other unlink callers pass through to real fs.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import path from "node:path"

// --- Load the REAL node:fs/promises BEFORE mock.module registers so every
//     export except `unlink` keeps its real implementation. ---
const require = createRequire(import.meta.url)
const realFs = require("node:fs/promises") as typeof import("node:fs/promises")

let failReservedUnlink = false

const mockedFs = {
    ...realFs,
    unlink: (async (p: string) => {
        // Intercept only reservation cleanup: paths under ".reserved/".
        // releaseStaleReservations:367 is the caller that swallows these
        // failures. Mailbox lock release (releaseLock at locks.ts) operates
        // on ".lock" files — NOT matched, so withLock continues to work.
        if (failReservedUnlink && typeof p === "string" && p.includes(".reserved" + path.sep)) {
            const err = new Error(
                `EPERM: simulated reaper unlink failure: unlink '${p}'`,
            ) as NodeJS.ErrnoException
            err.code = "EPERM"
            throw err
        }
        return realFs.unlink(p)
    }) as typeof realFs.unlink,
}

// `default` is required: mailbox.ts and locks.ts do `import fs from`.
mock.module("node:fs/promises", () => ({ ...mockedFs, default: mockedFs }))

// Dynamic import AFTER mock.module so mailbox.ts resolves the MOCKED fs.
const { releaseStaleReservations, pollMailbox, writeMailboxMessage } =
    await import("../src/messaging/mailbox.js")
import { inboxPath, reservedPath } from "../src/state/paths.js"

import type { Message } from "../src/core/types.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

/** Minimal valid Message fixture. */
function makeMsg(id: string, body: string): Message {
    return {
        version: 1,
        id,
        from: "master",
        to: "alice",
        kind: "message",
        body,
        timestamp: Date.now(),
        deliveryStatus: "pending",
    }
}

/** Count inbox lines matching a message id (0 if inbox absent). */
async function countInboxOccurrences(matchId: string, inbox: string): Promise<number> {
    let raw: string
    try {
        raw = await realFs.readFile(inbox, "utf8")
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0
        throw err
    }
    let count = 0
    for (const line of raw.split("\n")) {
        if (line.length === 0) continue
        try {
            if ((JSON.parse(line) as { id?: string }).id === matchId) count++
        } catch {
            // malformed line
        }
    }
    return count
}

afterEach(() => {
    failReservedUnlink = false
})
afterAll(cleanupTmpRoots)

describe("releaseStaleReservations unlink swallowed (finding: stale-reservation-unlink-swallowed)", () => {
    test("failed unlink must not let the reaper re-requeue the same reservation on every sweep", async () => {
        const root = tmpRoot("stale-reservation-swallowed")
        const teamDir = `${root}/team`
        const recipient = "alice"
        const msgId = "msg-requeue-001"

        // --- Fixture: write + poll a message so it lands in reserved/.
        //     pollMailbox truncates the inbox, so after this the message is
        //     ONLY in reserved/ (as a reservation) — NOT in processed.jsonl.
        //     This is the "crash between reserve and ack" window: the
        //     reaper's dedup guard at :357 (checks processedIds) does NOT
        //     apply because the message was never acked. ---
        const msg = makeMsg(msgId, "requeue me")
        await writeMailboxMessage(teamDir, recipient, msg)
        await pollMailbox(teamDir, recipient)

        // --- Age the reservation so the reaper considers it stale.
        //     reservedAt 60s ago > 30s TTL (RESERVATION_TTL_MS). Also age
        //     the mtime so the mtime-fallback at :352 agrees. ---
        const rpath = reservedPath(teamDir, recipient, msgId)
        const agedContent = JSON.stringify({
            ...msg,
            deliveryStatus: "delivered",
            reservedAt: Date.now() - 60_000,
        })
        await realFs.writeFile(rpath, agedContent, "utf8")
        const oldTime = new Date(Date.now() - 60_000)
        await realFs.utimes(rpath, oldTime, oldTime)

        // Confirm inbox is empty before the sweeps.
        expect(await countInboxOccurrences(msgId, inboxPath(teamDir, recipient))).toBe(0)

        // Force fs.unlink to throw EPERM for ".reserved/" paths during the
        // reaper. releaseStaleReservations:363 appends to inbox FIRST, then
        // :367 unlinks — the unlink fails (EPERM) but is swallowed.
        failReservedUnlink = true

        // --- Sweep 1: requeue (append ok) + unlink fails (swallowed) →
        //     reservation file remains. Inbox now has 1 copy. ---
        await releaseStaleReservations(teamDir, recipient)

        // --- Sweep 2: the same reservation file is STILL stale and on disk
        //     (unlink was swallowed). The reaper re-requeues it AGAIN.
        //     Inbox now has 2 copies (UNFIXED bug). ---
        await releaseStaleReservations(teamDir, recipient)

        // --- Inbox duplicate guard: unlink-first means a failed unlink
        //     prevents the requeue entirely → inbox has 0 copies across
        //     both sweeps. ---
        const occurrences = await countInboxOccurrences(
            msgId,
            inboxPath(teamDir, recipient),
        )
        expect(occurrences).toBe(0)
    })
})

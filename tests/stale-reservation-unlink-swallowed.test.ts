/**
 * Regression test for confirmed finding "stale-reservation-unlink-swallowed".
 *
 * Original bug: src/messaging/mailbox.ts releaseStaleReservations used
 * `.catch(() => {})` to swallow ALL unlink failures during requeue, with no
 * log entry. An operator had no way to learn that the reaper was repeatedly
 * failing to clean up reservation files.
 *
 * C-5 reconciliation: the reaper now does append-first-then-unlink (see
 * mailbox-requeue-no-loss.test.ts) so that an append failure does not lose
 * the message. This means a failed unlink AFTER a successful append leaves
 * the reservation file on disk, and the NEXT sweep will re-append the same
 * message to the inbox. This is ACCEPTABLE because:
 *   1. The failure is now LOGGED (logger.debug), not silently swallowed.
 *   2. pollMailbox's read-reserve-truncate protocol is exactly-once per drain
 *      regardless of how many duplicate lines are in the inbox — the second
 *      reserve write for an already-reserved id is a no-op (the reserved file
 *      already exists), and truncate clears the inbox including duplicates.
 *   3. The alternative (unlink-first) sacrifices message safety on append
 *      failure, which is the more severe failure mode.
 *
 * This test verifies the OBSERVABILITY contract: a failed reservation
 * unlink is logged (not silently swallowed), so an operator can diagnose
 * repeated reaper failures. The duplicate-inbox behavior is bounded by
 * pollMailbox and is verified separately.
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
import { reservedPath } from "../src/state/paths.js"

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

afterEach(() => {
    failReservedUnlink = false
})
afterAll(cleanupTmpRoots)

describe("releaseStaleReservations unlink observability (finding: stale-reservation-unlink-swallowed)", () => {
    test("failed reservation unlink is logged (not silently swallowed)", async () => {
        const root = tmpRoot("stale-reservation-swallowed")
        const teamDir = `${root}/team`
        const recipient = "alice"
        const msgId = "msg-requeue-001"

        // --- Fixture: write + poll a message so it lands in reserved/.
        const msg = makeMsg(msgId, "requeue me")
        await writeMailboxMessage(teamDir, recipient, msg)
        await pollMailbox(teamDir, recipient)

        // --- Age the reservation so the reaper considers it stale.
        const rpath = reservedPath(teamDir, recipient, msgId)
        const agedContent = JSON.stringify({
            ...msg,
            deliveryStatus: "delivered",
            reservedAt: Date.now() - 60_000,
        })
        await realFs.writeFile(rpath, agedContent, "utf8")
        const oldTime = new Date(Date.now() - 60_000)
        await realFs.utimes(rpath, oldTime, oldTime)

        // Spy on logger.debug to verify the failed-unlink path is observable.
        // Pre-C-5 fix: silent .catch(() => {}) → no log entry. Post-C-5 fix:
        // logger.debug with the recipient, entry id, and error message.
        const debugCalls: Array<Record<string, unknown>> = []
        const { logger } = await import("../src/core/log.js")
        const originalDebug = logger.debug
        logger.debug = (msg: string, extra?: Record<string, unknown>) => {
            debugCalls.push({ msg, extra })
            // do NOT call originalDebug — test isolates the spy
        }
        try {
            // Force fs.unlink to throw EPERM for ".reserved/" paths.
            failReservedUnlink = true
            await releaseStaleReservations(teamDir, recipient)
        } finally {
            failReservedUnlink = false
            logger.debug = originalDebug
        }

        // The unlink failure MUST be logged (this is the core observability
        // property — pre-C-5 it was silently swallowed).
        const unlinkFailureLogged = debugCalls.some(c =>
            typeof c.msg === "string" && /unlink.*failed|failed.*unlink/i.test(c.msg),
        )
        expect(unlinkFailureLogged).toBe(true)
    })
})

/**
 * Regression test for confirmed finding "mailbox-partial-reserve-duplicates".
 *
 * Bug: src/messaging/mailbox.ts:197-202 — pollMailbox reserves inbox messages
 * one-by-one in a loop:
 *   for (const msg of inbox) {
 *       await atomicWrite(reservedPath(..., msg.id), JSON.stringify(...))  // :198
 *   }
 * Only the TRUNCATE failure has rollback (:205-220 unlinks reserved files if
 * truncateFile throws). If a LATER reservation write (atomicWrite at :198)
 * fails mid-loop, the EARLIER reserved files remain on disk while the inbox
 * is NOT truncated → messages exist in BOTH inbox/ AND reserved/.
 *
 * Harm: releaseStaleReservations (:281-323) scans reserved/ after
 * RESERVATION_TTL_MS and re-appends each reserved file back to the inbox
 * (:313-316). A message that is simultaneously in the inbox (never
 * truncated) AND reserved/ (orphaned from a partial reserve) gets delivered
 * TWICE — an exactly-once → at-least-once degradation that causes duplicate
 * message injection into the recipient's prompt.
 *
 * Fix: wrap the reserve loop in try/catch — on any reservation write
 * failure, unlink the reserved files written so far before rethrowing
 * (mirroring the existing truncate-failure rollback at :214-218).
 *
 * Mocking strategy: intercept node:fs/promises's `rename` — the final step
 * of atomicWrite (locks.ts:270). Making rename fail for the Nth reservation
 * destination path (under ".reserved/") simulates a write failure after the
 * tmp file was already written but before it lands at the target path.
 * atomicWrite catches the rename failure, unlinks the tmp, and rethrows — so
 * the failed reservation file is never created, but earlier reservations
 * (whose renames succeeded) ARE on disk.
 *
 * We mock node:fs/promises (not locks.js) because mocking locks.js causes
 * infinite recursion in bun: `realLocks.atomicWrite` resolves to the mocked
 * version. Mocking the fs primitive avoids this — realLocks.atomicWrite's
 * internal fs calls go through the mocked rename, not back through the
 * module export.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import path from "node:path"

// --- Load the REAL node:fs/promises BEFORE mock.module registers so every
//     export except `rename` keeps its real implementation. ---
const require = createRequire(import.meta.url)
const realFs = require("node:fs/promises") as typeof import("node:fs/promises")

let failOnReserveNumber = 0 // 0 = disabled; N = fail on the Nth reserve rename
let reserveRenameCount = 0

const mockedFs = {
    ...realFs,
    rename: (async (oldPath: string, newPath: string) => {
        // Intercept only reservation writes: atomicWrite's final rename to a
        // path under ".reserved/". pollMailbox's other fs operations
        // (truncateFile→writeFile, readJsonl→readFile, withLock→open/unlink)
        // do NOT use rename, so they are unaffected.
        if (
            failOnReserveNumber > 0
            && typeof newPath === "string"
            && newPath.includes(".reserved" + path.sep)
        ) {
            reserveRenameCount++
            if (reserveRenameCount === failOnReserveNumber) {
                // Clean up the tmp file atomicWrite created, then throw so
                // atomicWrite's catch cleans up and rethrows to pollMailbox.
                await realFs.unlink(oldPath).catch(() => {
                    // tmp already gone
                })
                throw new Error(
                    "simulated reservation write failure (rename to reserved/)",
                )
            }
        }
        return realFs.rename(oldPath, newPath)
    }) as typeof realFs.rename,
}

// `default` is required: mailbox.ts and locks.ts do `import fs from`.
mock.module("node:fs/promises", () => ({ ...mockedFs, default: mockedFs }))

// Dynamic import AFTER mock.module so mailbox.ts resolves the MOCKED fs.
const { pollMailbox, writeMailboxMessage } = await import("../src/messaging/mailbox.js")
import { inboxPath, reservedDir } from "../src/state/paths.js"

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

/** Count files in a directory (0 if dir does not exist). */
async function countFiles(dir: string): Promise<number> {
    try {
        const entries = await realFs.readdir(dir)
        return entries.length
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0
        throw err
    }
}

afterEach(() => {
    failOnReserveNumber = 0
    reserveRenameCount = 0
})
afterAll(cleanupTmpRoots)

describe("pollMailbox partial reserve duplicates (finding: mailbox-partial-reserve-duplicates)", () => {
    test("mid-loop reservation write failure must roll back earlier reserved files", async () => {
        const root = tmpRoot("mailbox-partial-reserve")
        const teamDir = `${root}/team`
        const recipient = "alice"
        const rdir = reservedDir(teamDir, recipient)

        // --- Fixture: write 3 messages to alice's inbox via the real
        //     writeMailboxMessage (uses withLock + appendJsonl — unaffected
        //     by the rename mock since neither uses rename). ---
        const msg1 = makeMsg("msg-001", "first message")
        const msg2 = makeMsg("msg-002", "second message")
        const msg3 = makeMsg("msg-003", "third message")
        for (const m of [msg1, msg2, msg3]) {
            await writeMailboxMessage(teamDir, recipient, m)
        }

        // Fail on the 2nd reservation rename: msg1 reserves OK (rename
        // succeeds → reserved/msg-001 exists), msg2's rename throws.
        // The loop at mailbox.ts:197-202 has no try/catch for reserve
        // failures, so the throw propagates immediately — reserved/msg-001
        // stays on disk, inbox is never truncated, and the exactly-once
        // contract is broken.
        failOnReserveNumber = 2

        // pollMailbox must propagate the reservation failure.
        await expect(
            pollMailbox(teamDir, recipient),
        ).rejects.toThrow("simulated reservation write failure")

        // --- PROVE the failure is in the reserve loop, NOT the truncate
        //     path (which DOES have rollback at :205-220): the inbox must
        //     still contain all 3 messages (truncate never ran). ---
        const inboxRaw = await realFs.readFile(inboxPath(teamDir, recipient), "utf8")
        const inboxLines = inboxRaw.split("\n").filter(l => l.length > 0)
        expect(inboxLines.length).toBe(3)

        // --- BUG (unfixed): reserved/msg-001 (written before the failure)
        //     remains on disk. After RESERVATION_TTL_MS,
        //     releaseStaleReservations re-appends it to the inbox →
        //     duplicate delivery (msg-001 exists in BOTH inbox AND reserved).
        // --- FIXED: the reserve loop's catch unlinks earlier reserved
        //     files before rethrowing → reserved/ is empty → no duplicate.
        const reservedCount = await countFiles(rdir)
        expect(reservedCount).toBe(0)
    })
})

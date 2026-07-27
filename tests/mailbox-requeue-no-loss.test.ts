/**
 * Regression test for C-5: releaseStaleReservations requeue must be
 * append-BEFORE-unlink, not unlink-BEFORE-append.
 *
 * Bug: src/messaging/mailbox.ts releaseStaleReservations() unlinks the
 * reserved file FIRST, then calls appendJsonl to requeue the message to
 * the inbox. If the append fails (ENOSPC, EACCES, EROFS, or process crash
 * between the two operations), the only copy of the message is gone —
 * permanent data loss with no recovery path.
 *
 * Fix: append to inbox FIRST (which can fail safely — the reserved file
 * is still there for the next sweep), then unlink the reserved file. If
 * the unlink fails after a successful append, the next sweep sees the
 * reserved file again and tries to requeue it again — duplicate delivery,
 * which is the at-least-once contract the mailbox already documents, and
 * strictly better than permanent loss.
 *
 * The duplicate risk is bounded: pollMailbox's read-reserve-truncate
 * protocol ensures exactly-once delivery per drain even if the inbox has
 * duplicate lines (dedup via message id in the reserved filename — the
 * second reserve write is a no-op since the file already exists).
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync, readFileSync } from "node:fs"
import path from "node:path"

import { releaseStaleReservations } from "../src/messaging/mailbox.js"
import { reservedDir, reservedPath, inboxPath } from "../src/state/paths.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

describe("C-5: releaseStaleReservations requeue is append-before-unlink (no message loss)", () => {
    test("requeue succeeds: reserved entry removed AFTER inbox append succeeds", async () => {
        const teamDir = tmpRoot("c5-normal-requeue")
        const recipient = "alice"
        const reserved = reservedDir(teamDir, recipient)
        mkdirSync(reserved, { recursive: true })

        const id = "msg-to-requeue"
        const msg = {
            version: 1,
            id,
            from: "x",
            to: recipient,
            kind: "note" as const,
            body: "important-content",
            timestamp: 0,
            deliveryStatus: "pending" as const,
            reservedAt: 0, // always stale
        }
        const rPath = reservedPath(teamDir, recipient, id)
        writeFileSync(rPath, JSON.stringify(msg))

        await releaseStaleReservations(teamDir, recipient)

        // The message was requeued to the inbox.
        const inboxContents = readFileSync(inboxPath(teamDir, recipient), "utf8")
        expect(inboxContents).toContain("important-content")

        // And the reserved entry was cleaned up.
        expect(() => readFileSync(rPath, "utf8")).toThrow()
    })

    test("requeue APPEND FIRST then unlink: if append fails, the reserved file survives (no loss)", async () => {
        const teamDir = tmpRoot("c5-append-fails")
        const recipient = "carol"
        const reserved = reservedDir(teamDir, recipient)
        mkdirSync(reserved, { recursive: true })

        const id = "msg-fail-safe"
        const body = "SURVIVE_APPEND_FAILURE"
        const msg = {
            version: 1,
            id,
            from: "x",
            to: recipient,
            kind: "note" as const,
            body,
            timestamp: 0,
            deliveryStatus: "pending" as const,
            reservedAt: 0,
        }
        const rPath = reservedPath(teamDir, recipient, id)
        writeFileSync(rPath, JSON.stringify(msg))

        // Sabotage the inbox path: make it a directory so appendFile fails
        // with EISDIR. This simulates the append failure window (ENOSPC,
        // EACCES, EROFS, etc.) without timing-dependent crash injection.
        mkdirSync(inboxPath(teamDir, recipient))

        // The reaper will try to requeue; the append must fail. With the
        // C-5 fix (append-first), the failure is caught and the reserved
        // file is preserved for the next sweep — the function does NOT throw.
        // (Pre-fix code unlinked first, then failed on append, losing the
        // message AND propagating the error.)
        await releaseStaleReservations(teamDir, recipient)

        // C-5 fix: append-first means the reserved file is still there
        // when append fails. Pre-fix: unlink-first means it's gone.
        const reservedContents = (() => {
            try { return readFileSync(rPath, "utf8") }
            catch { return null }
        })()
        expect(reservedContents).not.toBeNull()
        expect(reservedContents).toContain(body)
    })
})

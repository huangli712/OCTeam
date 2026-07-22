/**
 * Regression test for the 2026-06-30 audit MINOR finding:
 * `pollMailbox` previously degraded from exactly-once to at-least-once if
 * `truncateFile` failed after the reserved copies were written — messages
 * would exist in BOTH `inbox` and `reserved/`, and `releaseStaleReservations`
 * would re-append the reserved copy after the 30s TTL → duplicate injection.
 *
 * Fix (src/messaging/mailbox.ts:148-181): on truncate failure, roll back by
 * unlinking the reserved copies so the inbox remains authoritative for the
 * next poll. This test triggers the failure path by chmod-ing the inbox file
 * read-only so `fs.writeFile(path, "")` throws EACCES.
 */
import { afterAll, describe, expect, test } from "bun:test"

import { chmod, readFile, readdir } from "node:fs/promises"

import type { Message } from "../src/core/types.js"
import { pollMailbox, writeMailboxMessage } from "../src/messaging/mailbox.js"
import { inboxPath, reservedDir } from "../src/state/paths.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

function mkMessage(id: string): Message {
    return {
        version: 1,
        id,
        from: "alice",
        to: "master",
        kind: "message",
        body: `body-${id}`,
        timestamp: Date.now(),
        deliveryStatus: "pending",
    }
}

describe("pollMailbox — truncate failure rolls back reserved copies", () => {
    test("truncate EACCES after reserve: rollback unlinks reserved, inbox stays intact", async () => {
        const dir = tmpRoot("poll-truncate-rollback")
        const recipient = "master"

        // Seed two messages.
        await writeMailboxMessage(dir, recipient, mkMessage("m1"))
        await writeMailboxMessage(dir, recipient, mkMessage("m2"))

        // Pre-create the reserved directory so atomicWrite can place reserved
        // copies into it (otherwise the reserve step itself fails before
        // truncate, defeating the test).
        const reserved = reservedDir(dir, recipient)
        const { mkdir } = await import("node:fs/promises")
        await mkdir(reserved, { recursive: true })
        await chmod(reserved, 0o755)

        // Make the inbox file read-only so truncateFile's `fs.writeFile(path, "")`
        // throws EACCES. (truncateFile only swallows ENOENT; other errors throw.)
        const inbox = inboxPath(dir, recipient)
        await chmod(inbox, 0o444)

        // pollMailbox should reject (the EACCES propagates out of withLock).
        await expect(pollMailbox(dir, recipient)).rejects.toThrow(/EACCES/)

        // Rollback assertion 1: no reserved files left (they were unlinked on
        // the failure path). Without the rollback, m1 and m2 would persist
        // here and releaseStaleReservations would later duplicate them.
        const reservedFiles = await readdir(reserved).catch(() => [] as string[])
        expect(reservedFiles).toHaveLength(0)

        // Rollback assertion 2: the original inbox file still contains both
        // messages unchanged (truncate never succeeded).
        const inboxContent = await readFile(inbox, "utf8")
        expect(inboxContent).toContain('"id":"m1"')
        expect(inboxContent).toContain('"id":"m2"')

        // Cleanup: restore writable so cleanupTmpRoots can rm the tree.
        await chmod(inbox, 0o644).catch(() => {})
    })

    test("happy path still works after the fix (regression): reserved + truncated normally", async () => {
        const dir = tmpRoot("poll-truncate-happy")
        const recipient = "master"
        await writeMailboxMessage(dir, recipient, mkMessage("h1"))
        await writeMailboxMessage(dir, recipient, mkMessage("h2"))

        // No chmod — truncate should succeed normally.
        const polled = await pollMailbox(dir, recipient)
        expect(polled.map(m => m.id).sort()).toEqual(["h1", "h2"])

        // Inbox truncated to empty.
        const inboxContent = await readFile(inboxPath(dir, recipient), "utf8")
        expect(inboxContent).toBe("")

        // Reserved copies present (awaiting ack).
        const reservedFiles = await readdir(reservedDir(dir, recipient))
        expect(reservedFiles.sort()).toEqual(["h1", "h2"])
    })
})

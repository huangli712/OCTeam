/**
 * Regression test: mailbox reserved directory must resist
 * symlink-based read/delete attacks from a hostile .octeam/ writer.
 *
 * Bug: src/messaging/mailbox.ts releaseStaleReservations() iterates
 * readdir() entries under `<team>/mailbox/<recipient>.reserved/` and runs
 * `fs.readFile(p)`, `fs.stat(p)`, `fs.unlink(p)` on each. None of these
 * operations check for symlinks. A member with .octeam/ write access can
 * drop a symlink into the reserved directory:
 *
 *   <team>/mailbox/<recipient>.reserved/symlinked-id -> ~/.bashrc
 *
 * Then on the next sweep tick:
 * - readFile(p) reads ~/.bashrc content and parses it as a Message
 *   (info disclosure of arbitrary files the process can read)
 * - if it parses to something with a far-past reservedAt, the sweep
 *   unlinks(p) → deletes ~/.bashrc (data destruction outside team root)
 * - or requeues the parsed content into the inbox (arbitrary content
 *   injection)
 *
 * The assertNoSymlinkTraversal helper (state/locks.ts) closes the
 * atomicWrite sink but NOT the read/stat/unlink paths inside the reaper.
 *
 * Fix: walk the path chain (dir + reserved file path) against teamDirectory
 * before each readFile/stat/unlink inside releaseStaleReservations. Symlinked
 * entries inside reserved/ are quarantined (skipped + logged) rather than
 * followed.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"

import { releaseStaleReservations } from "../src/messaging/mailbox.js"
import { reservedDir, reservedPath, inboxPath } from "../src/state/paths.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

describe("releaseStaleReservations refuses symlinked reserved entries", () => {
    test("symlinked reserved entry does NOT cause read/delete of outside file", async () => {
        const teamDir = tmpRoot("c6-symlink-reserved")
        const recipient = "alice"
        const reserved = reservedDir(teamDir, recipient)
        mkdirSync(reserved, { recursive: true })

        // Outside file the attacker wants to read or destroy.
        const outsideDir = tmpRoot("c6-symlink-outside")
        const outsideFile = path.join(outsideDir, "secret.txt")
        writeFileSync(outsideFile, "TOPSECRET")

        // Drop a symlink into reserved/ pointing at the outside file. The id
        // is arbitrary but must be a "safe path segment" (no slashes).
        const symlinkId = "symlinked-id"
        const symlinkPath = path.join(reserved, symlinkId)
        symlinkSync(outsideFile, symlinkPath)

        // Run the reaper. With RESERVATION_TTL_MS defaulting to 30s, a freshly
        // created entry is NOT stale → no read/unlink/requeue. Force staleness
        // by giving it an old reservedAt inside the contents — but since the
        // link points to "TOPSECRET" (not valid JSON), the readFile will throw
        // and the entry is skipped on UNFIXED code. We need a stronger probe.
        //
        // Use a JSON-shaped payload in the target file so UNFIXED code parses
        // it and exercises the requeue/unlink path.
        writeFileSync(outsideFile, JSON.stringify({
            version: 1,
            id: symlinkId,
            from: "x",
            to: recipient,
            kind: "note",
            body: "STOLEN",
            timestamp: 0,
            deliveryStatus: "pending",
            reservedAt: 0, // epoch → always stale
        }))
        // Re-create the symlink (writeFileSync replaced the target, symlink survives).

        // Run the reaper.
        await releaseStaleReservations(teamDir, recipient)

        // Post-fix: the symlinked entry must NOT have been followed. The
        // outside file must still exist (not unlinked) and its contents
        // untouched (not re-quoted into the inbox).
        expect(() => readOrFail(outsideFile)).not.toThrow()
        const outsideContents = readOrFail(outsideFile)
        expect(outsideContents).toContain("STOLEN") // untouched

        // And the inbox must NOT contain the stolen/injected body.
        const inboxFile = inboxPath(teamDir, recipient)
        const inboxContents = readIfExists(inboxFile)
        if (inboxContents !== null) {
            expect(inboxContents).not.toContain("STOLEN")
        }

        // Cleanup: remove the symlink ourselves (the fix may have left it
        // quarantined, which is the safe behavior).
        try { rmSync(symlinkPath) } catch { /* already gone */ }
        try { rmSync(reserved, { recursive: true }) } catch { /* */ }
    })

    test("control: legitimate (non-symlinked) stale reserved entry is still requeued normally", async () => {
        const teamDir = tmpRoot("c6-control")
        const recipient = "bob"
        const reserved = reservedDir(teamDir, recipient)
        mkdirSync(reserved, { recursive: true })

        // Write a legitimate stale reserved entry directly (no symlink).
        const id = "legit-stale"
        const msg = {
            version: 1,
            id,
            from: "x",
            to: recipient,
            kind: "note" as const,
            body: "hello",
            timestamp: 0,
            deliveryStatus: "pending" as const,
            reservedAt: 0, // always stale
        }
        writeFileSync(reservedPath(teamDir, recipient, id), JSON.stringify(msg))

        await releaseStaleReservations(teamDir, recipient)

        // The reaper requeues it to the inbox.
        const inboxContents = readIfExists(inboxPath(teamDir, recipient))
        expect(inboxContents).not.toBeNull()
        expect(inboxContents!).toContain("hello")

        // And the reserved entry is removed.
        const reservedEntry = readIfExists(reservedPath(teamDir, recipient, id))
        expect(reservedEntry).toBeNull()
    })
})

function readOrFail(p: string): string {
    return readFileSync(p, "utf8")
}

function readIfExists(p: string): string | null {
    if (!existsSync(p)) return null
    return readFileSync(p, "utf8")
}

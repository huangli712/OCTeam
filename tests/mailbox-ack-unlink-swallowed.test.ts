/**
 * Regression test for confirmed finding "mailbox-ack-unlink-swallowed".
 *
 * Bug: src/messaging/mailbox.ts:261 — ackMessages does
 *   `await fs.unlink(reservedPath(..., msg.id)).catch(() => { /* already removed *\/ })`
 * AFTER appending the message to processed.jsonl (:257). This swallows ALL
 * unlink failures, not just the legitimate ENOENT race. A non-ENOENT failure
 * (EPERM, EBUSY, EROFS, ...) leaves the reservation file on disk even though
 * the message has already been committed to processed.jsonl.
 *
 * Harm: releaseStaleReservations (:297-323) scans reserved/ and re-appends
 * any file older than RESERVATION_TTL_MS back to the inbox (:313-316). A
 * reservation that ackMessages failed to unlink (but swallowed) is reaped
 * after TTL and re-delivered — even though the message was already processed.
 * This is an exactly-once → at-least-once degradation: the recipient sees a
 * duplicate of a message it already handled.
 *
 * Fix: only swallow ENOENT (the documented "already removed" race), rethrow
 * every other errno so the ack failure surfaces to the caller.
 *
 * This test mocks node:fs/promises so fs.unlink throws EPERM for ".reserved/"
 * paths during ackMessages. It asserts ackMessages must NOT silently succeed
 * when its reservation unlink fails — the error must propagate.
 *   UNFIXED: .catch(()=>{}) swallows EPERM → ackMessages resolves normally
 *            → the rejects assertion FAILS.
 *   FIXED:   non-ENOENT error propagates → ackMessages rejects → PASSES.
 *
 * It also demonstrates the harm path: after the swallowed ack, the orphaned
 * reservation is reaped by releaseStaleReservations (with an aged
 * reservedAt) and re-delivered to the inbox.
 *
 * Mocking notes: node:fs/promises is pre-cached by bun's runtime, so
 * mock.module must (a) include a `default` export (mailbox.ts and locks.ts
 * both do `import fs from "node:fs/promises"`) and (b) be in effect before
 * mailbox.ts is imported, achieved via a dynamic `await import`. Only
 * ".reserved/" paths are intercepted; mailbox lock release (".lock" paths)
 * and all other unlink callers pass through to the real implementation.
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
        // ackMessages:261 is the caller that swallows these failures.
        // Mailbox lock release (releaseLock at locks.ts:211) operates on
        // ".lock" files — NOT matched, so withLock continues to work.
        // releaseStaleReservations:317 also unlinks ".reserved/" paths, but
        // it is not called while failReservedUnlink is true in this test's
        // harm-demonstration phase (the flag is flipped off first).
        if (failReservedUnlink && typeof p === "string" && p.includes(".reserved" + path.sep)) {
            const err = new Error(
                `EPERM: simulated ack unlink failure: unlink '${p}'`,
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
const { pollMailbox, ackMessages, writeMailboxMessage, releaseStaleReservations } =
    await import("../src/messaging/mailbox.js")
import { inboxPath, reservedPath, processedPath } from "../src/state/paths.js"

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

async function pathExists(p: string): Promise<boolean> {
    try {
        await realFs.access(p)
        return true
    } catch {
        return false
    }
}

afterEach(() => {
    failReservedUnlink = false
})
afterAll(cleanupTmpRoots)

describe("ackMessages unlink swallowed (finding: mailbox-ack-unlink-swallowed)", () => {
    test("non-ENOENT unlink failure during ack must surface, not be swallowed", async () => {
        const root = tmpRoot("mailbox-ack-swallowed")
        const teamDir = `${root}/team`
        const recipient = "alice"

        // --- Fixture: write + poll a message so it lands in reserved/. ---
        const msg = makeMsg("msg-ack-001", "ack me")
        await writeMailboxMessage(teamDir, recipient, msg)
        const polled = await pollMailbox(teamDir, recipient)
        expect(polled.length).toBe(1)

        // The reservation file now exists on disk.
        const rpath = reservedPath(teamDir, recipient, msg.id)
        expect(await pathExists(rpath)).toBe(true)

        // Force fs.unlink to throw EPERM for ".reserved/" paths during ack.
        // ackMessages:257 appends to processed.jsonl FIRST, then :261 unlinks
        // the reservation — the unlink fails (EPERM, non-ENOENT).
        failReservedUnlink = true

        // --- UNFIXED: .catch(()=>{}) at :261 swallows the EPERM →
        //     ackMessages resolves with void → rejects assertion FAILS.
        // --- FIXED: non-ENOENT error propagates from the unlink →
        //     ackMessages rejects → rejects assertion PASSES. ---
        await expect(
            ackMessages(teamDir, recipient, polled),
        ).rejects.toThrow(/EPERM/)

        // Evidence of the harm: the message was already appended to
        // processed.jsonl (:257 ran before the failed unlink at :261), yet
        // the reservation file remains on disk. releaseStaleReservations
        // will eventually reap it and re-deliver a duplicate.
        expect(await pathExists(rpath)).toBe(true)
    })

    test("swallowed ack unlink enables stale-reaper redelivery of processed message", async () => {
        const root = tmpRoot("mailbox-ack-redeliver")
        const teamDir = `${root}/team`
        const recipient = "alice"

        // --- Fixture: write + poll a message → reserved/. ---
        const msg = makeMsg("msg-redeliver-001", "process me")
        await writeMailboxMessage(teamDir, recipient, msg)
        const polled = await pollMailbox(teamDir, recipient)
        expect(polled.length).toBe(1)

        const rpath = reservedPath(teamDir, recipient, msg.id)

        // --- ackMessages with a swallowed unlink failure (UNFIXED path). ---
        failReservedUnlink = true
        // On UNFIXED code this resolves (EPERM swallowed). On FIXED code it
        // rejects — but we are demonstrating the harm on unfixed code, so
        // swallow the rejection here to continue the scenario.
        await ackMessages(teamDir, recipient, polled).catch(() => {
            // FIXED code rejects here — the harm scenario doesn't apply.
        })
        failReservedUnlink = false

        // The message IS in processed.jsonl (append at :257 succeeded).
        const processedRaw = await realFs.readFile(
            processedPath(teamDir, recipient),
            "utf8",
        ).catch(() => "")
        expect(processedRaw).toContain(msg.id)

        // The reservation file ALSO remains (unlink was swallowed at :261).
        expect(await pathExists(rpath)).toBe(true)

        // --- Age the reservation so the reaper considers it stale.
        //     Rewrite its content with an old reservedAt (well beyond
        //     RESERVATION_TTL_MS = 30s) and touch the mtime back in time. ---
        const agedContent = JSON.stringify({
            ...msg,
            deliveryStatus: "delivered",
            reservedAt: Date.now() - 60_000, // 60s ago > 30s TTL
        })
        await realFs.writeFile(rpath, agedContent, "utf8")
        const oldTime = new Date(Date.now() - 60_000)
        await realFs.utimes(rpath, oldTime, oldTime)

        // --- Run the stale-reservation reaper. ---
        await releaseStaleReservations(teamDir, recipient)

        // --- BUG (unfixed): the reaper re-appended the already-processed
        //     message to the inbox → the recipient will see a DUPLICATE on
        //     the next poll. processed.jsonl already has it, AND now the
        //     inbox has it again.
        // --- FIXED: ackMessages would have rejected (not swallowed), so
        //     the caller knows the ack failed and the reservation's
        //     presence is expected/surprising rather than silently lost. ---
        const inboxRaw = await realFs.readFile(
            inboxPath(teamDir, recipient),
            "utf8",
        ).catch(() => "")
        const inboxLines = inboxRaw.split("\n").filter(l => l.length > 0)

        // The inbox must NOT contain a redelivered copy of an already-
        // processed message. On unfixed code it DOES (the bug).
        const redelivered = inboxLines.some(
            l => { try { return JSON.parse(l).id === msg.id } catch { return false } },
        )
        expect(redelivered).toBe(false)
    })
})

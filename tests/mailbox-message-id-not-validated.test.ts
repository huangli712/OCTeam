/**
 * Regression test for confirmed finding "mailbox-message-id-not-validated".
 *
 * Bug: src/messaging/mailbox.ts:105-113 — isValidMessage checks only that
 * id/from/body are strings. It does NOT validate that `id` is a safe path
 * segment. pollMailbox (mailbox.ts:197) passes msg.id into reservedPath(...),
 * which calls assertSafeSegment(messageId) (paths.ts:78). A tampered inbox
 * entry with an id containing "/", "\", "..", or NUL passes isValidMessage
 * but throws inside pollMailbox at assertSafeSegment — aborting the ENTIRE
 * poll (not just the bad message), blocking delivery of ALL messages in that
 * recipient's inbox.
 *
 * Harm: a single malicious/corrupt inbox line wedges the recipient's mailbox.
 * Every subsequent pollMailbox throws before reserving or truncating, so even
 * legitimate messages are never delivered.
 *
 * Fix: isValidMessage must additionally validate that `id` is a safe path
 * segment (isSafePathSegment) so corrupt entries are skipped at read time,
 * never reaching reservedPath.
 *
 * This test writes a tampered inbox line (valid JSON, valid string fields, but
 * id contains a path separator), then calls pollMailbox and asserts:
 *   1. pollMailbox does NOT throw (the bad entry is skipped, not fatal).
 *   2. A legitimate message in the same inbox IS still delivered.
 * On UNFIXED code: pollMailbox throws (assertSafeSegment rejects the bad id) →
 * test FAILS. On FIXED code: isValidMessage rejects the bad entry at read time,
 * pollMailbox delivers only the good message → test PASSES.
 */

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import type { Message } from "../src/core/types.js"
import { pollMailbox, writeMailboxMessage } from "../src/messaging/mailbox.js"
import { inboxPath } from "../src/state/paths.js"
import { cleanupTmpRoots, tmpRoot, writeRawInboxLine } from './helpers.js';

afterAll(cleanupTmpRoots)

describe("mailbox message id not validated (finding: mailbox-message-id-not-validated)", () => {
    test("a tampered inbox entry with an unsafe id must not block pollMailbox delivery", async () => {
        const teamDir = tmpRoot("mb-id-unsafe")

        // --- A legitimate message written via the proper API. ---
        const goodMsg: Message = {
            version: 1,
            id: "legit-001",
            from: "alice",
            to: "bob",
            kind: "message",
            body: "hello bob",
            timestamp: Date.now(),
            deliveryStatus: "pending",
        } as Message
        await writeMailboxMessage(teamDir, "bob", goodMsg)

        // --- A tampered line: valid JSON, id/from/body are strings, BUT id
        //     contains a path separator. This passes isValidMessage (which
        //     only checks typeof === "string") but throws at
        //     reservedPath → assertSafeSegment inside pollMailbox. ---
        const tampered = {
            version: 1,
            id: "../../etc/passwd",  // unsafe path segment
            from: "eve",
            to: "bob",
            kind: "message",
            body: "forged",
            timestamp: Date.now(),
            deliveryStatus: "pending",
        }
        await writeRawInboxLine(teamDir, "bob", JSON.stringify(tampered))

        // --- pollMailbox must NOT throw ---
        // On UNFIXED code: reservedPath(teamDir, "bob", "../../etc/passwd")
        // calls assertSafeSegment → throws → pollMailbox rejects → FAIL.
        // On FIXED code: isValidMessage rejects the tampered entry at read
        // time → pollMailbox processes only the good message → PASS.
        const polled = await pollMailbox(teamDir, "bob")

        // --- The legitimate message must still be delivered ---
        expect(polled).toHaveLength(1)
        expect(polled[0].id).toBe("legit-001")
    })
})

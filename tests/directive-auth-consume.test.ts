/**
 * C-5 regression: ackMessages must consume directive auth records when the
 * registered directive has a runId. Pre-fix consumeDirectiveAuth(msg) was
 * called without activeRunId, so the fail-closed check inside
 * isAuthenticatedDirective rejected the match → no consumption → the same
 * directive could be replayed after ack and still receive [DIRECTIVE]
 * priority in the next poll.
 *
 * The fix passes msg.runId as activeRunId at ack time, so:
 *  - msg.runId matches the registered runId → consume succeeds.
 *  - registered directive has no runId (legacy) → consume succeeds
 *    (activeRunId undefined short-circuits the runId check).
 *  - msg.runId does not match the registered runId → consume fails (anomaly).
 */
import { afterAll, describe, expect, test } from "bun:test"

import { authenticateDirective, consumeDirectiveAuth, isAuthenticatedDirective, __test__ as authTest } from "../src/messaging/auth.js"
import { ackMessages } from "../src/messaging/mailbox.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"
import { mailboxDir } from "../src/state/paths.js"
import { mkdir } from "node:fs/promises"

afterAll(cleanupTmpRoots)

describe("consumeDirectiveAuth runId binding (C-5)", () => {
    test("consumeDirectiveAuth deletes a registered directive with runId when msg.runId matches", () => {
        const msg = {
            version: 1 as const,
            id: "id-1",
            from: "master",
            to: "alice",
            kind: "directive" as const,
            body: "stop",
            timestamp: 1,
            runId: "r1",
            deliveryStatus: "pending" as const,
        }
        const before = authTest.authDirectiveMapSize()
        authenticateDirective(msg, "team", "r1")

        // Before ack: directive is authenticated.
        expect(isAuthenticatedDirective(msg, "r1")).toBe(true)

        // ack-time consumption with msg.runId must succeed.
        expect(consumeDirectiveAuth(msg, msg.runId)).toBe(true)

        // After ack: replay is no longer authenticated.
        expect(isAuthenticatedDirective(msg, "r1")).toBe(false)
        expect(authTest.authDirectiveMapSize()).toBe(before)
    })

    test("ackMessages consumes directive auth so a subsequent poll-time replay is rejected", async () => {
        const root = tmpRoot("c5-ack")
        const recipient = "alice"
        // mailboxDir requires a team directory; use the tmp root directly.
        const mailDir = mailboxDir(root)
        await mkdir(mailDir, { recursive: true })

        const msg = {
            version: 1 as const,
            id: "id-ack",
            from: "master",
            to: recipient,
            kind: "directive" as const,
            body: "halt",
            timestamp: 1,
            runId: "r-ack",
            deliveryStatus: "pending" as const,
        }

        // Register the directive (mimics writeMailboxMessage during a real run).
        authenticateDirective(msg, "team", "r-ack")
        expect(isAuthenticatedDirective(msg, "r-ack")).toBe(true)

        // ackMessages writes the processed entry, then attempts to consume the
        // directive auth (the unlink fails harmlessly with ENOENT — no
        // reservation file exists in this test, only the in-memory registry
        // matters here).
        // Pre-fix: consumeDirectiveAuth(msg) → fails runId check → not consumed.
        // Post-fix: consumeDirectiveAuth(msg, msg.runId) → consumed.
        try {
            await ackMessages(root, recipient, [msg])
        } catch {
            // unlink ENOENT is OK; the consume call already ran.
        }

        expect(isAuthenticatedDirective(msg, "r-ack")).toBe(false)
    })

    test("legacy directive without runId is still consumable (backward compat)", () => {
        const msg = {
            version: 1 as const,
            id: "id-legacy",
            from: "master",
            to: "alice",
            kind: "directive" as const,
            body: "old",
            timestamp: 1,
            deliveryStatus: "pending" as const,
        }
        authenticateDirective(msg, "team") // no runId
        expect(isAuthenticatedDirective(msg)).toBe(true)
        expect(consumeDirectiveAuth(msg)).toBe(true)
        expect(isAuthenticatedDirective(msg)).toBe(false)
    })
})

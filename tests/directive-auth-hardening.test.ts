/**
 * Regression tests for C-2 (directive authentication hardening).
 *
 * Three confirmed gaps in messaging/auth.ts + deliver.ts + hooks.ts:
 *
 * 1. Cross-run replay fail-open: isAuthenticatedDirective only checks runId
 *    binding when BOTH registered.runId AND activeRunId are defined. If
 *    registered.runId is set but activeRunId is undefined (e.g. team state
 *    unreadable in hooks.ts:298-302), the runId check is SKIPPED and a
 *    directive authenticated for an ended run still receives [DIRECTIVE]
 *    priority.
 *
 * 2. Broadcast recipient overwrite: deliverToRecipients spreads `{...base, to: r}`
 *    per recipient but keeps the SAME message id. authenticateDirective then
 *    uses id as the map key, so each recipient's auth registration overwrites
 *    the previous; only the LAST recipient sees [DIRECTIVE]. Earlier
 *    recipients are silently downgraded.
 *
 * 3. Replay-after-ack: authenticatedDirective IDs are NEVER consumed. The
 *    same JSONL line replayed (re-appended to inbox) after a successful ack
 *    still matches the in-memory auth record and re-receives [DIRECTIVE]
 *    priority, breaking the one-shot contract documented at auth.ts:9-14.
 */

import { afterAll, describe, expect, test } from "bun:test"

import type { Message } from "../src/core/types.js"
import { authenticateDirective, isAuthenticatedDirective, consumeDirectiveAuth } from "../src/messaging/auth.js"
import { formatMailboxInjection } from "../src/messaging/format.js"
import { cleanupTmpRoots, tmpRoot, writeRawInboxLine } from "./helpers.js"
import { pollMailbox, writeMailboxMessage } from "../src/messaging/mailbox.js"

afterAll(cleanupTmpRoots)

function makeDirective(overrides: Partial<Message> = {}): Message {
    return {
        version: 1,
        id: `dir-${Math.random().toString(36).slice(2)}`,
        from: "master",
        to: "bob",
        kind: "directive",
        body: "Legitimate body.",
        timestamp: Date.now(),
        deliveryStatus: "pending",
        ...overrides,
    } as Message
}

describe("C-2.1: cross-run replay must fail CLOSED when activeRunId is undefined", () => {
    test("directive authenticated with runId=A is rejected when activeRunId is undefined", () => {
        const msg = makeDirective({ id: "run-bound-001" })
        authenticateDirective(msg, "teamX", "run-A")

        // Active run unknown (team state unreadable, or no active task).
        // Pre-fix: skipped the runId check → returns true (fail-open).
        // Post-fix: registered.runId is set, activeRunId is undefined → reject.
        expect(isAuthenticatedDirective(msg, undefined)).toBe(false)
    })

    test("directive authenticated with runId=A is rejected when activeRunId is run-B", () => {
        const msg = makeDirective({ id: "run-bound-002" })
        authenticateDirective(msg, "teamX", "run-A")
        expect(isAuthenticatedDirective(msg, "run-B")).toBe(false)
    })

    test("directive authenticated with runId=A is accepted when activeRunId is run-A", () => {
        const msg = makeDirective({ id: "run-bound-003" })
        authenticateDirective(msg, "teamX", "run-A")
        expect(isAuthenticatedDirective(msg, "run-A", "teamX")).toBe(true)
    })

    test("directive authenticated WITHOUT runId (legacy/unscoped) still passes when activeRunId is undefined", () => {
        const msg = makeDirective({ id: "unscoped-001" })
        // No runId provided at authentication time → backward-compat: passes.
        authenticateDirective(msg, "teamX", undefined)
        expect(isAuthenticatedDirective(msg, undefined, "teamX")).toBe(true)
    })
})

describe("C-2.2: broadcast recipient auth must not overwrite earlier recipients", () => {
    test("broadcast to multiple recipients: EACH recipient's polled directive renders as [DIRECTIVE]", async () => {
        const teamDir = tmpRoot("dir-broadcast")
        const id = "broadcast-001"
        const runId = "run-broadcast"

        // Simulate the deliverToRecipients flow: ONE base message, written
        // per-recipient with `to` mutated but `id` and `runId` preserved.
        // The auth binding must be recorded per (to, id), not just per id,
        // otherwise only the last write wins.
        const recipients = ["alice", "bob", "carol"]
        for (const r of recipients) {
            const msg = makeDirective({ id, to: r, runId } as Partial<Message>)
            // writeMailboxMessage performs both the JSONL append AND the auth
            // registration (via authenticateDirective internally).
            await writeMailboxMessage(teamDir, r, msg, undefined, { teamName: "teamBc", runId })
        }

        // Each recipient polls and formats independently.
        for (const r of recipients) {
            const polled = await pollMailbox(teamDir, r)
            expect(polled).toHaveLength(1)
            const injection = formatMailboxInjection(polled, runId, "teamBc")
            // Pre-fix: only the LAST recipient (carol) sees [DIRECTIVE];
            // alice and bob are silently downgraded.
            // Post-fix: every recipient sees [DIRECTIVE].
            expect(injection).toContain("[DIRECTIVE]")
        }
    })
})

describe("C-2.3: authenticated directives must be consumed after delivery (one-shot)", () => {
    test("replay of same JSONL after ack no longer receives [DIRECTIVE]", async () => {
        const teamDir = tmpRoot("dir-replay-after-ack")
        const legit = makeDirective({ id: "oneshot-001" })
        // Legitimate write registers the auth binding.
        await writeMailboxMessage(teamDir, "bob", legit)
        const polled = await pollMailbox(teamDir, "bob")
        expect(polled).toHaveLength(1)

        // First delivery renders as [DIRECTIVE] — auth is registered.
        expect(formatMailboxInjection(polled, undefined, teamDir)).toContain("[DIRECTIVE]")

        // After delivery, the auth MUST be consumed so a replay (same JSONL
        // re-appended via FS tampering) cannot re-trigger [DIRECTIVE].
        consumeDirectiveAuth(polled[0], teamDir)
        expect(isAuthenticatedDirective(polled[0], undefined, teamDir)).toBe(false)

        // Simulate the replay attack: same JSONL appended again after ack.
        await writeRawInboxLine(teamDir, "bob", JSON.stringify(legit))
        const replayed = await pollMailbox(teamDir, "bob")
        expect(replayed).toHaveLength(1)
        // Pre-fix: auth record still in the map → [DIRECTIVE] re-rendered.
        // Post-fix: auth was consumed → directive downgraded to regular msg.
        expect(formatMailboxInjection(replayed, undefined, teamDir)).not.toContain("[DIRECTIVE]")
    })

    test("consumeDirectiveAuth is idempotent (second consume is a no-op)", () => {
        const msg = makeDirective({ id: "idempotent-001" })
        authenticateDirective(msg, "teamI", undefined)
        expect(isAuthenticatedDirective(msg, undefined, "teamI")).toBe(true)
        expect(consumeDirectiveAuth(msg, "teamI")).toBe(true)
        expect(consumeDirectiveAuth(msg, "teamI")).toBe(false) // already consumed
        expect(isAuthenticatedDirective(msg, undefined, "teamI")).toBe(false)
    })
})

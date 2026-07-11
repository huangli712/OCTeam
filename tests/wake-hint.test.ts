/**
 * Coverage tests for src/messaging/wake-hint.ts — the throttled Layer-2 nudge.
 *
 * sendWakeHint sends a lightweight promptAsync to an idle session with unread
 * mailbox messages. Two contracts:
 *   1. Throttled per-session to 1/30s (avoids wake loops).
 *   2. Best-effort: a promptAsync failure is swallowed (the Transform hook is
 *      the source of truth for delivery, not the wake hint).
 * clearWakeHint resets the throttle so the next call goes through immediately.
 *
 * Module-level throttle state (wakeHintLastSent Map) is shared across tests,
 * so each test calls clearWakeHint in beforeEach to start from a clean state.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import { clearWakeHint, sendWakeHint } from "../src/messaging/wake-hint.js"
import { makeCtx } from "./helpers.js"


/** Captures every promptAsync call: which session got which body. */
type Call = { sessionId: string; text: string }


// Module-level throttle state (wakeHintLastSent) persists across tests.
// Reset it before each test so prior throttling doesn't bleed in.
beforeEach(() => {
    clearWakeHint("ses_a")
    clearWakeHint("ses_b")
})

describe("sendWakeHint", () => {
    test("sends promptAsync with unread count in the reminder text", async () => {
        const calls: Call[] = []
        const ctx = makeCtx({ calls: calls })
        await sendWakeHint(ctx, "ses_a", 3)
        expect(calls).toHaveLength(1)
        expect(calls[0]?.sessionId).toBe("ses_a")
        expect(calls[0]?.text).toContain("3")
        expect(calls[0]?.text).toContain("team message")
    })

    test("throttles: second call within 30s window is skipped", async () => {
        const calls: Call[] = []
        const ctx = makeCtx({ calls: calls })
        await sendWakeHint(ctx, "ses_a", 1)
        await sendWakeHint(ctx, "ses_a", 2)
        expect(calls).toHaveLength(1)
    })

    test("throttle is per-session: different sessions are not blocked", async () => {
        const calls: Call[] = []
        const ctx = makeCtx({ calls: calls })
        await sendWakeHint(ctx, "ses_a", 1)
        await sendWakeHint(ctx, "ses_b", 2)
        expect(calls).toHaveLength(2)
    })

    test("does NOT throw when promptAsync rejects (best-effort)", async () => {
        const ctx = {
            client: {
                session: {
                    promptAsync: mock(async () => {
                        throw new Error("session gone")
                    }),
                },
            },
        } as unknown as PluginContext
        expect(sendWakeHint(ctx, "ses_a", 1)).resolves.toBeUndefined()
    })
})

describe("clearWakeHint", () => {
    test("resets throttle so the next sendWakeHint goes through immediately", async () => {
        const calls: Call[] = []
        const ctx = makeCtx({ calls: calls })
        await sendWakeHint(ctx, "ses_a", 1)
        expect(calls).toHaveLength(1)
        // Without clear, second call would be throttled.
        await sendWakeHint(ctx, "ses_a", 2)
        expect(calls).toHaveLength(1)
        // After clear, the next call bypasses the 30s window.
        clearWakeHint("ses_a")
        await sendWakeHint(ctx, "ses_a", 3)
        expect(calls).toHaveLength(2)
    })

    test("is safe to call on a session that was never throttled (no-op)", () => {
        expect(() => clearWakeHint("never_seen")).not.toThrow()
    })
})

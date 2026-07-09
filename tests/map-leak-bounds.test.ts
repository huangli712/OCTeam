/**
 * Regression coverage for bounded in-memory Maps in wake-hint.ts and
 * mailbox.ts. Without the eviction guard, wakeHintLastSent and
 * authenticatedDirectives grow unboundedly on long-lived hosts where
 * sessions end without a team_delete (the only clearWakeHint caller).
 *
 * Each Map caps at 64 entries; once exceeded the oldest entries are
 * evicted on the next write.
 */
import { describe, expect, test } from "bun:test"

import { _wakeHintMapSizeForTests, clearWakeHint, sendWakeHint } from "../src/messaging/wake-hint.js"
import { _authDirectiveMapSizeForTests, authenticateDirective } from "../src/messaging/mailbox.js"
import type { Message } from "../src/core/types.js"
import type { PluginContext } from "../src/core/context.js"

const CAP = 64

function noopCtx(): PluginContext {
    return {
        client: { session: { promptAsync: async () => ({ data: {} }) } },
    } as unknown as PluginContext
}

function makeDirective(id: string): Message {
    return {
        version: 1,
        id,
        from: "orchestrator",
        to: "alice",
        kind: "directive",
        body: "do X",
        timestamp: Date.now(),
        deliveryStatus: "pending",
    }
}

describe("wake-hint Map eviction", () => {
    test("inserting beyond the cap evicts the oldest entries", async () => {
        // Clean slate for the ids we will use.
        for (let i = 0; i < CAP + 10; i++) clearWakeHint(`ses_evict_${i}`)
        const ctx = noopCtx()
        // Write CAP + 10 distinct sessions — each throttled so only the first
        // per session lands, but every session still gets an entry.
        for (let i = 0; i < CAP + 10; i++) {
            await sendWakeHint(ctx, `ses_evict_${i}`, 1)
        }
        expect(_wakeHintMapSizeForTests()).toBeLessThanOrEqual(CAP)
        // Cleanup.
        for (let i = 0; i < CAP + 10; i++) clearWakeHint(`ses_evict_${i}`)
    })
})

describe("authenticatedDirectives Map eviction", () => {
    test("inserting beyond the cap evicts the oldest entries", () => {
        const before = _authDirectiveMapSizeForTests()
        for (let i = 0; i < CAP + 10; i++) {
            authenticateDirective(makeDirective(`dir_evict_${i}_${Date.now()}_${i}`))
        }
        expect(_authDirectiveMapSizeForTests() - before).toBeLessThanOrEqual(CAP)
    })
})

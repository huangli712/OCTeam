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

import { __test__ as wakeHintTest, clearWakeHint, sendWakeHint } from "../src/messaging/wake-hint.js"
import { __test__ as mailboxTest, authenticateDirective } from "../src/messaging/auth.js"
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
        expect(wakeHintTest.wakeHintMapSize()).toBeLessThanOrEqual(CAP)
        // Cleanup.
        for (let i = 0; i < CAP + 10; i++) clearWakeHint(`ses_evict_${i}`)
    })
})

describe("authenticatedDirectives Map eviction", () => {
    const AUTH_CAP = mailboxTest.AUTH_DIRECTIVE_MAP_CAP
    test("fresh entries exceed cap but aged entries are evicted", () => {
        for (let i = 0; i < AUTH_CAP + 10; i++) {
            authenticateDirective(makeDirective(`dir_evict_${i}_${Date.now()}_${i}`))
        }
        // The auth map now enforces a hard cap regardless of age. Pre-fix
        // code allowed fresh entries to grow the map unbounded; a hard
        // 512-item ceiling prevents OOM.
        expect(mailboxTest.authDirectiveMapSize()).toBeLessThanOrEqual(AUTH_CAP)
        // Age them past the minimum and insert one more to trigger further eviction.
        mailboxTest.backdateAuthEntries(mailboxTest.AUTH_MIN_AGE_MS + 1000)
        authenticateDirective(makeDirective(`dir_trigger_${Date.now()}`))
        expect(mailboxTest.authDirectiveMapSize()).toBeLessThanOrEqual(AUTH_CAP)
    })
})

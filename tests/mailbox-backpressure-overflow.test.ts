/**
 * Regression test for confirmed finding "mailbox-backpressure-allows-overflow".
 *
 * Bug: src/tools/coordination/messaging.ts:90-93 checks the recipient's CURRENT unread inbox
 * byte size and rejects only when `bytes > messageUnreadMaxBytes`. It does NOT
 * add the size of the NEW message being sent. So a mailbox that is near the
 * limit (e.g. 990 bytes with a 1000-byte cap) passes the check, then the new
 * message (say 500 bytes) is appended — pushing the inbox to 1490 bytes, well
 * over the 1000-byte cap. The backpressure check is off-by-one-message: it
 * gates on the pre-write size instead of the post-write size.
 *
 * Harm: the messageUnreadMaxBytes backpressure limit exists to bound
 * unbounded inbox growth (a slow consumer vs. fast producer). Checking only
 * the current size means the cap is only enforced AFTER the limit is already
 * breached by a prior write — every single message that crosses the boundary
 * was allowed through.
 *
 * Fix: compute `bytes + newMessageSize` and reject when that projected total
 * exceeds messageUnreadMaxBytes, so the post-write size always respects the cap.
 *
 * This test fills a recipient's inbox to just under the cap, sends one more
 * message, and asserts the inbox never exceeds the cap. On UNFIXED code the
 * near-limit check passes and the new message overflows it → test FAILS. On
 * FIXED code the projected total exceeds the cap → message rejected → PASS.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import type { ToolContext } from "@opencode-ai/plugin"
import { teamSendMessageTool } from "../src/tools/coordination/messaging.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { indexMember, unindexSession } from "../src/state/resolve.js"
import { writeMailboxMessage } from "../src/messaging/mailbox.js"
import { inboxPath } from "../src/state/paths.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"
import type { Message } from "../src/core/types.js"


afterAll(cleanupTmpRoots)

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("mailbox backpressure overflow (finding: mailbox-backpressure-allows-overflow)", () => {
    test("a message that would push the inbox over the cap must be rejected", async () => {
        const root = tmpRoot("mb-overflow")
        const leadSid = "ses_mb_overflow_lead"
        const aliceSid = "ses_mb_overflow_alice"
        const bobSid = "ses_mb_overflow_bob"
        tracked.push(aliceSid, bobSid)

        // --- Team with a TIGHT backpressure cap for easy arithmetic. ---
        const alice = makeMember("alice", aliceSid)
        const bob = makeMember("bob", bobSid)
        const state = makeState("alpha", leadSid, [alice, bob])
        state.bounds.messageUnreadMaxBytes = 1000
        await initTeamState(root, state, leadSid)
        const team = await loadTeamState(root, "alpha", leadSid)

        // Index alice as the sender (resolveCallerInTeam needs it).
        indexMember(aliceSid, "alpha", "alice", leadSid, root)

        // --- Pre-fill bob's inbox to 900 bytes (under the 1000 cap).
        //     writeMailboxMessage appends the JSON-serialized Message + "\n".
        //     We craft bodies so the total inbox lands close to 900 bytes. ---
        const fillMsg = (id: string, body: string): Message => ({
            version: 1,
            id,
            from: "alice",
            to: "bob",
            kind: "message",
            body,
            timestamp: Date.now(),
            deliveryStatus: "pending",
        } as Message)

        // Each JSONL line is the full Message JSON + "\n". Write enough to get
        // the inbox near 900 bytes. We write a few messages and then check.
        let currentBytes = 0
        const targetPreFill = 900
        let msgIdx = 0
        while (currentBytes < targetPreFill) {
            const remaining = targetPreFill - currentBytes
            // Each line has ~120 bytes of JSON overhead (version, id, from, to,
            // kind, timestamp, deliveryStatus). Size body to fill the gap.
            const overhead = 130
            const bodyLen = Math.max(10, remaining - overhead)
            const body = "x".repeat(bodyLen)
            const msg = fillMsg(`fill-${msgIdx++}`, body)
            const lineLen = Buffer.byteLength(JSON.stringify(msg) + "\n", "utf8")
            await writeMailboxMessage(team.directory, "bob", msg)
            currentBytes += lineLen
        }

        // Sanity: the inbox is under the cap but close to it.
        const { stat } = await import("node:fs/promises")
        const preSize = (await stat(inboxPath(team.directory, "bob"))).size
        expect(preSize).toBeLessThan(1000)
        expect(preSize).toBeGreaterThan(800)

        // --- Send a message that WILL push the inbox over the cap.
        //     The new message body is large enough that preSize + newLine > 1000.
        //     (preSize is ~900; even a modest body + JSON overhead exceeds 100.) ---
        const tool = teamSendMessageTool(makeCtx({ storageRoot: root }))
        const newBody = "y".repeat(200) // 200 bytes body → ~330-byte line
        await tool.execute(
            { team_id: "alpha", to: "bob", body: newBody },
            { sessionID: aliceSid } as unknown as ToolContext,
        )

        // --- ASSERT: the total inbox size must NOT exceed messageUnreadMaxBytes ---
        // On UNFIXED code: the check `bytes > limit` uses the PRE-write size
        // (900 < 1000 → pass), then appends → inbox is now ~1230 → FAIL.
        // On FIXED code: the projected total (900 + 330 = 1230 > 1000) →
        // rejected → inbox stays at ~900 → PASS.
        const postSize = (await stat(inboxPath(team.directory, "bob"))).size
        expect(postSize).toBeLessThanOrEqual(state.bounds.messageUnreadMaxBytes)
    })
})

/**
 * Coverage tests for src/messaging/deliver.ts — recipient delivery helper.
 *
 * deliverToRecipients writes a message to each recipient's mailbox (Layer 1)
 * and sends a best-effort wake hint to idle recipients (Layer 2). Two key
 * contracts:
 *   1. Per-recipient failure isolation: one bad write must NOT abort the
 *      remaining recipients (partial broadcast).
 *   2. Aggregated error: if any recipient failed, throw an Error listing them.
 *
 * Uses a real tmp team directory so mailbox writes hit the real filesystem.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { Message } from "../src/core/types.js"
import { deliverToRecipients } from "../src/messaging/deliver.js"
import { countUnreadMessages } from "../src/messaging/mailbox.js"
import { clearWakeHint } from "../src/messaging/wake-hint.js"
import { initTeamState } from "../src/state/store.js"
import { inboxPath } from "../src/state/paths.js"
import type { Team } from "../src/state/store.js"
import fs from "node:fs/promises"
import { cleanupTmpRoots, makeMember, makeState, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

// Reset wake-hint throttle state between tests so prior calls don't suppress
// the wake hints we're verifying here.
beforeEach(() => {
    clearWakeHint("ses_alice")
    clearWakeHint("ses_bob")
    clearWakeHint("ses_carol")
})

/** Captures promptAsync calls (wake hint verification). */
type HintCall = { sessionId: string }

function makeCtx(hints: HintCall[]): PluginContext {
    return {
        client: {
            app: { log: mock(async () => ({ data: {} })) },
            session: {
                promptAsync: mock(async (args: any) => {
                    hints.push({ sessionId: args.path.id })
                    return { data: {} }
                }),
            },
        },
    } as unknown as PluginContext
}

function makeBase(from: string, body: string): Omit<Message, "to"> {
    return {
        version: 1,
        id: `msg-${Math.random().toString(36).slice(2)}`,
        from,
        kind: "message",
        body,
        timestamp: Date.now(),
        deliveryStatus: "pending",
    }
}

async function setupTeam(
    root: string,
    members: Array<Partial<ReturnType<typeof makeMember>>>,
): Promise<{ team: Team; storageRoot: string }> {
    const storageRoot = `${root}/project`
    await fs.mkdir(storageRoot, { recursive: true })
    const memberStates = members.map(m => makeMember(m.name!, m.sessionId))
    // Apply status overrides (makeMember defaults to "idle").
    members.forEach((m, i) => {
        if (m.status) memberStates[i]!.status = m.status
    })
    const state = makeState("alpha", "ses_lead", memberStates)
    const team = await initTeamState(storageRoot, state, "ses_lead")
    return { team, storageRoot }
}

describe("deliverToRecipients", () => {
    test("writes a mailbox message for each recipient", async () => {
        const root = tmpRoot("deliver-happy")
        const { team } = await setupTeam(root, [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
        ])
        const ctx = makeCtx([])

        await deliverToRecipients(ctx, team, ["alice", "bob"], makeBase("master", "hello"))

        expect(await countUnreadMessages(team.directory, "alice")).toBe(1)
        expect(await countUnreadMessages(team.directory, "bob")).toBe(1)
    })

    test("sends wake hint only to idle members with sessionId", async () => {
        const root = tmpRoot("deliver-wake")
        const { team } = await setupTeam(root, [
            { name: "alice", sessionId: "ses_alice", status: "idle" },
            { name: "bob", sessionId: "ses_bob", status: "running" },
            { name: "carol" }, // no sessionId
        ])
        const hints: HintCall[] = []
        const ctx = makeCtx(hints)

        await deliverToRecipients(ctx, team, ["alice", "bob", "carol"], makeBase("master", "hi"))

        // Only alice (idle + has sessionId) gets a wake hint.
        expect(hints).toEqual([{ sessionId: "ses_alice" }])
    })

    test("isolates per-recipient failures: remaining recipients still receive", async () => {
        const root = tmpRoot("deliver-partial")
        const { team } = await setupTeam(root, [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
        ])

        // Sabotage bob's inbox: create a DIRECTORY where the inbox FILE
        // (mailbox/bob.jsonl) is expected, so appendFile fails with EISDIR.
        const bobInbox = inboxPath(team.directory, "bob")
        await fs.mkdir(bobInbox, { recursive: true })

        const ctx = makeCtx([])

        // The call throws (bob failed) but alice's write happened first.
        await expect(
            deliverToRecipients(ctx, team, ["alice", "bob"], makeBase("master", "x")),
        ).rejects.toThrow(/delivery failed for: bob/)

        // alice received her message despite bob's failure.
        expect(await countUnreadMessages(team.directory, "alice")).toBe(1)
    })

    test("aggregated error lists ALL failed recipients, not just the first", async () => {
        const root = tmpRoot("deliver-multi-fail")
        const { team } = await setupTeam(root, [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
            { name: "carol", sessionId: "ses_carol" },
        ])

        // Sabotage both bob and carol inboxes (DIRECTORY where FILE expected).
        for (const name of ["bob", "carol"]) {
            await fs.mkdir(inboxPath(team.directory, name), { recursive: true })
        }

        const ctx = makeCtx([])

        await expect(
            deliverToRecipients(ctx, team, ["alice", "bob", "carol"], makeBase("master", "x")),
        ).rejects.toThrow(/bob.*carol/)
    })

    test("does not throw when all recipients succeed", async () => {
        const root = tmpRoot("deliver-ok")
        const { team } = await setupTeam(root, [
            { name: "alice", sessionId: "ses_alice" },
        ])
        const ctx = makeCtx([])
        await expect(
            deliverToRecipients(ctx, team, ["alice"], makeBase("master", "ok")),
        ).resolves.toBeUndefined()
    })
})

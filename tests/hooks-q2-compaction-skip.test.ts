/**
 * Coverage-gap regression tests for hooks.ts Q2 (compaction-skip) TTL behavior
 * (audit 2026-06-30 finding #7).
 *
 * Q2 protects against double-delivery during session compaction: the transform
 * hook fires both on live turns AND on compaction clones. Injecting into a
 * clone is lost but pollMailbox+ackMessages have real side effects → silent
 * message loss. The compacting flag (set by createCompactingHook) marks a
 * session so the very next transform skips injection; TTL bounds a stuck flag
 * to a single delayed turn.
 *
 * These tests cover the three branches at hooks.ts:187-191:
 *   - no flag → transform proceeds (injection happens)
 *   - flag set, Date.now() < deadline → transform skips (consume-once)
 *   - flag set, Date.now() >= deadline → transform proceeds (TTL expired)
 *
 * TUI render branches (audit #7 second half) are host-only reachable and
 * excluded from this file's scope.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { MemberState, Message, TeamState } from "../src/core/types.js"
import { createCompactingHook, createTransformHook } from "../src/hooks.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { writeMailboxMessage } from "../src/messaging/mailbox.js"
import { cleanupTmpRoots, makeMember, makeState, tmpRoot } from "./helpers.js"

const TEAM = "q2-team"

afterAll(cleanupTmpRoots)
const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

function makeCtx(root: string): PluginContext {
    return {
        storageRoot: root,
        scope: "project",
        client: {
            session: { promptAsync: async () => ({}) },
            app: { log: async () => ({}) },
        },
    } as unknown as PluginContext
}

function mkMessage(id: string, to: string): Message {
    return {
        version: 1,
        id,
        from: "master",
        to,
        kind: "message",
        body: `body-${id}`,
        timestamp: Date.now(),
        deliveryStatus: "pending",
    }
}

async function setup(opts: {
    root: string
    masterSid: string
    memberName: string
    memberSid: string
}): Promise<{ directory: string; memberSid: string }> {
    const members: MemberState[] = [makeMember(opts.memberName, opts.memberSid)]
    const state: TeamState = {
        ...makeState(TEAM, opts.masterSid, members, Date.now()),
        status: "live",
    }
    await initTeamState(opts.root, state, opts.masterSid)
    await rebuildSessionIndex(opts.root, `${opts.root}__unused`)
    const team = await loadTeamState(opts.root, TEAM, opts.masterSid)
    return { directory: team.directory, memberSid: opts.memberSid }
}

/**
 * Build the `output` argument the SDK passes to the transform hook. Includes
 * one user message tagged with the member's sessionID — the contract the Q1
 * fix reads to source sessionID from messages (input is `{}`).
 */
function makeOutput(memberSid: string): { messages: Array<{ info?: { sessionID?: string; role?: string }; parts?: unknown[] }> } {
    return {
        messages: [
            {
                info: { sessionID: memberSid, role: "user" },
                parts: [{ type: "text", text: "user prompt" }],
            },
        ],
    }
}

/** Returns true if the transform injected a synthetic part into messages. */
function wasInjected(output: ReturnType<typeof makeOutput>): boolean {
    for (const m of output.messages) {
        for (const p of (m.parts ?? []) as Array<{ type?: string; synthetic?: boolean }>) {
            if (p.type === "text" && p.synthetic === true) return true
        }
    }
    return false
}

describe("Q2 compaction guard: createTransformHook skips injection when flag is live", () => {
    test("no compacting flag → transform injects normally", async () => {
        const root = tmpRoot("q2-live")
        const memberSid = "ses_q2_live_member"
        tracked.push("ses_q2_live_master", memberSid)
        const { directory } = await setup({
            root,
            masterSid: "ses_q2_live_master",
            memberName: "alice",
            memberSid,
        })
        await writeMailboxMessage(directory, "alice", mkMessage("m-live", "alice"))

        const output = makeOutput(memberSid)
        await createTransformHook(makeCtx(root))({} as never, output as never)
        expect(wasInjected(output)).toBe(true)
    })

    test("compacting flag set, within TTL → transform skips (consume-once)", async () => {
        const root = tmpRoot("q2-skip")
        const memberSid = "ses_q2_skip_member"
        tracked.push("ses_q2_skip_master", memberSid)
        const { directory } = await setup({
            root,
            masterSid: "ses_q2_skip_master",
            memberName: "bob",
            memberSid,
        })
        await writeMailboxMessage(directory, "bob", mkMessage("m-skip", "bob"))

        // Arm the compacting flag.
        const compacting = createCompactingHook()
        await compacting({ sessionID: memberSid } as never)

        const output = makeOutput(memberSid)
        await createTransformHook(makeCtx(root))({} as never, output as never)
        expect(wasInjected(output)).toBe(false)
    })

    test("compacting flag set, TTL expired → transform proceeds (flag still consumed)", async () => {
        const root = tmpRoot("q2-ttl")
        const memberSid = "ses_q2_ttl_member"
        tracked.push("ses_q2_ttl_master", memberSid)
        const { directory } = await setup({
            root,
            masterSid: "ses_q2_ttl_master",
            memberName: "carol",
            memberSid,
        })
        await writeMailboxMessage(directory, "carol", mkMessage("m-ttl", "carol"))

        // Arm the flag, then advance the clock past the 15s TTL.
        const compacting = createCompactingHook()
        await compacting({ sessionID: memberSid } as never)

        const realNow = Date.now
        const future = realNow() + 20_000 // > COMPACTING_FLAG_TTL_MS (15_000)
        Date.now = () => future
        try {
            const output = makeOutput(memberSid)
            await createTransformHook(makeCtx(root))({} as never, output as never)
            // TTL expired: transform treats it as a live turn and injects.
            expect(wasInjected(output)).toBe(true)
        } finally {
            Date.now = realNow
        }

        // Follow-up: a fresh transform (same member, new unread) proceeds — the
        // expired flag was consumed-once by the previous call, so it no longer
        // suppresses anything even with a normal clock.
        await writeMailboxMessage(directory, "carol", mkMessage("m-after", "carol"))
        const output2 = makeOutput(memberSid)
        await createTransformHook(makeCtx(root))({} as never, output2 as never)
        expect(wasInjected(output2)).toBe(true)
    })

    test("compacting flag is consume-once: only the very next transform is skipped", async () => {
        const root = tmpRoot("q2-once")
        const memberSid = "ses_q2_once_member"
        tracked.push("ses_q2_once_master", memberSid)
        const { directory } = await setup({
            root,
            masterSid: "ses_q2_once_master",
            memberName: "dave",
            memberSid,
        })
        await writeMailboxMessage(directory, "dave", mkMessage("m-1", "dave"))
        await writeMailboxMessage(directory, "dave", mkMessage("m-2", "dave"))

        // Arm flag.
        const compacting = createCompactingHook()
        await compacting({ sessionID: memberSid } as never)

        // First transform consumes the flag and skips. (No injection.)
        const out1 = makeOutput(memberSid)
        await createTransformHook(makeCtx(root))({} as never, out1 as never)
        expect(wasInjected(out1)).toBe(false)

        // Second transform is a live turn — flag is gone, injection proceeds.
        const out2 = makeOutput(memberSid)
        await createTransformHook(makeCtx(root))({} as never, out2 as never)
        expect(wasInjected(out2)).toBe(true)
    })
})

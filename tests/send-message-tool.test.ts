/**
 * Coverage-gap regression tests for teamSendMessageTool.execute
 * (src/tools/exchange/messaging.ts).
 *
 * GAP CLOSED: messaging.test.ts only covers the pure isForbiddenLateralMessage
 * predicate and the Transform hook — the tool's execute BODY (auth, payload cap,
 * broadcast-master-only, recipient validation, isolated lateral gate,
 * backpressure, per-run message cap, happy-path delivery) had NO coverage
 * (12.15% line per bun --coverage). These exercise each guard end-to-end.
 */
import { afterEach, describe, expect, test } from "bun:test"

import type { ActiveTask, MemberState, TeamState } from "../src/core/types.js"
import { teamSendMessageTool } from "../src/tools/exchange/messaging.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { countUnreadMessages, writeMailboxMessage } from "../src/messaging/mailbox.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import type { Message } from "../src/core/types.js"
import { makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from './helpers.js';

const TEAM = "alpha"

function makeActiveTask(mode: "isolated" | "cooperative"): ActiveTask {
    return {
        type: "parallel",
        mode,
        startedAt: Date.now(),
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
    }
}

async function setup(opts: {
    root: string
    masterSid: string
    members: MemberState[]
    activeTask?: ActiveTask
    boundsOverride?: Partial<TeamState["bounds"]>
}): Promise<string> {
    const base = makeState(TEAM, opts.masterSid, opts.members, Date.now())
    const state: TeamState = {
        ...base,
        status: opts.activeTask ? "busy" : base.status,
        activeTask: opts.activeTask,
        bounds: { ...base.bounds, ...opts.boundsOverride },
    }
    await initTeamState(opts.root, state, opts.masterSid)
    await rebuildSessionIndex(opts.root, `${opts.root}__unused`)
    const team = await loadTeamState(opts.root, TEAM, opts.masterSid)
    return team.directory
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("teamSendMessageTool.execute: authorization", () => {
    test("caller not a team member → error", async () => {
        const root = tmpRoot("sm-noauth")
        const masterSid = "ses_sm_noauth"
        tracked.push(masterSid)
        await setup({ root, masterSid, members: [makeMember("alice", "ses_alice")] })

        const result = await teamSendMessageTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, to: "alice", body: "hi" },
            makeToolContext("ses_stranger"),
        )
        expect(result).toContain("not a member of this team")
    })
})

describe("teamSendMessageTool.execute: delivery + recipient validation", () => {
    test("member sends point-to-point to master → delivered, mailbox holds the message", async () => {
        const root = tmpRoot("sm-deliver")
        const masterSid = "ses_sm_deliver"
        const aliceSid = "ses_sm_alice"
        tracked.push(masterSid, aliceSid)
        const dir = await setup({
            root,
            masterSid,
            members: [makeMember("alice", aliceSid)],
        })

        const result = await teamSendMessageTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, to: "master", body: "report: done" },
            makeToolContext(aliceSid),
        )
        expect(result).toContain("Message delivered to master")
        expect(await countUnreadMessages(dir, "master")).toBe(1)
    })

    test("unknown recipient → error", async () => {
        const root = tmpRoot("sm-unknown")
        const aliceSid = "ses_sm_unk_alice"
        const masterSid = "ses_sm_unk_master"
        tracked.push(masterSid, aliceSid)
        await setup({ root, masterSid, members: [makeMember("alice", aliceSid)] })

        const result = await teamSendMessageTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, to: "ghost", body: "hi" },
            makeToolContext(aliceSid),
        )
        expect(result).toContain('unknown recipient "ghost"')
    })
})

describe("teamSendMessageTool.execute: broadcast is master-only", () => {
    test("member broadcast (to: '*') → rejected", async () => {
        const root = tmpRoot("sm-bcast-member")
        const aliceSid = "ses_sm_bc_alice"
        const masterSid = "ses_sm_bc_master"
        tracked.push(masterSid, aliceSid)
        await setup({
            root,
            masterSid,
            members: [makeMember("alice", aliceSid), makeMember("bob", "ses_sm_bc_bob")],
        })

        const result = await teamSendMessageTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, to: "*", body: "everyone listen" },
            makeToolContext(aliceSid),
        )
        expect(result).toContain("broadcast (to: \"*\") is master-only")
    })

    test("master broadcast (to: '*') → delivered to every non-master member", async () => {
        const root = tmpRoot("sm-bcast-master")
        const masterSid = "ses_sm_bcm_master"
        tracked.push(masterSid)
        const dir = await setup({
            root,
            masterSid,
            members: [
                makeMember("alice", "ses_sm_bcm_a"),
                makeMember("bob", "ses_sm_bcm_b"),
            ],
        })

        const result = await teamSendMessageTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, to: "*", body: "team-wide notice" },
            makeToolContext(masterSid),
        )
        expect(result).toContain("2 members")
        expect(await countUnreadMessages(dir, "alice")).toBe(1)
        expect(await countUnreadMessages(dir, "bob")).toBe(1)
    })
})

describe("teamSendMessageTool.execute: isolated-mode lateral gate", () => {
    test("member→member in isolated mode → rejected", async () => {
        const root = tmpRoot("sm-isolated")
        const masterSid = "ses_sm_iso_master"
        const aliceSid = "ses_sm_iso_alice"
        tracked.push(masterSid, aliceSid)
        await setup({
            root,
            masterSid,
            members: [makeMember("alice", aliceSid), makeMember("bob", "ses_sm_iso_bob")],
            activeTask: makeActiveTask("isolated"),
        })

        const result = await teamSendMessageTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, to: "bob", body: "lateral chatter" },
            makeToolContext(aliceSid),
        )
        expect(result).toContain("isolated mode forbids member-to-member messaging")
    })

    test("member→member in cooperative mode → allowed", async () => {
        const root = tmpRoot("sm-collab")
        const masterSid = "ses_sm_col_master"
        const aliceSid = "ses_sm_col_alice"
        tracked.push(masterSid, aliceSid)
        const dir = await setup({
            root,
            masterSid,
            members: [makeMember("alice", aliceSid), makeMember("bob", "ses_sm_col_bob")],
            activeTask: makeActiveTask("cooperative"),
        })

        const result = await teamSendMessageTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, to: "bob", body: "collaborate" },
            makeToolContext(aliceSid),
        )
        expect(result).toContain("Message delivered to bob")
        expect(await countUnreadMessages(dir, "bob")).toBe(1)
    })
})

describe("teamSendMessageTool.execute: payload cap + per-run cap", () => {
    test("body over messagePayloadMaxBytes → rejected", async () => {
        const root = tmpRoot("sm-payload")
        const masterSid = "ses_sm_pl_master"
        const aliceSid = "ses_sm_pl_alice"
        tracked.push(masterSid, aliceSid)
        await setup({
            root,
            masterSid,
            members: [makeMember("alice", aliceSid)],
            boundsOverride: { messagePayloadMaxBytes: 10 },
        })

        const result = await teamSendMessageTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, to: "master", body: "this body is definitely longer than ten bytes" },
            makeToolContext(aliceSid),
        )
        expect(result).toContain("exceeds payload limit")
    })

    test("per-run message cap reached → rejected during an active task", async () => {
        const root = tmpRoot("sm-runcap")
        const masterSid = "ses_sm_rc_master"
        const aliceSid = "ses_sm_rc_alice"
        tracked.push(masterSid, aliceSid)
        const task = makeActiveTask("cooperative")
        task.messagesSent = 100 // already at the maxMessagesPerRun bound
        await setup({
            root,
            masterSid,
            members: [makeMember("alice", aliceSid)],
            activeTask: task,
        })

        const result = await teamSendMessageTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, to: "master", body: "one too many" },
            makeToolContext(aliceSid),
        )
        expect(result).toContain("per-run message limit reached")
    })

    test("backpressure: recipient inbox over messageUnreadMaxBytes → rejected", async () => {
        const root = tmpRoot("sm-backpressure")
        const masterSid = "ses_sm_bp_master"
        const aliceSid = "ses_sm_bp_alice"
        tracked.push(masterSid, aliceSid)
        const dir = await setup({
            root,
            masterSid,
            members: [makeMember("alice", aliceSid)],
            boundsOverride: { messageUnreadMaxBytes: 50 },
        })
        // Pre-fill master's inbox past the 50-byte cap.
        const big: Message = {
            version: 1,
            id: crypto.randomUUID(),
            from: "alice",
            to: "master",
            kind: "message",
            body: "x".repeat(200),
            timestamp: Date.now(),
            deliveryStatus: "pending",
        }
        await writeMailboxMessage(dir, "master", big)

        const result = await teamSendMessageTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
            { team_id: TEAM, to: "master", body: "blocked by backpressure" },
            makeToolContext(aliceSid),
        )
        expect(result).toContain("mailbox is full")
    })
})

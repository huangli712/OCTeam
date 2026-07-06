import { afterEach, describe, expect, test } from "bun:test"

import fs from "node:fs/promises"

import type { PluginContext } from "../src/core/context.js"
import { teamInterveneTool } from "../src/tools/intervene.js"
import { initTeamState } from "../src/state/store.js"
import { writeMailboxMessage } from "../src/messaging/mailbox.js"
import { inboxPath, teamDir } from "../src/state/paths.js"
import { loadTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import type { ActiveTask, Message, MemberState, TeamState } from "../src/core/types.js"
import { makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"

const TEAM = "intervene-team"

/** Stub ctx: intervene reads storageRoot + client.session.promptAsync (wake hint). */
function makeCtx(root: string): PluginContext {
    return {
        storageRoot: root,
        client: { session: { promptAsync: async () => ({}) } },
    } as unknown as PluginContext
}

/** Minimal ActiveTask fixture carrying a runId; overrides for per-test tweaks. */
function makeActiveTask(runId: string | undefined, overrides: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "parallel",
        mode: "cooperative",
        startedAt: 1000,
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId,
        ...overrides,
    }
}

/** Read a recipient's raw inbox jsonl into Message[]. */
async function readInbox(dir: string, recipient: string): Promise<Message[]> {
    const raw = await fs.readFile(inboxPath(dir, recipient), "utf8").catch(() => "")
    return raw.split("\n").filter(l => l.length > 0).map(l => JSON.parse(l) as Message)
}

/** A plain (non-directive) message used to pre-fill a mailbox for backpressure. */
function regularMsg(recipient: string, body: string): Message {
    return {
        version: 1,
        id: crypto.randomUUID(),
        from: "master",
        to: recipient,
        kind: "message",
        body,
        timestamp: Date.now(),
        deliveryStatus: "pending",
    }
}

/**
 * Write a team to disk and rebuild the session index (so the master + any
 * sessioned members resolve). Returns the resolved team directory.
 */
async function setupTeam(opts: {
    root: string
    masterSid: string
    members: MemberState[]
    activatedAt?: number
    status?: TeamState["status"]
    activeTask?: ActiveTask
    boundsOverride?: Partial<TeamState["bounds"]>
}): Promise<string> {
    const base = makeState(TEAM, opts.masterSid, opts.members, opts.activatedAt)
    const state: TeamState = {
        ...base,
        status: opts.status ?? base.status,
        activeTask: opts.activeTask,
        bounds: { ...base.bounds, ...opts.boundsOverride },
    }
    await initTeamState(opts.root, state, opts.masterSid)
    await rebuildSessionIndex(opts.root, `${opts.root}__unused`)
    return teamDir(opts.root, TEAM, opts.masterSid)
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("team_intervene (T6: master-only inject-only directive)", () => {
    test("(a) master sends directive to a member → mailbox holds kind=directive with matching runId", async () => {
        const root = tmpRoot("intervene-a")
        const masterSid = "ses_master_a"
        tracked.push(masterSid)
        const dir = await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", "ses_alice_a")],
            activatedAt: Date.now(),
            status: "busy",
            activeTask: makeActiveTask("R1"),
        })

        const result = await teamInterveneTool(makeCtx(root)).execute(
            { team_id: TEAM, to: "alice", body: "stop and rebase now" },
            makeToolContext(masterSid),
        )
        expect(result).toContain("alice")

        const inbox = await readInbox(dir, "alice")
        expect(inbox).toHaveLength(1)
        expect(inbox[0].kind).toBe("directive")
        expect(inbox[0].from).toBe("master")
        expect(inbox[0].to).toBe("alice")
        expect(inbox[0].body).toBe("stop and rebase now")
        expect(inbox[0].runId).toBe("R1")
    })

    test("(b) broadcast to:\"*\" → every non-master member receives the directive", async () => {
        const root = tmpRoot("intervene-b")
        const masterSid = "ses_master_b"
        tracked.push(masterSid)
        const dir = await setupTeam({
            root,
            masterSid,
            members: [
                makeMember("alice", "ses_alice_b"),
                makeMember("bob", "ses_bob_b"),
                makeMember("carol", "ses_carol_b"),
            ],
            activatedAt: Date.now(),
            status: "busy",
            activeTask: makeActiveTask("R2"),
        })

        const result = await teamInterveneTool(makeCtx(root)).execute(
            { team_id: TEAM, to: "*", body: "all hands: switch to plan B" },
            makeToolContext(masterSid),
        )
        expect(result).toContain("3 members")

        for (const name of ["alice", "bob", "carol"]) {
            const inbox = await readInbox(dir, name)
            expect(inbox).toHaveLength(1)
            expect(inbox[0].kind).toBe("directive")
            expect(inbox[0].to).toBe(name)
            expect(inbox[0].runId).toBe("R2")
            expect(inbox[0].body).toBe("all hands: switch to plan B")
        }
    })

    test("(c) backpressure: recipient over messageUnreadMaxBytes → directive rejected", async () => {
        const root = tmpRoot("intervene-c")
        const masterSid = "ses_master_c"
        tracked.push(masterSid)
        const dir = await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", "ses_alice_c")],
            activatedAt: Date.now(),
            status: "busy",
            activeTask: makeActiveTask("R3"),
            boundsOverride: { messageUnreadMaxBytes: 100 },
        })
        // Pre-fill the mailbox so unread*1024 (1024) exceeds the 100-byte cap.
        await writeMailboxMessage(dir, "alice", regularMsg("alice", "pre-existing"))

        const result = await teamInterveneTool(makeCtx(root)).execute(
            { team_id: TEAM, to: "alice", body: "should be rejected" },
            makeToolContext(masterSid),
        )
        expect(result).toContain("backpressure")
        // Only the pre-existing message remains; the directive was NOT written.
        const inbox = await readInbox(dir, "alice")
        expect(inbox).toHaveLength(1)
        expect(inbox[0].kind).toBe("message")
    })

    test("(d) non-master caller → rejected (master-only)", async () => {
        const root = tmpRoot("intervene-d")
        const masterSid = "ses_master_d"
        const memberSid = "ses_alice_d"
        tracked.push(masterSid, memberSid)
        const dir = await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", memberSid)],
            activatedAt: Date.now(),
            status: "busy",
            activeTask: makeActiveTask("R4"),
        })

        const result = await teamInterveneTool(makeCtx(root)).execute(
            { team_id: TEAM, to: "alice", body: "member trying to intervene" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("master-only")
        // Nothing written by a rejected non-master caller.
        const inbox = await readInbox(dir, "alice")
        expect(inbox).toHaveLength(0)
    })

    test("(e) team not busy (idle, no active run) → \"no active run\"", async () => {
        const root = tmpRoot("intervene-e")
        const masterSid = "ses_master_e"
        tracked.push(masterSid)
        const dir = await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", "ses_alice_e")],
            activatedAt: Date.now(),
            status: "idle",
            activeTask: undefined,
        })

        const result = await teamInterveneTool(makeCtx(root)).execute(
            { team_id: TEAM, to: "alice", body: "intervene on idle team" },
            makeToolContext(masterSid),
        )
        expect(result).toContain("no active run")
        const inbox = await readInbox(dir, "alice")
        expect(inbox).toHaveLength(0)
    })

    test("(f) team not activated → blocked by single-active gate", async () => {
        const root = tmpRoot("intervene-f")
        const masterSid = "ses_master_f"
        tracked.push(masterSid)
        // Busy + has an active run, but activatedAt is undefined: the single-active
        // gate (resolveCallerInTeam requireActive default) must block the master.
        const dir = await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", "ses_alice_f")],
            activatedAt: undefined,
            status: "busy",
            activeTask: makeActiveTask("R5"),
        })

        const result = await teamInterveneTool(makeCtx(root)).execute(
            { team_id: TEAM, to: "alice", body: "intervene on inactive team" },
            makeToolContext(masterSid),
        )
        expect(result).toContain("Error")
        // Blocked before any write.
        const inbox = await readInbox(dir, "alice")
        expect(inbox).toHaveLength(0)
    })

    test("(g) messagesSent is NOT incremented (directive exempt from comms quota)", async () => {
        const root = tmpRoot("intervene-g")
        const masterSid = "ses_master_g"
        tracked.push(masterSid)
        await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", "ses_alice_g")],
            activatedAt: Date.now(),
            status: "busy",
            activeTask: makeActiveTask("R6", { messagesSent: 5 }),
        })

        const result = await teamInterveneTool(makeCtx(root)).execute(
            { team_id: TEAM, to: "alice", body: "directive does not count" },
            makeToolContext(masterSid),
        )
        expect(result).toContain("alice")
        // messagesSent untouched at its pre-set value.
        const team = await loadTeamState(root, TEAM, masterSid)
        expect(team.activeTask?.messagesSent).toBe(5)
    })

    test("(h) unknown recipient → error (recipient validation)", async () => {
        const root = tmpRoot("intervene-h")
        const masterSid = "ses_master_h"
        tracked.push(masterSid)
        await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", "ses_alice_h")],
            activatedAt: Date.now(),
            status: "busy",
            activeTask: makeActiveTask("R7"),
        })

        const result = await teamInterveneTool(makeCtx(root)).execute(
            { team_id: TEAM, to: "nobody", body: "to a ghost" },
            makeToolContext(masterSid),
        )
        expect(result).toContain("unknown recipient")
    })

    test("(i) activeTask.runId undefined (pre-capture edge) → directive carries undefined runId", async () => {
        const root = tmpRoot("intervene-i")
        const masterSid = "ses_master_i"
        tracked.push(masterSid)
        const dir = await setupTeam({
            root,
            masterSid,
            members: [makeMember("alice", "ses_alice_i")],
            activatedAt: Date.now(),
            status: "busy",
            activeTask: makeActiveTask(undefined),
        })

        const result = await teamInterveneTool(makeCtx(root)).execute(
            { team_id: TEAM, to: "alice", body: "no runId yet" },
            makeToolContext(masterSid),
        )
        expect(result).toContain("alice")
        const inbox = await readInbox(dir, "alice")
        expect(inbox).toHaveLength(1)
        expect(inbox[0].kind).toBe("directive")
        expect(inbox[0].runId).toBeUndefined()
    })
})

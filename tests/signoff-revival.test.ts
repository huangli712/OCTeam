import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { processIdle } from "../src/orchestration/idle.js"
import { handleParallelIdle } from "../src/orchestration/parallel.js"
import { dispatchToMember } from "../src/orchestration/dispatch.js"
import type { ActiveTask, MemberState } from "../src/core/types.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { Team } from "../src/state/store.js"
import type { PluginContext } from "../src/core/context.js"

// --- fixtures (P0-1: errored-member signoff revival) ---

/** A recorded promptAsync call: which session got which text. */
type DispatchCall = { sessionId: string; text: string }

/**
 * Stub PluginContext. `messages` returns a single user+assistant turn whose
 * assistant text is `outputs[sessionId]` (so processIdle Step 4 captures it).
 * `promptAsync` records every dispatch so a test can assert which member
 * sessions were (and were NOT) prompted.
 */
function makeCtx(outputs: Record<string, string>, calls: DispatchCall[] = []): PluginContext {
    return {
        directory: "/app",
        client: {
            session: {
                messages: async ({ path }: { path: { id: string } }) => {
                    const text = outputs[path.id] ?? ""
                    return {
                        data: [
                            { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
                            ...(text
                                ? [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }]
                                : []),
                        ],
                    }
                },
                promptAsync: async (args: any) => {
                    calls.push({ sessionId: args.path.id, text: args.body.parts[0].text })
                    return { data: {} }
                },
            },
        },
    } as unknown as PluginContext
}

function makeParallelTask(opts: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
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
        runId: crypto.randomUUID(),
        reducePolicy: "summarize",
        signoffPolicy: "none",
        ...opts,
    } as ActiveTask
}

function makeTeam(opts: {
    activeTask?: ActiveTask
    members?: Array<Partial<MemberState> & Pick<MemberState, "name">>
}): Team {
    const members: MemberState[] = (opts.members ?? []).map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: m.initialized ?? true,
        turnCount: m.turnCount ?? 0,
        sessionId: m.sessionId,
        agent: m.agent,
        isMaster: m.isMaster,
        error: m.error,
    }))
    return {
        version: 1,
        teamRunId: "test-run",
        teamName: "test-team",
        status: "busy",
        leadSessionId: "ses_lead",
        members,
        bounds: {
            maxMembers: 8,
            maxParallelMembers: 4,
            maxMessagesPerRun: 100,
            maxWallClockMinutes: 30,
            maxMemberTurns: 50,
            maxTasks: 200,
            messagePayloadMaxBytes: 32768,
            messageUnreadMaxBytes: 1048576,
        },
        createdAt: 0,
        activeTask: opts.activeTask,
        mutex: new AsyncMutex(),
        directory: mkdtempSync(join(tmpdir(), "octeam-signoff-")),
    } as unknown as Team
}

// --- (a) peer-quorum signoff excludes an errored member from dispatch ---

describe("P0-1: errored member is not revived by a peer-quorum signoff dispatch", () => {
    test("the review prompt goes ONLY to surviving reviewers, never the errored member", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({}, calls)
        const task = makeParallelTask({
            signoffPolicy: "peer-quorum",
            signoffQuorum: 0.5,
            // tolerate the one errored member so the barrier delivers survivors
            // (and reaches the signoff stage) instead of failing the run.
            maxErroredMembers: 1,
            responses: { alice: "A", carol: "C" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                { name: "bob", sessionId: "ses_bob", status: "errored", error: "boom" },
                { name: "carol", sessionId: "ses_carol", status: "idle" },
            ],
        })

        await handleParallelIdle(ctx, team)

        // Signoff stage was entered and the two LIVE reviewers were dispatched.
        expect(task.signoffStage).toBe(true)
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(true)
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(true)
        // The errored member is terminal: a signoff dispatch must NOT revive it.
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(false)
        // It stays errored (never flipped back to running).
        expect(team.members.find(m => m.name === "bob")!.status).toBe("errored")
    })
})

// --- (b) the quorum denominator excludes the errored member ---

describe("P0-1: peer-quorum denominator excludes errored members", () => {
    test("surviving reviewers reach quorum (2/2) even though a third member errored", async () => {
        const calls: DispatchCall[] = []
        // The reviewer that is about to idle approves; the other survivor already
        // approved before this idle (pre-seeded in signoffApprovals).
        const approve = '<signoff>{"approved":true,"rationale":"lgtm"}</signoff>'
        const task = makeParallelTask({
            signoffPolicy: "peer-quorum",
            signoffQuorum: 0.5,
            maxErroredMembers: 1,
            signoffStage: true,
            signoffApprovals: { alice: true },
            responses: { alice: `prior ${approve}`, carol: "carol work product" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                { name: "bob", sessionId: "ses_bob", status: "errored", error: "boom" },
                { name: "carol", sessionId: "ses_carol", status: "idle" },
            ],
        })
        const ctx = makeCtx({ ses_carol: approve }, calls)

        // carol idles during the signoff stage and approves. The denominator is
        // the LIVE reviewers (alice, carol) = 2; bob is excluded. Both approved,
        // so quorum (2/2 >= 0.5) is reached and the run delivers + idles. If the
        // denominator counted bob, allResponded would be 2 < 3 and the run would
        // stall forever waiting on a member that can never respond.
        await processIdle(ctx, team, team.members[2], "ses_carol")

        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        expect(calls.some(c => c.sessionId === "ses_lead")).toBe(true)
    })
})

// --- (c) dispatchToMember is a no-op on an errored member ---

describe("P0-1: dispatchToMember refuses to dispatch an errored member", () => {
    test("status stays errored, turnCount unchanged, and no prompt is sent", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({}, calls)
        const team = makeTeam({
            activeTask: makeParallelTask(),
            members: [{ name: "bob", sessionId: "ses_bob", status: "errored", error: "boom" }],
        })
        const bob = team.members[0]

        await dispatchToMember(ctx, bob, "please do more work", "/app", team)

        expect(bob.status).toBe("errored")
        expect(bob.turnCount).toBe(0)
        expect(calls).toHaveLength(0)
    })
})

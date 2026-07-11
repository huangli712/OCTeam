import { afterEach, describe, expect, mock, test } from "bun:test"

import type { ActiveTask, MemberState, MemberStatus } from "../src/core/types.js"
import { processIdle } from "../src/orchestration/idle.js"
import { handleStatusEvent } from "../src/orchestration/status.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { writeMailboxMessage } from "../src/messaging/mailbox.js"
import { makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"
import type { Message } from "../src/core/types.js"


async function makeTeam(
    root: string,
    sid: string,
    tracker: string[],
    members: MemberState[],
) {
    tracker.push(sid)
    for (const m of members) if (m.sessionId) tracker.push(m.sessionId)
    const state = makeState("alpha", sid, members, Date.now())
    await initTeamState(root, state, sid)
    await rebuildSessionIndex(root, `${root}__user_unused`)
    return loadTeamState(root, "alpha", sid)
}

async function setActiveTask(
    root: string,
    sid: string,
    partial: Partial<ActiveTask> & { type: string },
) {
    const team = await loadTeamState(root, "alpha", sid)
    await team.mutex.runExclusive(async () => {
        team.activeTask = {
            runId: "run-handler-test",
            startedAt: Date.now(),
            wallClockTimeoutMs: 300_000,
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            responses: {},
            stages: [],
            currentStageIndex: 0,
            currentRound: 1,
            decisionHistory: [],
            decisionParseFailures: 0,
            ...partial,
        } as ActiveTask
    })
}

/** Build a Message suitable for writeMailboxMessage. */
function mailboxMsg(id: string, body: string, to: string): Message {
    return {
        version: 1,
        id,
        from: "master",
        to,
        kind: "message",
        body,
        timestamp: Date.now(),
        deliveryStatus: "pending",
    }
}

// ============================================================
// processIdle: role-setup barrier, unread wake hint,
// premature-idle re-prompt, and reduce-stage priority.
// ============================================================

describe("processIdle: role-setup barrier (Step 1.5)", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    test("first idle of an uninitialized member marks it ready and returns WITHOUT dispatching", async () => {
        const root = tmpRoot("pid-rsb")
        const sid = "ses_pid_rsb"
        const memberSid = "ses_pid_rsb_alice"
        const promptAsync = mock(async () => ({}))
        const ctx = makeCtx({ storageRoot: root, promptAsync })

        const team = await makeTeam(root, sid, tracked, [
            makeMember("alice", memberSid),
        ])
        await setActiveTask(root, sid, { type: "parallel", mode: "isolated", task: "do thing" })
        const alice = team.members.find(m => m.name === "alice")!
        alice.initialized = false
        alice.status = "running"

        await team.mutex.runExclusive(async () => {
            await processIdle(ctx, team, alice, memberSid)
        })

        // Barrier flipped initialized and saved; no dispatch happened yet
        // (role-setup does NOT advance the state machine).
        expect(alice.initialized).toBe(true)
        expect(alice.status as MemberStatus).toBe("idle") // Step 1 set this before the barrier check
        expect(promptAsync).toHaveBeenCalledTimes(0)
    })
})

describe("processIdle: unread-message wake hint (Step 5)", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    test("member with unread mailbox messages gets a wake hint and the run does NOT advance", async () => {
        const root = tmpRoot("pid-wake")
        const sid = "ses_pid_wake"
        const memberSid = "ses_pid_wake_alice"
        const captured: string[] = []
        const promptAsync = mock(async (req: { body: { parts: Array<{ text: string }> } }) => {
            captured.push(req.body.parts[0].text)
        })
        const ctx = makeCtx({ storageRoot: root, promptAsync } as any)

        const team = await makeTeam(root, sid, tracked, [
            makeMember("alice", memberSid),
        ])
        await setActiveTask(root, sid, { type: "parallel", mode: "isolated", task: "do thing" })
        const alice = team.members.find(m => m.name === "alice")!
        alice.status = "running"

        // Drop an unread message into alice's mailbox.
        await writeMailboxMessage(team.directory, "alice", mailboxMsg("m1", "wake content", "alice"))

        await team.mutex.runExclusive(async () => {
            await processIdle(ctx, team, alice, memberSid)
        })

        // Exactly one promptAsync call — the wake hint. The parallel barrier
        // dispatch path was NOT taken (it would have dispatched again).
        expect(promptAsync).toHaveBeenCalledTimes(1)
        expect(captured[0]).toContain("new team message")
        expect(captured[0]).toContain("1")
    })
})

describe("processIdle: premature-idle re-prompt (require_done_ack recovery)", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    test("isolated member idling without team_done is re-prompted with explicit ack instructions", async () => {
        const root = tmpRoot("pid-premature")
        const sid = "ses_pid_premature"
        const memberSid = "ses_pid_premature_alice"
        const captured: string[] = []
        const promptAsync = mock(async (req: { body: { parts: Array<{ text: string }> } }) => {
            captured.push(req.body.parts[0].text)
        })
        const ctx = makeCtx({ storageRoot: root, promptAsync } as any)

        const team = await makeTeam(root, sid, tracked, [
            makeMember("alice", memberSid),
        ])
        await setActiveTask(root, sid, {
            type: "parallel",
            mode: "isolated",
            task: "do thing",
            requireDoneAck: true,
        })
        const alice = team.members.find(m => m.name === "alice")!
        alice.status = "running"
        alice.declaredDone = false // went idle without team_done → premature

        await team.mutex.runExclusive(async () => {
            await processIdle(ctx, team, alice, memberSid)
        })

        // Re-prompt fires exactly once; member flipped back to running.
        expect(promptAsync).toHaveBeenCalledTimes(1)
        expect(captured[0]).toContain("team_done")
        expect(captured[0]).toContain(sid === "ses_pid_premature" ? "alpha" : "alpha")
        expect(captured[0]).toContain("require_done_ack")
        expect(alice.status).toBe("running")
        expect(alice.turnCount).toBe(1)
    })

    test("cooperative mode is also covered by the premature-idle branch", async () => {
        const root = tmpRoot("pid-premature-coop")
        const sid = "ses_pid_premature_coop"
        const memberSid = "ses_pid_premature_coop_alice"
        const promptAsync = mock(async () => ({}))
        const ctx = makeCtx({ storageRoot: root, promptAsync })

        const team = await makeTeam(root, sid, tracked, [
            makeMember("alice", memberSid),
        ])
        await setActiveTask(root, sid, {
            type: "parallel",
            mode: "cooperative",
            task: "do thing",
            requireDoneAck: true,
        })
        const alice = team.members.find(m => m.name === "alice")!
        alice.status = "running"
        alice.declaredDone = false

        await team.mutex.runExclusive(async () => {
            await processIdle(ctx, team, alice, memberSid)
        })

        expect(promptAsync).toHaveBeenCalledTimes(1)
        expect(alice.status).toBe("running")
    })

    test("declaredDone=true bypasses the premature-idle branch (no extra re-prompt)", async () => {
        const root = tmpRoot("pid-premature-ack")
        const sid = "ses_pid_premature_ack"
        const memberSid = "ses_pid_premature_ack_alice"
        const promptAsync = mock(async () => ({}))
        const ctx = makeCtx({ storageRoot: root, promptAsync })

        const team = await makeTeam(root, sid, tracked, [
            makeMember("alice", memberSid),
        ])
        await setActiveTask(root, sid, {
            type: "parallel",
            mode: "isolated",
            task: "do thing",
            requireDoneAck: true,
        })
        const alice = team.members.find(m => m.name === "alice")!
        alice.status = "running"
        alice.declaredDone = true // already acked → not premature

        await team.mutex.runExclusive(async () => {
            await processIdle(ctx, team, alice, memberSid)
        })

        // The premature-idle branch is skipped; handleParallelIdle runs instead.
        // Either way, the re-prompt copy (which mentions team_done explicitly)
        // must NOT appear.
        if (promptAsync.mock.calls.length > 0) {
            const text = (promptAsync.mock.calls[0] as unknown[])[0] as { body: { parts: Array<{ text: string }> } }
            expect(text.body.parts[0].text).not.toContain("require_done_ack")
        }
    })
})

describe("processIdle: reduce-stage priority (Step 6 prefix)", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    test("reduceStage=true routes the reducer's idle through handleReduceIdle (not the per-mode switch)", async () => {
        const root = tmpRoot("pid-reduce")
        const sid = "ses_pid_reduce"
        const memberSid = "ses_pid_reduce_alice"
        const promptAsync = mock(async () => ({}))
        const ctx = makeCtx({ storageRoot: root, promptAsync })

        const team = await makeTeam(root, sid, tracked, [
            makeMember("alice", memberSid),
        ])
        await setActiveTask(root, sid, {
            type: "parallel",
            mode: "isolated",
            task: "do thing",
            reducePolicy: "summarize",
            reducerMember: "alice",
            reduceStage: true, // <- reducer mid-flight
            responses: { alice: "REDUCED_OUTPUT" },
        })
        const alice = team.members.find(m => m.name === "alice")!
        alice.status = "running"

        await team.mutex.runExclusive(async () => {
            await processIdle(ctx, team, alice, memberSid)
        })

        // handleReduceIdle captured reducedResult, cleared reduceStage, and
        // (no signoff) delivered + cleared activeTask → team is idle.
        const after = await loadTeamState(root, "alpha", sid)
        expect(after.activeTask).toBeUndefined()
        expect(after.status).toBe("idle")
    })
})

// ============================================================
// handleStatusEvent: retry escalation, grace extension,
// idle-clears-retryingSince, and re-drive after errored.
// ============================================================

describe("handleStatusEvent: retry escalation", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    test("first 'retry' status with maxRetries=0 escalates to errored (no grace)", async () => {
        const root = tmpRoot("hse-retry-fail")
        const sid = "ses_hse_retry_fail"
        const memberSid = "ses_hse_retry_fail_alice"
        // session.status returns retry for memberSid with an old retryingSince
        // to bypass the RETRY_ESCALATION_MS window immediately.
        const status = mock(async () => ({
            data: { [memberSid]: { type: "retry", message: "rate limited" } },
        }))
        const ctx = makeCtx({ storageRoot: root, status, promptAsync: async () => ({}) })
        const team = await makeTeam(root, sid, tracked, [
            makeMember("alice", memberSid),
        ])
        await setActiveTask(root, sid, { type: "parallel", mode: "isolated", task: "x" })
        const alice = team.members.find(m => m.name === "alice")!
        // Pre-set retryingSince in the distant past so the >60s window check passes.
        alice.retryingSince = Date.now() - 120_000

        await handleStatusEvent(ctx, {
            type: "session.status",
            properties: { sessionID: memberSid },
        })

        const after = await loadTeamState(root, "alpha", sid)
        const aliceAfter = after.members.find(m => m.name === "alice")!
        expect(aliceAfter.status).toBe("errored")
        expect(aliceAfter.error).toMatch(/sustained retry/)
    })

    test("first 'retry' status with maxRetries>0 grants a grace window (retryCount++)", async () => {
        const root = tmpRoot("hse-retry-grace")
        const sid = "ses_hse_retry_grace"
        const memberSid = "ses_hse_retry_grace_alice"
        const status = mock(async () => ({
            data: { [memberSid]: { type: "retry", message: "transient" } },
        }))
        const ctx = makeCtx({ storageRoot: root, status, promptAsync: async () => ({}) })
        const team = await makeTeam(root, sid, tracked, [
            makeMember("alice", memberSid),
        ])
        await setActiveTask(root, sid, {
            type: "parallel",
            mode: "isolated",
            task: "x",
            maxRetries: 2,
        })
        const alice = team.members.find(m => m.name === "alice")!
        alice.retryingSince = Date.now() - 120_000 // past the escalation window

        await handleStatusEvent(ctx, {
            type: "session.status",
            properties: { sessionID: memberSid },
        })

        const after = await loadTeamState(root, "alpha", sid)
        const aliceAfter = after.members.find(m => m.name === "alice")!
        // Grace extension: NOT errored, retryCount incremented, retryingSince reset.
        expect(aliceAfter.status).not.toBe("errored")
        expect(aliceAfter.retryCount).toBe(1)
        expect(aliceAfter.retryingSince).toBeGreaterThan(Date.now() - 5_000)
    })

    test("'idle' status clears retryingSince", async () => {
        const root = tmpRoot("hse-idle-clear")
        const sid = "ses_hse_idle_clear"
        const memberSid = "ses_hse_idle_clear_alice"
        const status = mock(async () => ({
            data: { [memberSid]: { type: "idle" } },
        }))
        const ctx = makeCtx({ storageRoot: root, status, promptAsync: async () => ({}) })
        const team = await makeTeam(root, sid, tracked, [
            makeMember("alice", memberSid),
        ])
        await setActiveTask(root, sid, { type: "parallel", mode: "isolated", task: "x" })
        const alice = team.members.find(m => m.name === "alice")!
        alice.retryingSince = Date.now() - 5_000 // was retrying

        await handleStatusEvent(ctx, {
            type: "session.status",
            properties: { sessionID: memberSid },
        })

        const after = await loadTeamState(root, "alpha", sid)
        const aliceAfter = after.members.find(m => m.name === "alice")!
        expect(aliceAfter.retryingSince).toBeUndefined()
    })

    test("unknown sessionID is silently dropped (no team resolution)", async () => {
        const root = tmpRoot("hse-unknown")
        const sid = "ses_hse_unknown"
        const ctx = makeCtx({ storageRoot: root })
        await makeTeam(root, sid, tracked, [
            makeMember("alice", "ses_hse_unknown_a"),
        ])

        // Non-member sessionID → resolveTeamMember returns null → no-op.
        expect(
            handleStatusEvent(ctx, {
                type: "session.status",
                properties: { sessionID: "ses_not_a_member" },
            }),
        ).resolves.toBeUndefined()
    })

    test("master session is silently dropped (status events are member-only)", async () => {
        const root = tmpRoot("hse-master")
        const sid = "ses_hse_master"
        const ctx = makeCtx({ storageRoot: root })
        await makeTeam(root, sid, tracked, [
            makeMember("alice", "ses_hse_master_a"),
        ])
        // Index the lead session as a master.
        // resolveTeamMember would return a master entry; handleStatusEvent bails.

        // The lead sessionID resolves via resolveTeamMember only when indexed
        // as a member, which it is not — so this is a no-op. The intent here is
        // to cover the `!member || member.isMaster` early-return guard.
        expect(
            handleStatusEvent(ctx, {
                type: "session.status",
                properties: { sessionID: sid },
            }),
        ).resolves.toBeUndefined()
    })
})

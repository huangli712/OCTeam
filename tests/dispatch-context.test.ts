import { describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask, MemberState } from "../src/core/types.js"
import { dispatchToMember } from "../src/orchestration/dispatch.js"
import { processIdle } from "../src/orchestration/handlers.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { createTask } from "../src/state/tasks.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

// --- helpers ---

function makeCtx(storageRoot: string, overrides?: {
    promptAsync?: (req: unknown) => Promise<void>
    directory?: string
}): PluginContext {
    return {
        storageRoot,
        scope: "project",
        directory: overrides?.directory ?? "/app",
        client: {
            app: {
                log: mock(async () => {}),
            },
            session: {
                promptAsync: overrides?.promptAsync ?? mock(async () => {}),
                messages: mock(async () => ({ data: [] })),
            },
        },
    } as unknown as PluginContext
}

/** Construct a full Team wrapper (TeamState + mutex + directory). */
async function makeTeamWithDir(root: string, sid: string, members: MemberState[]): Promise<ReturnType<typeof loadTeamState>> {
    const state = makeState("alpha", sid, members, Date.now())
    await initTeamState(root, state, sid)
    await rebuildSessionIndex(root, root)
    return loadTeamState(root, "alpha", sid)
}

async function setActiveTask(root: string, sid: string, task: Partial<ActiveTask> & { type: string }) {
    const team = await loadTeamState(root, "alpha", sid)
    await team.mutex.runExclusive(async () => {
        team.activeTask = {
            type: task.type as ActiveTask["type"],
            startedAt: Date.now(),
            wallClockTimeoutMs: 300_000,
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            responses: {},
            stages: [],
            currentStageIndex: 0,
            decisionHistory: [],
            decisionParseFailures: 0,
            ...task,
        } as ActiveTask
    })
}

// ============================================================
// 4a: Unit tests — dispatchToMember directly
// ============================================================

describe("dispatchToMember unit", () => {
    test("sets body.agent === member.agent and query.directory", async () => {
        const promptAsync = mock(async (_req: unknown) => {})
        const ctx = makeCtx("/tmp", { promptAsync })
        const member: MemberState = {
            name: "alice",
            sessionId: "ses_123",
            agent: "oct-oracle",
            status: "idle",
            initialized: true,
            turnCount: 0,
        }
        await dispatchToMember(ctx, member, "hello", "/worktrees/alice")

        expect(promptAsync).toHaveBeenCalledTimes(1)
        const req = (promptAsync.mock.calls[0] as unknown[])[0] as Record<string, unknown>
        expect((req as any).body.agent).toBe("oct-oracle")
        expect((req as any).query.directory).toBe("/worktrees/alice")
        expect(member.status).toBe("running")
        expect(member.turnCount).toBe(1)
    })

    test("falls back to oct-oracle (read-only) when member.agent is undefined (fail-safe)", async () => {
        const promptAsync = mock(async (_req: unknown) => {})
        const ctx = makeCtx("/tmp", { promptAsync })
        const member: MemberState = {
            name: "bob",
            sessionId: "ses_456",
            agent: undefined,
            status: "idle",
            initialized: true,
            turnCount: 0,
        }
        await dispatchToMember(ctx, member, "task", "/app")

        const req = (promptAsync.mock.calls[0] as unknown[])[0] as Record<string, unknown>
        // safeMemberAgent clamps undefined to SAFE_FALLBACK_AGENT ("oct-oracle"),
        // NOT "build" — fail-safe to read-only, never fail-open to full privilege.
        expect((req as any).body.agent).toBe("oct-oracle")
    })

    test("clamps a non-oct-* agent (e.g. tampered 'build') to oct-oracle (fail-safe)", async () => {
        const promptAsync = mock(async (_req: unknown) => {})
        const ctx = makeCtx("/tmp", { promptAsync })
        const member: MemberState = {
            name: "eve",
            sessionId: "ses_789",
            // A tampered state.json could write "build" here; safeMemberAgent
            // must refuse to escalate and clamp to the read-only fallback.
            agent: "build",
            status: "idle",
            initialized: true,
            turnCount: 0,
        }
        await dispatchToMember(ctx, member, "task", "/app")

        const req = (promptAsync.mock.calls[0] as unknown[])[0] as Record<string, unknown>
        expect((req as any).body.agent).toBe("oct-oracle")
    })

    test("no-ops when member.sessionId is absent — no request, no mutation", async () => {
        const promptAsync = mock(async (_req: unknown) => {})
        const ctx = makeCtx("/tmp", { promptAsync })
        const member: MemberState = {
            name: "carol",
            sessionId: undefined,
            agent: "oct-oracle",
            status: "idle",
            initialized: true,
            turnCount: 0,
        }
        await dispatchToMember(ctx, member, "task", "/app")

        expect(promptAsync).toHaveBeenCalledTimes(0)
        expect(member.status).toBe("idle")
        expect(member.turnCount).toBe(0)
    })

    test("falls back to ctx.directory when worktreePath is undefined", async () => {
        const promptAsync = mock(async (_req: unknown) => {})
        const ctx = makeCtx("/tmp", { promptAsync, directory: "/project" })
        const member: MemberState = {
            name: "dave",
            sessionId: "ses_789",
            agent: "oct-explore",
            status: "idle",
            initialized: true,
            turnCount: 0,
            worktreePath: undefined,
        }
        await dispatchToMember(ctx, member, "task", member.worktreePath ?? ctx.directory)

        const req = (promptAsync.mock.calls[0] as unknown[])[0] as Record<string, unknown>
        expect((req as any).query.directory).toBe("/project")
    })
})

// ============================================================
// 4b: Integration tests — processIdle → dispatch paths
// ============================================================

describe("processIdle consensus round 2 broadcast", () => {
    test("broadcast uses dispatchToMember with agent and directory", async () => {
        const root = tmpRoot("con-r2")
        const leadSid = "ses_con_m"
        const memberSid = "ses_con_a"
        // Track session indexes for cleanup
        const tracked = [leadSid, memberSid]

        const alice = makeMember("alice", memberSid)
        alice.agent = "oct-oracle"

        const captured: Array<{ id: string; agent: unknown; directory: unknown }> = []
        const promptAsync = mock(async (req: any) => {
            captured.push({
                id: req.path.id,
                agent: req.body?.agent,
                directory: req.query?.directory,
            })
        })

        await makeTeamWithDir(root, leadSid, [alice])
        await setActiveTask(root, leadSid, {
            type: "consensus",
            topic: "test",
            maxRounds: 3,
            currentRound: 1,
            // Pre-populate responses so allMembersAgree returns false
            // and the barrier fires the broadcast branch
            responses: { alice: "I disagree for now" },
        })

        const ctx = makeCtx(root, { promptAsync })
        const team = await loadTeamState(root, "alpha", leadSid)
        const member = team.members.find(m => m.name === "alice")!

        // The member must be running for processIdle to flip it to idle
        // and for waitForBarrier to see it as the last participant becoming idle
        member.status = "running"

        // Drive processIdle — this should:
        // 1. Flip alice to idle
        // 2. Barrier fires (all participants idle)
        // 3. allMembersAgree returns false (no consensus tag)
        // 4. currentRound(1) < maxRounds(3) → broadcast round 2
        await team.mutex.runExclusive(async () => {
            await processIdle(ctx, team, member, memberSid)
        })

        // Should have dispatched the next consensus round
        const consensusDispatch = captured.find(c => c.id === memberSid)
        expect(consensusDispatch).toBeDefined()
        expect(consensusDispatch!.agent).toBe("oct-oracle")
        expect(consensusDispatch!.directory).toBe("/app")

        // Cleanup
        for (const sid of tracked) {
            unindexSession(sid)
        }
    })
})

describe("processIdle signoff dispatch", () => {
    test("decider signoff uses dispatchToMember with agent and directory", async () => {
        const root = tmpRoot("sig-dec")
        const leadSid = "ses_sig_m"
        const aliceSid = "ses_sig_alice"
        const bobSid = "ses_sig_bob"
        const tracked = [leadSid, aliceSid, bobSid]

        const alice = makeMember("alice", aliceSid)
        alice.agent = "oct-oracle"
        const bob = makeMember("bob", bobSid)

        const captured: Array<{ id: string; agent: unknown; directory: unknown }> = []
        const promptAsync = mock(async (req: any) => {
            captured.push({
                id: req.path.id,
                agent: req.body?.agent,
                directory: req.query?.directory,
            })
        })

        await makeTeamWithDir(root, leadSid, [alice, bob])
        await setActiveTask(root, leadSid, {
            type: "parallel",
            mode: "isolated",
            task: "do x",
            responses: { alice: "done", bob: "done" },
            signoffPolicy: "decider" as const,
            signoffDecider: "alice",
        })

        const ctx = makeCtx(root, { promptAsync })
        const team = await loadTeamState(root, "alpha", leadSid)
        const bobMember = team.members.find(m => m.name === "bob")!
        const aliceMember = team.members.find(m => m.name === "alice")!

        // Set both members to idle so the parallel barrier fires
        aliceMember.status = "idle"
        bobMember.status = "idle"

        // Drive processIdle — when bob idles, the parallel barrier fires,
        // maybeTriggerSignoff dispatches the review prompt to alice (decider)
        await team.mutex.runExclusive(async () => {
            await processIdle(ctx, team, bobMember, bobSid)
        })

        // The decider dispatch should have agent="oct-oracle" (from alice's state)
        const deciderDispatch = captured.find(c => c.id === aliceSid)
        expect(deciderDispatch).toBeDefined()
        expect(deciderDispatch!.agent).toBe("oct-oracle")
        expect(deciderDispatch!.directory).toBe("/app")

        for (const sid of tracked) {
            unindexSession(sid)
        }
    })

    test("peer-quorum signoff uses dispatchToMember with agent and directory for all reviewers", async () => {
        const root = tmpRoot("sig-pq")
        const leadSid = "ses_sigpq_m"
        const aliceSid = "ses_sigpq_a"
        const bobSid = "ses_sigpq_b"
        const tracked = [leadSid, aliceSid, bobSid]

        const alice = makeMember("alice", aliceSid)
        alice.agent = "oct-oracle"
        const bob = makeMember("bob", bobSid)
        bob.agent = "oct-explore"

        const captured: Array<{ id: string; agent: unknown; directory: unknown }> = []
        const promptAsync = mock(async (req: any) => {
            captured.push({
                id: req.path.id,
                agent: req.body?.agent,
                directory: req.query?.directory,
            })
        })

        await makeTeamWithDir(root, leadSid, [alice, bob])
        await setActiveTask(root, leadSid, {
            type: "parallel",
            mode: "isolated",
            task: "do x",
            responses: { alice: "done", bob: "done" },
            signoffPolicy: "peer-quorum" as const,
            signoffQuorum: 0.5,
        })

        const ctx = makeCtx(root, { promptAsync })
        const team = await loadTeamState(root, "alpha", leadSid)
        const aliceMember = team.members.find(m => m.name === "alice")!
        const bobMember = team.members.find(m => m.name === "bob")!

        aliceMember.status = "idle"
        bobMember.status = "idle"

        await team.mutex.runExclusive(async () => {
            await processIdle(ctx, team, aliceMember, aliceSid)
        })

        // Both reviewers should receive the signoff prompt
        const aliceDispatch = captured.find(c => c.id === aliceSid)
        const bobDispatch = captured.find(c => c.id === bobSid)
        expect(aliceDispatch).toBeDefined()
        expect(aliceDispatch!.agent).toBe("oct-oracle")
        expect(aliceDispatch!.directory).toBe("/app")
        expect(bobDispatch).toBeDefined()
        expect(bobDispatch!.agent).toBe("oct-explore")
        expect(bobDispatch!.directory).toBe("/app")

        for (const sid of tracked) {
            unindexSession(sid)
        }
    })
})

describe("processIdle delegate re-prompt", () => {
    test("re-prompt uses dispatchToMember with agent and directory", async () => {
        const root = tmpRoot("del-re")
        const leadSid = "ses_del_m"
        const aliceSid = "ses_del_a"
        const tracked = [leadSid, aliceSid]

        const alice = makeMember("alice", aliceSid)
        alice.agent = "oct-explore"

        const captured: Array<{ id: string; agent: unknown; directory: unknown }> = []
        const promptAsync = mock(async (req: any) => {
            captured.push({
                id: req.path.id,
                agent: req.body?.agent,
                directory: req.query?.directory,
            })
        })

        await makeTeamWithDir(root, leadSid, [alice])
        const team = await loadTeamState(root, "alpha", leadSid)

        // Create a pending task so the re-prompt path is reached
        await createTask(team.directory, { subject: "s1", description: "d1" })

        await team.mutex.runExclusive(async () => {
            team.activeTask = {
                type: "delegate",
                startedAt: Date.now(),
                wallClockTimeoutMs: 300_000,
                tokensUsed: 0,
                tokensByMember: {},
                messagesSent: 0,
                responses: {},
                stages: [],
                currentStageIndex: 0,
                decisionHistory: [],
                decisionParseFailures: 0,
            } as ActiveTask
        })

        const ctx = makeCtx(root, { promptAsync })
        const aliceMember = team.members.find(m => m.name === "alice")!

        // Set up for re-prompt: member must be idle, have an old lastNotifiedAt
        aliceMember.status = "idle"
        aliceMember.lastNotifiedAt = Date.now() - 20_000 // past cooldown

        await team.mutex.runExclusive(async () => {
            await processIdle(ctx, team, aliceMember, aliceSid)
        })

        // Should have dispatched the re-prompt
        const dispatch = captured.find(c => c.id === aliceSid)
        expect(dispatch).toBeDefined()
        expect(dispatch!.agent).toBe("oct-explore")
        expect(dispatch!.directory).toBe("/app")

        for (const sid of tracked) {
            unindexSession(sid)
        }
    })
})

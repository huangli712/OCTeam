import { afterEach, describe, expect, mock, test } from "bun:test"

import { teamArbitrateTool } from "../src/tools/modes/arbitrate.js"
import { teamConsensusTool } from "../src/tools/modes/consensus.js"
import { teamDelegateTool } from "../src/tools/modes/delegate.js"
import { teamFixMemberTool } from "../src/tools/lifecycle/fixmember.js"
import { teamLoopTool } from "../src/tools/modes/loop.js"
import { teamParallelTool } from "../src/tools/modes/parallel.js"
import { teamPipelineTool } from "../src/tools/modes/pipeline.js"
import { teamRecurseTool } from "../src/tools/modes/recurse.js"
import { teamRouteTool } from "../src/tools/modes/router.js"
import { initTeamState, loadTeamState, readTeamSpec, writeTeamSpec } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from './helpers.js';


const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

async function setupTeam(
    root: string,
    sid: string,
    members: ReturnType<typeof makeMember>[],
    activatedAt?: number,
) {
    tracked.push(sid)
    for (const m of members) if (m.sessionId) tracked.push(m.sessionId)
    await initTeamState(root, makeState("alpha", sid, members, activatedAt), sid)
    await rebuildSessionIndex(root, `${root}__user_unused`)
}

async function writeSpecForMembers(
    root: string,
    sid: string,
    members: Array<{ name: string; role?: string; prompt?: string }>,
) {
    await writeTeamSpec(
        root,
        {
            version: 1,
            name: "alpha",
            createdAt: Date.now(),
            members: members.map(m => ({
                name: m.name,
                role: m.role ?? "coder",
                prompt: m.prompt ?? "do good work",
            })),
        },
        sid,
    )
}

// ============================================================
// team_fix_member: comprehensive coverage of error paths + the
// rename / role / agent happy paths.
// ============================================================

describe("team_fix_member: input validation", () => {
    test("no new_* args → 'provide at least one' error", async () => {
        const root = tmpRoot("fix-noargs")
        const sid = "ses_fix_noargs"
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamFixMemberTool(makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })).execute(
            { team_id: "alpha", member_name: "alice" },
            makeToolContext(sid),
        )
        expect(result).toContain("provide at least one")
    })

    test("busy team → rejected", async () => {
        const root = tmpRoot("fix-busy")
        const sid = "ses_fix_busy"
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const team = await loadTeamState(root, "alpha", sid)
        await team.mutex.runExclusive(async () => {
            team.status = "busy"
            await (await import("../src/state/store.js")).saveTeamState(team)
        })

        const result = await teamFixMemberTool(makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })).execute(
            { team_id: "alpha", member_name: "alice", new_prompt: "x" },
            makeToolContext(sid),
        )
        expect(result).toContain("busy")
    })

    test("unknown member → not found", async () => {
        const root = tmpRoot("fix-unknown")
        const sid = "ses_fix_unk"
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamFixMemberTool(makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })).execute(
            { team_id: "alpha", member_name: "ghost", new_prompt: "x" },
            makeToolContext(sid),
        )
        expect(result).toContain("not found")
    })

    test("invalid new_agent (not oct-*) → rejected", async () => {
        const root = tmpRoot("fix-badagent")
        const sid = "ses_fix_ba"
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamFixMemberTool(makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })).execute(
            { team_id: "alpha", member_name: "alice", new_agent: "build" },
            makeToolContext(sid),
        )
        expect(result).toContain("not a hardened oct-* agent")
    })

    test("new_name not in preset pool → rejected", async () => {
        const root = tmpRoot("fix-badname")
        const sid = "ses_fix_bn"
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamFixMemberTool(makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })).execute(
            { team_id: "alpha", member_name: "alice", new_name: "notapoolname" },
            makeToolContext(sid),
        )
        expect(result).toContain("not a preset pool name")
    })

    test("new_name already exists in team → rejected", async () => {
        const root = tmpRoot("fix-dupname")
        const sid = "ses_fix_dn"
        await setupTeam(root, sid, [makeMember("alice"), makeMember("bob")], Date.now())
        const result = await teamFixMemberTool(makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })).execute(
            { team_id: "alpha", member_name: "alice", new_name: "bob" },
            makeToolContext(sid),
        )
        expect(result).toContain("already exists")
    })
})

describe("team_fix_member: happy paths", () => {
    test("new_name: renames across state, spec, and member index", async () => {
        const root = tmpRoot("fix-rename")
        const sid = "ses_fix_rn"
        const memberSid = "ses_fix_rn_alice"
        await setupTeam(root, sid, [makeMember("alice", memberSid)], Date.now())
        await writeSpecForMembers(root, sid, [{ name: "alice" }])

        const result = await teamFixMemberTool(makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })).execute(
            { team_id: "alpha", member_name: "alice", new_name: "bob" },
            makeToolContext(sid),
        )
        expect(result).toContain("name: alice → bob")

        const after = await loadTeamState(root, "alpha", sid)
        expect(after.members[0].name).toBe("bob")
        const spec = await readTeamSpec(root, "alpha", sid)
        expect(spec?.members[0].name).toBe("bob")
    })

    test("new_role: normalizes and updates spec", async () => {
        const root = tmpRoot("fix-role")
        const sid = "ses_fix_rl"
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        await writeSpecForMembers(root, sid, [{ name: "alice", role: "coder" }])

        const result = await teamFixMemberTool(makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })).execute(
            { team_id: "alpha", member_name: "alice", new_role: "reviewer" },
            makeToolContext(sid),
        )
        expect(result).toContain("role: reviewer")

        const spec = await readTeamSpec(root, "alpha", sid)
        expect(spec?.members[0].role).toBe("reviewer")
    })

    test("new_agent with bound model: updates agent + model on member and spec", async () => {
        const root = tmpRoot("fix-agent-model")
        const sid = "ses_fix_am"
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        await writeSpecForMembers(root, sid, [{ name: "alice" }])

        const agents = mock(async () => ({
            data: [
                {
                    name: "oct-oracle",
                    model: { providerID: "anthropic", modelID: "claude-sonnet" },
                },
            ],
        }))
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })

        const result = await teamFixMemberTool(ctx).execute(
            { team_id: "alpha", member_name: "alice", new_agent: "oct-oracle" },
            makeToolContext(sid),
        )
        expect(result).toContain("agent: oct-oracle")
        expect(result).toContain("model: anthropic/claude-sonnet")

        const after = await loadTeamState(root, "alpha", sid)
        expect(after.members[0].agent).toBe("oct-oracle")
        expect(after.members[0].model).toBe("anthropic/claude-sonnet")
    })

    test("new_agent with no bound model: agent updated, model unchanged, message notes it", async () => {
        const root = tmpRoot("fix-agent-nomodel")
        const sid = "ses_fix_an"
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        await writeSpecForMembers(root, sid, [{ name: "alice" }])

        const agents = mock(async () => ({ data: [{ name: "oct-explore" }] })) // no model
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })

        const result = await teamFixMemberTool(ctx).execute(
            { team_id: "alpha", member_name: "alice", new_agent: "oct-explore" },
            makeToolContext(sid),
        )
        expect(result).toContain("agent: oct-explore")
        expect(result).toContain("no bound model")
    })

    test("new_agent when agents registry throws: graceful fallback message", async () => {
        const root = tmpRoot("fix-agent-throw")
        const sid = "ses_fix_at"
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        await writeSpecForMembers(root, sid, [{ name: "alice" }])

        const agents = mock(async () => {
            throw new Error("registry offline")
        })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })

        const result = await teamFixMemberTool(ctx).execute(
            { team_id: "alpha", member_name: "alice", new_agent: "oct-explore" },
            makeToolContext(sid),
        )
        expect(result).toContain("registry unavailable")
    })

    test("new_prompt with spec present: updates specMember.prompt (not just state)", async () => {
        const root = tmpRoot("fix-prompt-spec")
        const sid = "ses_fix_ps"
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        // Write a spec so readTeamSpec returns a non-null TeamSpec and the
        // `if (args.new_prompt && specMember)` branch (fix.ts:116-118) fires.
        await writeSpecForMembers(root, sid, [{ name: "alice", prompt: "old prompt" }])

        const result = await teamFixMemberTool(makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })).execute(
            { team_id: "alpha", member_name: "alice", new_prompt: "updated standing instructions" },
            makeToolContext(sid),
        )
        expect(result).toContain("prompt: updated")

        // specMember.prompt was actually updated (covers fix.ts:117).
        const spec = await readTeamSpec(root, "alpha", sid)
        expect(spec?.members[0].prompt).toBe("updated standing instructions")
    })
})

// ============================================================
// team_consensus: validation + happy-path startup.
// ============================================================

describe("team_consensus: validation + happy path", () => {
    test("fewer than 2 non-master members → rejected", async () => {
        const root = tmpRoot("con-few")
        const sid = "ses_con_few"
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamConsensusTool(makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })).execute(
            { team_id: "alpha", topic: "is water wet?" },
            makeToolContext(sid),
        )
        expect(result).toContain("at least 2")
    })

    test("happy path: 2 members already spawned → round 1 dispatched to both", async () => {
        const root = tmpRoot("con-happy")
        const sid = "ses_con_happy"
        const aliceSid = "ses_con_h_a"
        const bobSid = "ses_con_h_b"
        await setupTeam(
            root,
            sid,
            [makeMember("alice", aliceSid), makeMember("bob", bobSid)],
            Date.now(),
        )
        const dispatched: string[] = []
        const promptAsync = mock(async (req: { path: { id: string } }) => { dispatched.push(req.path.id) })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })

        const result = await teamConsensusTool(ctx).execute(
            { team_id: "alpha", topic: "pineapple on pizza?" },
            makeToolContext(sid),
        )
        expect(result).toContain("started")

        // Both participants got round 1.
        expect(dispatched).toContain(aliceSid)
        expect(dispatched).toContain(bobSid)

        // Task committed with the right shape.
        const team = await loadTeamState(root, "alpha", sid)
        expect(team.activeTask?.type).toBe("consensus")
        expect(team.activeTask?.currentRound).toBe(1)
        expect(team.status).toBe("busy")
    })
})

// ============================================================
// Happy-path smoke tests for the remaining workflow tools.
// Each test confirms validate+buildTask+dispatch succeed for
// a minimal valid input (members already spawned so
// ensureMembersReady is a no-op).
// ============================================================

describe("team_pipeline: happy-path startup", () => {
    test("single-stage pipeline dispatches the first (only) stage member", async () => {
        const root = tmpRoot("pip-happy")
        const sid = "ses_pip_happy"
        const aliceSid = "ses_pip_h_a"
        await setupTeam(root, sid, [makeMember("alice", aliceSid)], Date.now())
        const dispatched: string[] = []
        const promptAsync = mock(async (req: { path: { id: string } }) => { dispatched.push(req.path.id) })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })

        const result = await teamPipelineTool(ctx).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "do A" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("started")
        expect(dispatched).toContain(aliceSid)

        const team = await loadTeamState(root, "alpha", sid)
        expect(team.activeTask?.type).toBe("pipeline")
        expect(team.activeTask?.currentStageIndex).toBe(0)
    })
})

describe("team_loop: happy-path startup", () => {
    test("loop with decider dispatches the first stage member", async () => {
        const root = tmpRoot("loop-happy")
        const sid = "ses_loop_happy"
        const aliceSid = "ses_loop_h_a"
        await setupTeam(root, sid, [makeMember("alice", aliceSid)], Date.now())
        const dispatched: string[] = []
        const promptAsync = mock(async (req: { path: { id: string } }) => { dispatched.push(req.path.id) })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })

        const result = await teamLoopTool(ctx).execute(
            {
                team_id: "alpha",
                stages: [{ member: "alice", task: "implement feature" }],
                decider: "alice",
                max_rounds: 3,
                initial_task: "start work",
            },
            makeToolContext(sid),
        )
        expect(result).toContain("started")
        expect(dispatched).toContain(aliceSid)

        const team = await loadTeamState(root, "alpha", sid)
        expect(team.activeTask?.type).toBe("loop")
    })

    test("duplicate stage member names → rejected with 'unique' error (loop.ts:51)", async () => {
        const root = tmpRoot("loop-dup")
        const sid = "ses_loop_dup"
        await setupTeam(root, sid, [makeMember("alice")], Date.now())

        const result = await teamLoopTool(makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync: async () => ({}), messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })).execute(
            {
                team_id: "alpha",
                stages: [
                    { member: "alice", task: "code A" },
                    { member: "alice", task: "code B" },
                ],
                decider: "alice",
                max_rounds: 3,
                initial_task: "start",
            },
            makeToolContext(sid),
        )
        expect(result).toContain("unique")
    })

    test("decider NOT in stages → appended as a read-only decider stage (loop.ts:70-75)", async () => {
        const root = tmpRoot("loop-append-decider")
        const sid = "ses_loop_ad"
        const aliceSid = "ses_loop_ad_a"
        const bobSid = "ses_loop_ad_b"
        await setupTeam(
            root,
            sid,
            [makeMember("alice", aliceSid), makeMember("bob", bobSid)],
            Date.now(),
        )
        const promptAsync = mock(async () => ({}))
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })

        // alice is the only stage member; bob is the decider but NOT listed
        // in stages — buildTask must append bob as a read-only decider stage.
        const result = await teamLoopTool(ctx).execute(
            {
                team_id: "alpha",
                stages: [{ member: "alice", task: "implement feature" }],
                decider: "bob",
                max_rounds: 3,
                initial_task: "start work",
            },
            makeToolContext(sid),
        )
        expect(result).toContain("started")

        const team = await loadTeamState(root, "alpha", sid)
        const stages = team.activeTask?.stages
        expect(stages).toHaveLength(2)
        // Appended decider stage is read-only and names bob.
        expect(stages![1].member).toBe("bob")
        expect(stages![1].action).toBe("read_only")
        const task = team.activeTask
        expect(task?.type).toBe("loop")
        if (task?.type === "loop") {
            expect(task.deciderMember).toBe("bob")
        }
    })
})

describe("team_delegate: happy-path startup", () => {
    test("delegate creates tasks and dispatches the first pending to a member", async () => {
        const root = tmpRoot("del-happy")
        const sid = "ses_del_happy"
        const aliceSid = "ses_del_h_a"
        await setupTeam(root, sid, [makeMember("alice", aliceSid)], Date.now())
        const dispatched: string[] = []
        const promptAsync = mock(async (req: { path: { id: string } }) => { dispatched.push(req.path.id) })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })

        const result = await teamDelegateTool(ctx).execute(
            { team_id: "alpha", tasks: [{ subject: "do thing", description: "details" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("started")
        // Delegate dispatches the first pending task to a member.
        expect(dispatched.length).toBeGreaterThanOrEqual(1)

        const team = await loadTeamState(root, "alpha", sid)
        expect(team.activeTask?.type).toBe("delegate")
    })
})

describe("team_parallel: cooperative happy-path startup", () => {
    test("cooperative mode dispatches each member's per-member task", async () => {
        const root = tmpRoot("par-coop-happy")
        const sid = "ses_par_coop"
        const aliceSid = "ses_par_coop_a"
        const bobSid = "ses_par_coop_b"
        await setupTeam(
            root,
            sid,
            [makeMember("alice", aliceSid), makeMember("bob", bobSid)],
            Date.now(),
        )
        const dispatched: string[] = []
        const promptAsync = mock(async (req: { path: { id: string } }) => { dispatched.push(req.path.id) })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })

        const result = await teamParallelTool(ctx).execute(
            {
                team_id: "alpha",
                mode: "cooperative",
                tasks: { alice: "do A", bob: "do B" },
            },
            makeToolContext(sid),
        )
        expect(result).toContain("started")
        expect(dispatched).toContain(aliceSid)
        expect(dispatched).toContain(bobSid)

        const team = await loadTeamState(root, "alpha", sid)
        expect(team.activeTask?.type).toBe("parallel")
        expect(team.activeTask?.mode).toBe("cooperative")
    })
})

describe("team_router: happy-path startup", () => {
    test("router dispatches the router member with the routing input", async () => {
        const root = tmpRoot("rt-happy")
        const sid = "ses_rt_happy"
        const routerSid = "ses_rt_h_router"
        const branchSid = "ses_rt_h_branch"
        await setupTeam(
            root,
            sid,
            [makeMember("router", routerSid), makeMember("branch", branchSid)],
            Date.now(),
        )
        const dispatched: string[] = []
        const promptAsync = mock(async (req: { path: { id: string } }) => { dispatched.push(req.path.id) })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })

        const result = await teamRouteTool(ctx).execute(
            {
                team_id: "alpha",
                router: "router",
                input: "classify this",
                routes: [{ name: "branch-a", member: "branch" }],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("started")
        expect(dispatched).toContain(routerSid)

        const team = await loadTeamState(root, "alpha", sid)
        expect(team.activeTask?.type).toBe("route")
    })
})

describe("team_arbitrate: happy-path startup", () => {
    test("arbitrate dispatches the dispute to all debaters", async () => {
        const root = tmpRoot("arb-happy")
        const sid = "ses_arb_happy"
        const aliceSid = "ses_arb_h_a"
        const bobSid = "ses_arb_h_b"
        const carolSid = "ses_arb_h_c"
        await setupTeam(
            root,
            sid,
            [
                makeMember("alice", aliceSid),
                makeMember("bob", bobSid),
                makeMember("carol", carolSid),
            ],
            Date.now(),
        )
        const dispatched: string[] = []
        const promptAsync = mock(async (req: { path: { id: string } }) => { dispatched.push(req.path.id) })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })

        const result = await teamArbitrateTool(ctx).execute(
            {
                team_id: "alpha",
                task: "settle this dispute",
                arbiter: "carol",
                debaters: ["alice", "bob"],
            },
            makeToolContext(sid),
        )
        expect(result).toContain("started")
        // Both debaters get the initial prompt.
        expect(dispatched).toContain(aliceSid)
        expect(dispatched).toContain(bobSid)

        const team = await loadTeamState(root, "alpha", sid)
        expect(team.activeTask?.type).toBe("arbitrate")
    })
})

describe("team_recurse: happy-path startup", () => {
    test("recurse dispatches the decomposer with the root goal", async () => {
        const root = tmpRoot("rec-happy")
        const sid = "ses_rec_happy"
        const aliceSid = "ses_rec_h_a"
        await setupTeam(root, sid, [makeMember("alice", aliceSid)], Date.now())
        const dispatched: string[] = []
        const promptAsync = mock(async (req: { path: { id: string } }) => { dispatched.push(req.path.id) })
        const ctx = makeCtx({ storageRoot: root, overrides: { client: { app: { log: async () => ({}), agents: async () => ({ data: [] }) }, session: { promptAsync, messages: async () => ({ data: [] }), create: async () => ({ data: { id: "ses_unused" } }), abort: async () => ({}), status: async () => ({ data: {} }) } } } })

        const result = await teamRecurseTool(ctx).execute(
            {
                team_id: "alpha",
                task: "build a calculator",
                decomposer: "alice",
            },
            makeToolContext(sid),
        )
        expect(result).toContain("started")
        expect(dispatched).toContain(aliceSid)

        const team = await loadTeamState(root, "alpha", sid)
        expect(team.activeTask?.type).toBe("recurse")
    })
})

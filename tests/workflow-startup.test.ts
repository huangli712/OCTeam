import { afterEach, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask } from "../src/core/types.js"
import { teamConsensusTool } from "../src/tools/consensus.js"
import { teamDelegateTool } from "../src/tools/delegate.js"
import { teamLoopTool } from "../src/tools/loop.js"
import { teamParallelTool } from "../src/tools/parallel.js"
import { teamPipelineTool } from "../src/tools/pipeline.js"
import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

function makeCtx(storageRoot: string): PluginContext {
    return { storageRoot, scope: "project" } as unknown as PluginContext
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

async function setupTeam(
    root: string, sid: string,
    members = [makeMember("alice"), makeMember("bob")],
    activatedAt?: number,
): Promise<void> {
    await initTeamState(root, makeState("alpha", sid, members, activatedAt), sid)
    await rebuildSessionIndex(root, `${root}__unused`)
}

/** Make the team busy so Phase 1 rejects any new orchestration. */
async function setBusy(root: string, sid: string, type: string): Promise<void> {
    const team = await loadTeamState(root, "alpha", sid)
    await team.mutex.runExclusive(async () => {
        team.status = "busy"
        team.activeTask = {
            type,
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
        await saveTeamState(team)
    })
}

// -----------------------------------------------------------------------
// team_parallel
// -----------------------------------------------------------------------
describe("team_parallel startup validation", () => {
    test("non-master → rejected", async () => {
        const root = tmpRoot("par-nomaster")
        const masterSid = "ses_par_m"
        const memberSid = "ses_par_a"
        tracked.push(masterSid, memberSid)
        await setupTeam(root, masterSid, [makeMember("alice", memberSid)], Date.now())
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "isolated", task: "do x" },
            { sessionID: memberSid } as any,
        )
        expect(result).toContain("master-only")
    })

    test("inactive team → rejected", async () => {
        const root = tmpRoot("par-inactive")
        const sid = "ses_par_inact"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, undefined) // no activatedAt
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "isolated", task: "do x" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("Error")
    })

    test("already busy → rejected", async () => {
        const root = tmpRoot("par-busy")
        const sid = "ses_par_busy"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        await setBusy(root, sid, "parallel")
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "isolated", task: "do x" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("already has an active orchestration")
    })

    test("isolated without task → rejected", async () => {
        const root = tmpRoot("par-notask")
        const sid = "ses_par_notask"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "isolated" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("requires `task`")
    })

    test("cooperative without tasks → rejected", async () => {
        const root = tmpRoot("par-notasks")
        const sid = "ses_par_notasks"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "cooperative" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("requires `tasks`")
    })

    test("signoff_decider not a member → rejected", async () => {
        const root = tmpRoot("par-sd")
        const sid = "ses_par_sd"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "isolated", task: "do x", signoff_policy: "decider", signoff_decider: "bob" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("not a member")
    })

    test("reduce_policy 'select' without reducer_member → rejected", async () => {
        const root = tmpRoot("par-sel-nored")
        const sid = "ses_par_sel_nr"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "isolated", task: "do x", reduce_policy: "select" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("requires reducer_member")
    })

    test("reduce_policy 'merge' without reducer_member → rejected", async () => {
        const root = tmpRoot("par-merge-nored")
        const sid = "ses_par_merge_nr"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "isolated", task: "do x", reduce_policy: "merge" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("requires reducer_member")
    })

    test("reduce_policy 'rubric' with reduce_rubric but no reducer_member → rejected", async () => {
        const root = tmpRoot("par-rub-nored")
        const sid = "ses_par_rub_nr"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamParallelTool(makeCtx(root)).execute(
            { team_id: "alpha", mode: "isolated", task: "do x", reduce_policy: "rubric", reduce_rubric: "correctness" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("requires reducer_member")
    })
})

// -----------------------------------------------------------------------
// team_consensus
// -----------------------------------------------------------------------
describe("team_consensus startup validation", () => {
    test("non-master → rejected", async () => {
        const root = tmpRoot("con-nomaster")
        const masterSid = "ses_con_m"
        const memberSid = "ses_con_a"
        tracked.push(masterSid, memberSid)
        await setupTeam(root, masterSid, [makeMember("alice", memberSid)], Date.now())
        const result = await teamConsensusTool(makeCtx(root)).execute(
            { team_id: "alpha", topic: "use sqlite?" },
            { sessionID: memberSid } as any,
        )
        expect(result).toContain("master-only")
    })

    test("inactive team → rejected", async () => {
        const root = tmpRoot("con-inactive")
        const sid = "ses_con_inact"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, undefined)
        const result = await teamConsensusTool(makeCtx(root)).execute(
            { team_id: "alpha", topic: "use sqlite?" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("Error")
    })

    test("already busy → rejected", async () => {
        const root = tmpRoot("con-busy")
        const sid = "ses_con_busy"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        await setBusy(root, sid, "consensus")
        const result = await teamConsensusTool(makeCtx(root)).execute(
            { team_id: "alpha", topic: "use sqlite?" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("already has an active orchestration")
    })
})

// -----------------------------------------------------------------------
// team_pipeline
// -----------------------------------------------------------------------
describe("team_pipeline startup validation", () => {
    test("non-master → rejected", async () => {
        const root = tmpRoot("pip-nomaster")
        const masterSid = "ses_pip_m"
        const memberSid = "ses_pip_a"
        tracked.push(masterSid, memberSid)
        await setupTeam(root, masterSid, [makeMember("alice", memberSid)], Date.now())
        const result = await teamPipelineTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "do x" }] },
            { sessionID: memberSid } as any,
        )
        expect(result).toContain("master-only")
    })

    test("inactive team → rejected", async () => {
        const root = tmpRoot("pip-inactive")
        const sid = "ses_pip_inact"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, undefined)
        const result = await teamPipelineTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "do x" }] },
            { sessionID: sid } as any,
        )
        expect(result).toContain("Error")
    })

    test("already busy → rejected", async () => {
        const root = tmpRoot("pip-busy")
        const sid = "ses_pip_busy"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        await setBusy(root, sid, "pipeline")
        const result = await teamPipelineTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "do x" }] },
            { sessionID: sid } as any,
        )
        expect(result).toContain("already has an active orchestration")
    })

    test("signoff_decider not a member → rejected", async () => {
        const root = tmpRoot("pip-sd")
        const sid = "ses_pip_sd"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamPipelineTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "do x" }], signoff_policy: "decider", signoff_decider: "bob" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("not a member")
    })

    test("unknown stage member → rejected", async () => {
        const root = tmpRoot("pip-unknown")
        const sid = "ses_pip_unk"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamPipelineTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "bob", task: "do x" }] },
            { sessionID: sid } as any,
        )
        expect(result).toContain("unknown member")
    })

    test("duplicate stage member → rejected", async () => {
        const root = tmpRoot("pip-dup")
        const sid = "ses_pip_dup"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamPipelineTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "a" }, { member: "alice", task: "b" }] },
            { sessionID: sid } as any,
        )
        expect(result).toContain("unique")
    })
})

// -----------------------------------------------------------------------
// team_loop
// -----------------------------------------------------------------------
describe("team_loop startup validation", () => {
    test("non-master → rejected", async () => {
        const root = tmpRoot("loop-nomaster")
        const masterSid = "ses_loop_m"
        const memberSid = "ses_loop_a"
        tracked.push(masterSid, memberSid)
        await setupTeam(root, masterSid, [makeMember("alice", memberSid)], Date.now())
        const result = await teamLoopTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "code" }], decider: "alice", max_rounds: 3, initial_task: "start" },
            { sessionID: memberSid } as any,
        )
        expect(result).toContain("master-only")
    })

    test("inactive team → rejected", async () => {
        const root = tmpRoot("loop-inactive")
        const sid = "ses_loop_inact"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, undefined)
        const result = await teamLoopTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "code" }], decider: "alice", max_rounds: 3, initial_task: "start" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("Error")
    })

    test("already busy → rejected", async () => {
        const root = tmpRoot("loop-busy")
        const sid = "ses_loop_busy"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        await setBusy(root, sid, "loop")
        const result = await teamLoopTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "code" }], decider: "alice", max_rounds: 3, initial_task: "start" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("already has an active orchestration")
    })

    test("decider = 'master' → rejected", async () => {
        const root = tmpRoot("loop-dmaster")
        const sid = "ses_loop_dm"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        const result = await teamLoopTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "code" }], decider: "master", max_rounds: 3, initial_task: "start" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("must be a member")
    })

    test("decider not a member → rejected", async () => {
        const root = tmpRoot("loop-d404")
        const sid = "ses_loop_d404"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamLoopTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "code" }], decider: "bob", max_rounds: 3, initial_task: "start" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("not a member")
    })

    test("unknown stage member → rejected", async () => {
        const root = tmpRoot("loop-unknown")
        const sid = "ses_loop_unk"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamLoopTool(makeCtx(root)).execute(
            { team_id: "alpha", stages: [{ member: "bob", task: "code" }], decider: "alice", max_rounds: 3, initial_task: "start" },
            { sessionID: sid } as any,
        )
        expect(result).toContain("unknown member")
    })
})

// -----------------------------------------------------------------------
// team_delegate
// -----------------------------------------------------------------------
describe("team_delegate startup validation", () => {
    test("non-master → rejected", async () => {
        const root = tmpRoot("del-nomaster")
        const masterSid = "ses_del_m"
        const memberSid = "ses_del_a"
        tracked.push(masterSid, memberSid)
        await setupTeam(root, masterSid, [makeMember("alice", memberSid)], Date.now())
        const result = await teamDelegateTool(makeCtx(root)).execute(
            { team_id: "alpha", tasks: [{ subject: "t1", description: "d" }] },
            { sessionID: memberSid } as any,
        )
        expect(result).toContain("master-only")
    })

    test("inactive team → rejected", async () => {
        const root = tmpRoot("del-inactive")
        const sid = "ses_del_inact"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, undefined)
        const result = await teamDelegateTool(makeCtx(root)).execute(
            { team_id: "alpha", tasks: [{ subject: "t1", description: "d" }] },
            { sessionID: sid } as any,
        )
        expect(result).toContain("Error")
    })

    test("already busy → rejected", async () => {
        const root = tmpRoot("del-busy")
        const sid = "ses_del_busy"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        await setBusy(root, sid, "delegate")
        const result = await teamDelegateTool(makeCtx(root)).execute(
            { team_id: "alpha", tasks: [{ subject: "t1", description: "d" }] },
            { sessionID: sid } as any,
        )
        expect(result).toContain("already has an active orchestration")
    })

    test("unknown blockedBy ref → rejected", async () => {
        const root = tmpRoot("del-ref")
        const sid = "ses_del_ref"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        const result = await teamDelegateTool(makeCtx(root)).execute(
            {
                team_id: "alpha",
                tasks: [
                    { ref: "t1", subject: "s1", description: "d1", blocked_by: ["t2"] },
                ],
            },
            { sessionID: sid } as any,
        )
        expect(result).toContain("unknown blockedBy")
        expect(result).toContain("t2")
    })

    test("signoff_decider not a member → rejected", async () => {
        const root = tmpRoot("del-sd")
        const sid = "ses_del_sd"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamDelegateTool(makeCtx(root)).execute(
            {
                team_id: "alpha",
                tasks: [{ subject: "s1", description: "d1" }],
                signoff_policy: "decider",
                signoff_decider: "bob",
            },
            { sessionID: sid } as any,
        )
        expect(result).toContain("not a member")
    })
})

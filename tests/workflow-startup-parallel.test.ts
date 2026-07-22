import { afterAll, afterEach, describe, expect, test } from "bun:test"

import type { ActiveTask } from "../src/core/types.js"
import { teamParallelTool } from "../src/tools/modes/parallel.js"
import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from './helpers.js';


const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})
afterAll(cleanupTmpRoots)

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
// Shared startup validation: non-master / inactive / busy / signoff_decider
// -----------------------------------------------------------------------

type TeamToolFn = typeof teamParallelTool

interface StartupFixture {
    name: string
    tool: TeamToolFn
    prefix: string
    busyType: string
    validArgs: Record<string, unknown>
    signoff?: boolean
}

const startupFixtures: StartupFixture[] = [
    {
        name: "team_parallel",
        tool: teamParallelTool,
        prefix: "par",
        busyType: "parallel",
        validArgs: { team_id: "alpha", mode: "isolated", task: "do x" },
        signoff: true,
    },
]

for (const fx of startupFixtures) {
    describe(`${fx.name} startup validation`, () => {
        test("non-master → rejected", async () => {
            const root = tmpRoot(`${fx.prefix}-nomaster`)
            const masterSid = `ses_${fx.prefix}_m`
            const memberSid = `ses_${fx.prefix}_a`
            tracked.push(masterSid, memberSid)
            await setupTeam(root, masterSid, [makeMember("alice", memberSid)], Date.now())
            const result = await fx.tool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
                fx.validArgs,
                makeToolContext(memberSid),
            )
            expect(result).toContain("master-only")
        })

        test("inactive team → rejected", async () => {
            const root = tmpRoot(`${fx.prefix}-inactive`)
            const sid = `ses_${fx.prefix}_inact`
            tracked.push(sid)
            await setupTeam(root, sid, undefined, undefined)
            const result = await fx.tool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
                fx.validArgs,
                makeToolContext(sid),
            )
            expect(result).toContain("Error")
        })

        test("already busy → rejected", async () => {
            const root = tmpRoot(`${fx.prefix}-busy`)
            const sid = `ses_${fx.prefix}_busy`
            tracked.push(sid)
            await setupTeam(root, sid, undefined, Date.now())
            await setBusy(root, sid, fx.busyType)
            const result = await fx.tool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
                fx.validArgs,
                makeToolContext(sid),
            )
            expect(result).toContain("already has an active orchestration")
        })

        if (fx.signoff) {
            test("signoff_decider not a member → rejected", async () => {
                const root = tmpRoot(`${fx.prefix}-sd`)
                const sid = `ses_${fx.prefix}_sd`
                tracked.push(sid)
                await setupTeam(root, sid, [makeMember("alice")], Date.now())
                const result = await fx.tool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
                    { ...fx.validArgs, signoff_policy: "decider", signoff_decider: "bob" },
                    makeToolContext(sid),
                )
                expect(result).toContain("not a member")
            })
        }
    })
}

// -----------------------------------------------------------------------
// team_parallel — type-specific validations
// -----------------------------------------------------------------------
describe("team_parallel type-specific validation", () => {
    test("isolated without task → rejected", async () => {
        const root = tmpRoot("par-notask")
        const sid = "ses_par_notask"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        const result = await teamParallelTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", mode: "isolated" },
            makeToolContext(sid),
        )
        expect(result).toContain("requires `task`")
    })

    test("cooperative without tasks → rejected", async () => {
        const root = tmpRoot("par-notasks")
        const sid = "ses_par_notasks"
        tracked.push(sid)
        await setupTeam(root, sid, undefined, Date.now())
        const result = await teamParallelTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", mode: "cooperative" },
            makeToolContext(sid),
        )
        expect(result).toContain("requires `tasks`")
    })

    test("reduce_policy 'select' without reducer_member → rejected", async () => {
        const root = tmpRoot("par-sel-nored")
        const sid = "ses_par_sel_nr"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamParallelTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", mode: "isolated", task: "do x", reduce_policy: "select" },
            makeToolContext(sid),
        )
        expect(result).toContain("requires reducer_member")
    })

    test("reduce_policy 'merge' without reducer_member → rejected", async () => {
        const root = tmpRoot("par-merge-nored")
        const sid = "ses_par_merge_nr"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamParallelTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", mode: "isolated", task: "do x", reduce_policy: "merge" },
            makeToolContext(sid),
        )
        expect(result).toContain("requires reducer_member")
    })

    test("reduce_policy 'rubric' with reduce_rubric but no reducer_member → rejected", async () => {
        const root = tmpRoot("par-rub-nored")
        const sid = "ses_par_rub_nr"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamParallelTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", mode: "isolated", task: "do x", reduce_policy: "rubric", reduce_rubric: "correctness" },
            makeToolContext(sid),
        )
        expect(result).toContain("requires reducer_member")
    })
})

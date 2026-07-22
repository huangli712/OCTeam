import { afterAll, afterEach, describe, expect, test } from "bun:test"

import type { ActiveTask } from "../src/core/types.js"
import { teamPipelineTool } from "../src/tools/modes/pipeline.js"
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

type TeamToolFn = typeof teamPipelineTool

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
        name: "team_pipeline",
        tool: teamPipelineTool,
        prefix: "pip",
        busyType: "pipeline",
        validArgs: { team_id: "alpha", stages: [{ member: "alice", task: "do x" }] },
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
// team_pipeline — type-specific validations
// -----------------------------------------------------------------------
describe("team_pipeline type-specific validation", () => {
    test("unknown stage member → rejected", async () => {
        const root = tmpRoot("pip-unknown")
        const sid = "ses_pip_unk"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamPipelineTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", stages: [{ member: "bob", task: "do x" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("unknown member")
    })

    test("duplicate stage member → rejected", async () => {
        const root = tmpRoot("pip-dup")
        const sid = "ses_pip_dup"
        tracked.push(sid)
        await setupTeam(root, sid, [makeMember("alice")], Date.now())
        const result = await teamPipelineTool(makeCtx({ storageRoot: root, directory: root, calls: [] })).execute(
            { team_id: "alpha", stages: [{ member: "alice", task: "a" }, { member: "alice", task: "b" }] },
            makeToolContext(sid),
        )
        expect(result).toContain("unique")
    })
})

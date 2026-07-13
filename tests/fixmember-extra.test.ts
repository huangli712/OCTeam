/**
 * Coverage-gap tests for src/tools/lifecycle/fixmember.ts — the activeTask data migration
 * during member rename (lines 103-115), which the happy-path tests in
 * tools-extra.test.ts don't exercise.
 *
 * When a member is renamed, any activeTask tokensByMember / responses /
 * deciderMember / stages entries keyed by the old name must migrate to the
 * new name. These tests populate those fields, rename, and verify migration.
 */
import { afterAll, describe, expect, test } from "bun:test"

import type { ActiveTask, TeamSpec } from "../src/core/types.js"
import { teamFixMemberTool } from "../src/tools/lifecycle/fixmember.js"
import { initTeamState, invalidateTeam, loadTeamState, writeTeamSpec } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

function makeParallelTask(): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300_000,
        tokensUsed: 100,
        tokensByMember: { alice: 60, bob: 40 },
        messagesSent: 2,
        responses: { alice: "alice-output", bob: "bob-output" },
        stages: [{ member: "alice", task: "do A", completed: true }],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
    } as ActiveTask
}

function makeLoopTask(): ActiveTask {
    return {
        type: "loop",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300_000,
        tokensUsed: 0,
        tokensByMember: { alice: 0 },
        messagesSent: 0,
        responses: { alice: "" },
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        currentRound: 1,
        maxRounds: 3,
        task: "start",
        deciderMember: "alice",
    } as ActiveTask
}

async function setupTeamWithActiveTask(
    root: string,
    sid: string,
    task: ActiveTask,
) {
    const spec: TeamSpec = {
        version: 1,
        name: "alpha",
        description: "test",
        createdAt: Date.now(),
        members: [
            { name: "alice", role: "coder", prompt: "code", agent: "oct-junior" },
        ],
    }
    await writeTeamSpec(root, spec, sid)
    const state = makeState("alpha", sid, [makeMember("alice", "ses_alice_fix")])
    const team = await initTeamState(root, state, sid)
    // Populate activeTask on the in-memory team object (registry-cached).
    team.activeTask = task
    await rebuildSessionIndex(root, `${root}__user_unused`)
    return team
}

describe("team_fix_member: activeTask migration on rename", () => {
    test("parallel task: tokensByMember, responses, and stages migrate to new name", async () => {
        const root = tmpRoot("fix-par-migrate")
        const sid = "ses_fix_par_migrate"
        const team = await setupTeamWithActiveTask(root, sid, makeParallelTask())

        const result = await teamFixMemberTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", member_name: "alice", new_name: "bob" },
            makeToolContext(sid),
        )
        expect(result).toContain("name: alice → bob")

        const after = await loadTeamState(root, "alpha", sid)
        const at = after.activeTask
        expect(at).toBeDefined()
        expect(at!.tokensByMember).toHaveProperty("bob")
        expect(at!.tokensByMember.bob).toBe(60)
        expect(at!.tokensByMember).not.toHaveProperty("alice")
        expect(at!.responses).toHaveProperty("bob")
        expect(at!.responses.bob).toBe("alice-output")
        expect(at!.responses).not.toHaveProperty("alice")
        // stages member reference migrated
        expect(at!.stages[0]!.member).toBe("bob")

        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession("ses_alice_fix")
    })

    test("loop task: deciderMember migrates to new name", async () => {
        const root = tmpRoot("fix-loop-migrate")
        const sid = "ses_fix_loop_migrate"
        const team = await setupTeamWithActiveTask(root, sid, makeLoopTask())

        const result = await teamFixMemberTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", member_name: "alice", new_name: "bob" },
            makeToolContext(sid),
        )
        expect(result).toContain("name: alice → bob")

        const after = await loadTeamState(root, "alpha", sid)
        const at = after.activeTask
        expect(at).toBeDefined()
        if (at!.type === "loop") {
            expect(at.deciderMember).toBe("bob")
        }
        expect(at!.tokensByMember).toHaveProperty("bob")
        expect(at!.tokensByMember).not.toHaveProperty("alice")

        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession("ses_alice_fix")
    })
})

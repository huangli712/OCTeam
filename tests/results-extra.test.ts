/**
 * Coverage-gap tests for src/tools/results.ts — the member-output-missing and
 * tasks-rendering branches (lines 88-95, 128, 130-131) that review-fixes.test.ts
 * doesn't reach.
 */
import fs from "node:fs/promises"
import path from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { RunRecord } from "../src/core/types.js"
import { teamResultGetTool, teamResultsTool } from "../src/tools/results.js"
import { initTeamState, invalidateTeam } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { runDir, runMemberOutputPath, runRecordPath, teamDir } from "../src/state/paths.js"
import { cleanupTmpRoots, makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

function makeCtx(storageRoot: string): PluginContext {
    return { storageRoot, scope: "project" } as unknown as PluginContext
}

/** Write a RunRecord to disk so results tools can read it. */
async function writeRunRecord(
    teamDirectory: string,
    record: RunRecord,
): Promise<void> {
    const dir = runDir(teamDirectory, record.runId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(runRecordPath(teamDirectory, record.runId), JSON.stringify(record, null, 2), "utf8")
}

async function setupTeam(root: string, sid: string, memberSid: string) {
    const state = makeState("alpha", sid, [makeMember("alice", memberSid)], Date.now())
    const team = await initTeamState(root, state, sid)
    await rebuildSessionIndex(root, `${root}__user_unused`)
    return team
}

describe("team_result_get: member output paths", () => {
    test("member= with name not in memberOutputs → error", async () => {
        const root = tmpRoot("res-ghost")
        const sid = "ses_res_ghost"
        const memberSid = "ses_res_ghost_alice"
        const team = await setupTeam(root, sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)
        await writeRunRecord(tdir, {
            version: 1,
            runId: "run-1",
            teamRunId: "run-alpha-sid",
            teamName: "alpha",
            type: "parallel",
            mode: "isolated",
            status: "completed",
            reason: "completed",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            memberOutputs: { alice: { bytes: 10, file: "alice.md" } },
        } as RunRecord)

        const result = await teamResultGetTool(makeCtx(root)).execute(
            { team_id: "alpha", run_id: "run-1", member: "ghost" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("no output")
        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession(memberSid)
    })

    test("member= output file missing on disk → error", async () => {
        const root = tmpRoot("res-missing")
        const sid = "ses_res_missing"
        const memberSid = "ses_res_missing_alice"
        const team = await setupTeam(root, sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)
        await writeRunRecord(tdir, {
            version: 1,
            runId: "run-2",
            teamRunId: "run-alpha-sid",
            teamName: "alpha",
            type: "parallel",
            mode: "isolated",
            status: "completed",
            reason: "completed",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            memberOutputs: { alice: { bytes: 10, file: "alice.md" } },
        } as RunRecord)
        // Intentionally do NOT create the alice.md output file.

        const result = await teamResultGetTool(makeCtx(root)).execute(
            { team_id: "alpha", run_id: "run-2", member: "alice" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("missing")
        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession(memberSid)
    })
})

describe("team_result_get: tasks rendering", () => {
    test("tasks with owner → @owner in output", async () => {
        const root = tmpRoot("res-task-owner")
        const sid = "ses_res_task_owner"
        const memberSid = "ses_res_task_owner_alice"
        const team = await setupTeam(root, sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)
        await writeRunRecord(tdir, {
            version: 1,
            runId: "run-3",
            teamRunId: "run-alpha-sid",
            teamName: "alpha",
            type: "delegate",
            status: "completed",
            reason: "completed",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            memberOutputs: {},
            tasks: [{ id: "t1", subject: "do thing", status: "completed", owner: "alice" }],
        } as unknown as RunRecord)

        const result = await teamResultGetTool(makeCtx(root)).execute(
            { team_id: "alpha", run_id: "run-3" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("@alice")
        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession(memberSid)
    })

    test("tasks without owner → no @ in task line", async () => {
        const root = tmpRoot("res-task-noowner")
        const sid = "ses_res_task_noowner"
        const memberSid = "ses_res_task_noowner_alice"
        const team = await setupTeam(root, sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)
        await writeRunRecord(tdir, {
            version: 1,
            runId: "run-4",
            teamRunId: "run-alpha-sid",
            teamName: "alpha",
            type: "delegate",
            status: "completed",
            reason: "completed",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            memberOutputs: {},
            tasks: [{ id: "t2", subject: "unclaimed work", status: "pending" }],
        } as RunRecord)

        const result = await teamResultGetTool(makeCtx(root)).execute(
            { team_id: "alpha", run_id: "run-4" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("unclaimed work")
        // Task line should not have @owner (the task line starts with "- [")
        const taskLine = result.split("\n").find(l => l.includes("unclaimed work"))
        expect(taskLine).toBeDefined()
        expect(taskLine!).not.toContain("@")
        invalidateTeam(team.directory)
        unindexSession(sid)
        unindexSession(memberSid)
    })
})

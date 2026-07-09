import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"

import type { RunRecord } from "../src/core/types.js"
import { teamMetricsTool } from "../src/tools/metrics.js"
import { initTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { teamDir, runDir, runRecordPath } from "../src/state/paths.js"
import { makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"


/** Index a fresh "alpha" team owned by `sid` and return its resolved directory. */
async function setupTeam(root: string, sid: string): Promise<string> {
    const state = makeState("alpha", sid, [makeMember("alice")])
    await initTeamState(root, state, sid)
    await rebuildSessionIndex(root, `${root}__unused`)
    return teamDir(root, "alpha", sid)
}

/** Write a single run record into the team's runs/<runId>/record.json. */
async function writeRun(
    dir: string,
    rec: Partial<RunRecord> & Pick<RunRecord, "runId">,
): Promise<void> {
    const full: RunRecord = {
        version: 1,
        teamRunId: "team-run-id",
        teamName: "alpha",
        type: "parallel",
        reason: "parallel_cooperative_complete",
        status: "completed",
        startedAt: 0,
        finishedAt: 0,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        memberOutputs: {},
        ...rec,
    }
    await fs.mkdir(runDir(dir, full.runId), { recursive: true })
    await fs.writeFile(runRecordPath(dir, full.runId), JSON.stringify(full))
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

describe("team_metrics", () => {
    test("(a) empty runs → No run records", async () => {
        const root = tmpRoot("metrics-empty")
        const sid = "ses_metrics_empty"
        tracked.push(sid)
        await setupTeam(root, sid)
        const result = await teamMetricsTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(result).toContain("No run records")
    })

    test("(b) 3 completed + 2 failed → totals + 60% success rate", async () => {
        const root = tmpRoot("metrics-rate")
        const sid = "ses_metrics_rate"
        tracked.push(sid)
        const dir = await setupTeam(root, sid)
        await writeRun(dir, { runId: "r1", status: "completed", finishedAt: 5, tokensUsed: 1000, messagesSent: 2 })
        await writeRun(dir, { runId: "r2", status: "completed", finishedAt: 4, tokensUsed: 2000, messagesSent: 3 })
        await writeRun(dir, { runId: "r3", status: "completed", finishedAt: 3, tokensUsed: 3000, messagesSent: 1 })
        await writeRun(dir, { runId: "r4", status: "failed", reason: "timeout", finishedAt: 2, tokensUsed: 500, messagesSent: 4 })
        await writeRun(dir, { runId: "r5", status: "failed", reason: "budget_exceeded", finishedAt: 1, tokensUsed: 500, messagesSent: 0 })
        const result = await teamMetricsTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        // Runs line: 5 total, 3 completed, 2 failed, 60% success.
        expect(result).toContain("total=5")
        expect(result).toContain("completed=3")
        expect(result).toContain("failed=2")
        expect(result).toContain("60%")
        // Tokens line: 7000 total, 10 messages.
        expect(result).toContain("total=7000")
        expect(result).toContain("messages=10")
    })

    test("(c) per-member token fold across runs", async () => {
        const root = tmpRoot("metrics-member")
        const sid = "ses_metrics_member"
        tracked.push(sid)
        const dir = await setupTeam(root, sid)
        await writeRun(dir, { runId: "r1", finishedAt: 2, tokensUsed: 1200, tokensByMember: { alice: 1000, bob: 200 } })
        await writeRun(dir, { runId: "r2", finishedAt: 1, tokensUsed: 800, tokensByMember: { alice: 500, carol: 300 } })
        const result = await teamMetricsTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(result).toContain("alice: 1500")
        expect(result).toContain("bob: 200")
        expect(result).toContain("carol: 300")
    })

    test("(d) tokensUsed===0 flagged (no token data)", async () => {
        const root = tmpRoot("metrics-notoken")
        const sid = "ses_metrics_notoken"
        tracked.push(sid)
        const dir = await setupTeam(root, sid)
        await writeRun(dir, { runId: "r1", finishedAt: 2, tokensUsed: 0, messagesSent: 1 })
        await writeRun(dir, { runId: "r2", finishedAt: 1, tokensUsed: 1000, messagesSent: 1 })
        const result = await teamMetricsTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(result).toContain("(no token data)")
        expect(result).toContain("No-token-data runs: 1")
    })

    test("(e) limit < retention → showing N of M retained", async () => {
        const root = tmpRoot("metrics-retention")
        const sid = "ses_metrics_retention"
        tracked.push(sid)
        const dir = await setupTeam(root, sid)
        for (let i = 0; i < 5; i++) {
            await writeRun(dir, { runId: `r${i}`, finishedAt: i, tokensUsed: 100 })
        }
        const result = await teamMetricsTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", limit: 2 },
            makeToolContext(sid),
        )
        expect(result).toContain("showing 2 of 5 retained")
    })

    test("(f) per-type grouping with counts + tokens", async () => {
        const root = tmpRoot("metrics-type")
        const sid = "ses_metrics_type"
        tracked.push(sid)
        const dir = await setupTeam(root, sid)
        await writeRun(dir, { runId: "r1", type: "parallel", finishedAt: 3, tokensUsed: 1000 })
        await writeRun(dir, { runId: "r2", type: "parallel", finishedAt: 2, tokensUsed: 2000 })
        await writeRun(dir, { runId: "r3", type: "consensus", finishedAt: 1, tokensUsed: 500 })
        const result = await teamMetricsTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(result).toContain("parallel: count=2")
        expect(result).toContain("3000")
        expect(result).toContain("consensus: count=1")
    })

    test("workflow step durations are aggregated across run records", async () => {
        const root = tmpRoot("metrics-workflow-duration")
        const sid = "ses_metrics_workflow_duration"
        tracked.push(sid)
        const dir = await setupTeam(root, sid)
        await writeRun(dir, {
            runId: "r-workflow-duration",
            type: "workflow",
            finishedAt: 1,
            workflow: {
                steps: [
                    { index: 0, step: 1, kind: "task", member: "alice", completed: true, durationMs: 10 },
                    { index: 1, step: 2, kind: "task", member: "bob", completed: true, durationMs: 30 },
                ],
            },
        })

        const result = await teamMetricsTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        expect(result).toContain("Workflow step durations: count=2  total=40ms  avg=20ms")
    })
})

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    persistRun,
    runStatusFromReason,
    pruneRuns,
    listRunRecords,
    readRunRecord,
    DEFAULT_MAX_RUNS,
} from "../src/orchestration/runs.js"
import {
    runsDir,
    runDir,
    runRecordPath,
    runMemberOutputPath,
} from "../src/state/paths.js"
import { createTask } from "../src/state/tasks.js"
import type { ActiveTask, MemberState } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { AsyncMutex } from "../src/state/locks.js"

function tmpTeamDir(): string {
    return mkdtempSync(join(tmpdir(), "octeam-runs-"))
}

function makeTeam(opts: {
    directory: string
    activeTask?: Partial<ActiveTask>
    members?: Array<Partial<MemberState> & Pick<MemberState, "name">>
}): Team {
    const members: MemberState[] = (opts.members ?? []).map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: true,
        turnCount: 0,
    }))
    const task: ActiveTask | undefined = opts.activeTask
        ? {
              type: "parallel",
              mode: "cooperative",
              startedAt: 1000,
              wallClockTimeoutMs: 300000,
              tokensUsed: 0,
              tokensByMember: {},
              messagesSent: 0,
              responses: {},
              stages: [],
              currentStageIndex: 0,
              decisionHistory: [],
              decisionParseFailures: 0,
              ...opts.activeTask,
          }
        : undefined
    return {
        version: 1,
        teamRunId: "team-run-id",
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
        activeTask: task,
        mutex: new AsyncMutex(),
        directory: opts.directory,
    } as unknown as Team
}

describe("run path helpers", () => {
    test("compose under teamDirectory/runs/<runId>/", () => {
        const dir = "/team"
        expect(runsDir(dir)).toBe("/team/runs")
        expect(runDir(dir, "r1")).toBe("/team/runs/r1")
        expect(runRecordPath(dir, "r1")).toBe("/team/runs/r1/record.json")
        expect(runMemberOutputPath(dir, "r1", "alice")).toBe("/team/runs/r1/alice.md")
    })
})

describe("runStatusFromReason", () => {
    test("completion reasons → completed", () => {
        expect(runStatusFromReason("parallel_cooperative_complete")).toBe("completed")
        expect(runStatusFromReason("consensus_reached")).toBe("completed")
        expect(runStatusFromReason("pipeline_complete")).toBe("completed")
        expect(runStatusFromReason("loop_complete:decider_done")).toBe("completed")
        expect(runStatusFromReason("loop_complete:no_issues")).toBe("completed")
        expect(runStatusFromReason("delegate_complete")).toBe("completed")
        expect(runStatusFromReason("signoff_approved")).toBe("completed")
    })
    test("failure reasons → failed", () => {
        expect(runStatusFromReason("timeout")).toBe("failed")
        expect(runStatusFromReason("budget_exceeded")).toBe("failed")
        expect(runStatusFromReason("member_turn_limit:alice")).toBe("failed")
        expect(runStatusFromReason("member_error:bob:boom")).toBe("failed")
        expect(runStatusFromReason("consensus_max_rounds")).toBe("failed")
        expect(runStatusFromReason("loop_complete:max_rounds")).toBe("failed")
        expect(runStatusFromReason("delegate_deadlock")).toBe("failed")
        expect(runStatusFromReason("loop_complete:decision_parse_failure")).toBe("failed")
        expect(runStatusFromReason("workflow_invalid:bob")).toBe("failed")
    })
})

describe("persistRun", () => {
    test("parallel: writes record.json with metadata + memberOutputs from staged .md", async () => {
        const dir = tmpTeamDir()
        const team = makeTeam({
            directory: dir,
            activeTask: {
                runId: "run-1",
                type: "parallel",
                mode: "isolated",
                tokensUsed: 1234,
                tokensByMember: { alice: 1000, bob: 234 },
                messagesSent: 3,
            },
        })
        // Simulate capture: stage full outputs.
        await fs.mkdir(runDir(dir, "run-1"), { recursive: true })
        await fs.writeFile(runMemberOutputPath(dir, "run-1", "alice"), "x".repeat(50000))
        await fs.writeFile(runMemberOutputPath(dir, "run-1", "bob"), "short")

        await persistRun(team, "parallel_isolated_complete")

        const rec = await readRunRecord(dir, "run-1")
        expect(rec).not.toBeNull()
        expect(rec!.runId).toBe("run-1")
        expect(rec!.teamRunId).toBe("team-run-id")
        expect(rec!.type).toBe("parallel")
        expect(rec!.mode).toBe("isolated")
        expect(rec!.status).toBe("completed")
        expect(rec!.reason).toBe("parallel_isolated_complete")
        expect(rec!.tokensUsed).toBe(1234)
        expect(rec!.memberOutputs.alice.bytes).toBe(50000)
        expect(rec!.memberOutputs.alice.file).toBe("alice.md")
        expect(rec!.memberOutputs.bob.bytes).toBe(5)
    })

    test("lazy runId: generated when task has none", async () => {
        const dir = tmpTeamDir()
        const team = makeTeam({ directory: dir, activeTask: { type: "parallel" } })
        await persistRun(team, "parallel_cooperative_complete")
        expect(team.activeTask!.runId).toBeDefined()
        const rec = await readRunRecord(dir, team.activeTask!.runId!)
        expect(rec).not.toBeNull()
    })

    test("delegate: snapshots task list, no memberOutputs", async () => {
        const dir = tmpTeamDir()
        await createTask(dir, { subject: "task A", description: "do A" })
        await createTask(dir, { subject: "task B", description: "do B" })
        const team = makeTeam({
            directory: dir,
            activeTask: { runId: "run-d", type: "delegate", mode: undefined },
        })
        await persistRun(team, "delegate_complete")
        const rec = await readRunRecord(dir, "run-d")
        expect(rec!.type).toBe("delegate")
        expect(rec!.tasks).toHaveLength(2)
        expect(rec!.tasks!.map(t => t.subject).sort()).toEqual(["task A", "task B"])
        expect(Object.keys(rec!.memberOutputs)).toHaveLength(0)
    })

    test("loop: record carries decisionHistory", async () => {
        const dir = tmpTeamDir()
        const team = makeTeam({
            directory: dir,
            activeTask: {
                runId: "run-l",
                type: "loop",
                currentRound: 2,
                decisionHistory: [
                    { round: 1, decision: "continue", rationale: "more", nextActions: [], timestamp: 1 },
                    { round: 2, decision: "done", rationale: "ok", nextActions: [], timestamp: 2 },
                ],
            },
        })
        await persistRun(team, "loop_complete:decider_done")
        const rec = await readRunRecord(dir, "run-l")
        expect(rec!.decisionHistory).toHaveLength(2)
        expect(rec!.decisionHistory![1].decision).toBe("done")
        expect(rec!.currentRound).toBe(2)
    })

    test("workflow: record carries per-step snapshot", async () => {
        const dir = tmpTeamDir()
        const team = makeTeam({
            directory: dir,
            activeTask: {
                runId: "run-w",
                type: "workflow",
                steps: [
                    { kind: "task", member: "alice", task: "draft", completed: true, output: "draft output" },
                    { kind: "task", member: "carol", task: "polish", completed: true, output: "polish output" },
                    { kind: "gate", verifier: "bob", targetStepIndex: 0, targetStepIndices: [0, 1], criteria: "ok", attempts: 1, verdict: "PASS", score: 9, confidence: 0.8, issues: [{ severity: "medium", message: "minor" }], completed: true },
                ],
            },
        })

        await persistRun(team, "workflow_complete")

        const rec = await readRunRecord(dir, "run-w")
        expect(rec!.type).toBe("workflow")
        expect(rec!.workflow?.steps).toHaveLength(3)
        expect(rec!.workflow?.steps[0]).toMatchObject({ step: 1, kind: "task", member: "alice", output: "draft output" })
        expect(rec!.workflow?.steps[2]).toMatchObject({ step: 3, kind: "gate", verifier: "bob", targetStep: 1, targetSteps: [1, 2], verdict: "PASS", score: 9, confidence: 0.8, issues: [{ severity: "medium", message: "minor" }], attempts: 1 })
    })

    test("no activeTask → no-op", async () => {
        const dir = tmpTeamDir()
        const team = makeTeam({ directory: dir })
        await persistRun(team, "whatever")
        await expect(fs.readdir(runsDir(dir))).rejects.toThrow()
    })
})

describe("retention (pruneRuns)", () => {
    async function writeRun(dir: string, runId: string, finishedAt: number): Promise<void> {
        await fs.mkdir(runDir(dir, runId), { recursive: true })
        await fs.writeFile(
            runRecordPath(dir, runId),
            JSON.stringify({ version: 1, runId, finishedAt, teamName: "t", type: "parallel", status: "completed", reason: "r", teamRunId: "x", startedAt: 0, tokensUsed: 0, tokensByMember: {}, messagesSent: 0, memberOutputs: {} }),
        )
    }

    test("keeps the most recent N, deletes older", async () => {
        const dir = tmpTeamDir()
        for (let i = 0; i < 5; i++) await writeRun(dir, `r${i}`, i * 1000)
        await pruneRuns(dir, 3)
        const remaining = (await fs.readdir(runsDir(dir))).sort()
        // newest 3 by finishedAt are r2, r3, r4
        expect(remaining).toEqual(["r2", "r3", "r4"])
    })

    test("no-op when count <= keep", async () => {
        const dir = tmpTeamDir()
        await writeRun(dir, "r0", 0)
        await writeRun(dir, "r1", 1)
        await pruneRuns(dir, 5)
        expect((await fs.readdir(runsDir(dir))).length).toBe(2)
    })

    test("persistRun enforces DEFAULT_MAX_RUNS", async () => {
        const dir = tmpTeamDir()
        for (let i = 0; i < DEFAULT_MAX_RUNS + 3; i++) {
            const team = makeTeam({
                directory: dir,
                activeTask: { runId: `run-${String(i).padStart(3, "0")}`, type: "parallel" },
            })
            await persistRun(team, "parallel_cooperative_complete")
        }
        const remaining = await fs.readdir(runsDir(dir))
        expect(remaining.length).toBe(DEFAULT_MAX_RUNS)
    })
})

describe("listRunRecords / readRunRecord", () => {
    test("listRunRecords returns newest-first, skips corrupt", async () => {
        const dir = tmpTeamDir()
        for (const [runId, finishedAt] of [["a", 100], ["b", 300], ["c", 200]] as const) {
            const team = makeTeam({ directory: dir, activeTask: { runId, type: "parallel" } })
            await persistRun(team, "parallel_cooperative_complete")
            // backfill finishedAt deterministically
            const rec = await readRunRecord(dir, runId)
            rec!.finishedAt = finishedAt
            await fs.writeFile(runRecordPath(dir, runId), JSON.stringify(rec))
        }
        // a run dir with no record.json (mid-capture) must be skipped
        await fs.mkdir(runDir(dir, "incomplete"), { recursive: true })
        const records = await listRunRecords(dir)
        expect(records.map(r => r.runId)).toEqual(["b", "c", "a"])
    })

    test("readRunRecord returns null for unknown id", async () => {
        const dir = tmpTeamDir()
        expect(await readRunRecord(dir, "nope")).toBeNull()
    })
})

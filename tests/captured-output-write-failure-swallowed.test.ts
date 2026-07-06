/**
 * Regression test for confirmed finding "captured-output-write-failure-swallowed".
 *
 * Bug: src/orchestration/handlers.ts:362 swallows the full-output persistence
 * failure AFTER the in-memory state has already been updated:
 *
 *   338:  task.responses[member.name] = truncateOutput(full)   // in-memory, unconditional
 *   ...
 *   362:  await atomicWrite(outPath, accumulated).catch(err =>
 *   363:      logSwallowed(ctx, "persist member output failed", err, ...),  // SWALLOWED
 *   364:  })
 *   368:  recordEvent(team, { kind: "captured", ... bytes: full.length })  // claims success
 *
 * The full per-turn output is the lossless archive persisted to
 * runs/<runId>/<member>.md (retrieved later by team_result_get). When
 * atomicWrite fails, the error is only logged: task.responses[] is set and a
 * "captured" event is recorded as if the write succeeded, but the .md file is
 * absent. Completed runs can therefore later lack any retrievable member
 * output, with no signal at capture time that persistence failed.
 *
 * Fix: captureMemberOutput must PROPAGATE the persistence failure instead of
 * swallowing it, so the caller (processIdle Step 4) sees the error rather than
 * continuing as though capture succeeded.
 *
 * This test calls captureMemberOutput directly with a PluginContext whose app.log
 * is mocked (the swallowed path logs there). The run directory is pre-created
 * and made READ-ONLY (0o555) so that:
 *   - readFile(outPath) ENOENTs (file absent) -> handled at handlers.ts:357,
 *     prev stays "" (no throw);
 *   - atomicWrite(outPath) fails to create its tmp file in the read-only dir
 *     with EACCES -> the failure that is currently swallowed.
 *
 *   UNFIXED: .catch(logSwallowed) swallows the EACCES -> captureMemberOutput
 *            resolves with void -> the .rejects assertion FAILS ("Expected
 *            promise to be rejected").
 *   FIXED:   the persistence failure propagates -> captureMemberOutput rejects
 *            -> the .rejects assertion PASSES.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"

import { captureMemberOutput } from "../src/orchestration/handlers.js"
import type { ActiveTask, MemberState } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { AsyncMutex } from "../src/state/locks.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

function makeParallelTask(runId: string): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
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
        runId,
        reducePolicy: "summarize",
        signoffPolicy: "none",
    } as ActiveTask
}

function makeTeam(directory: string, activeTask: ActiveTask): Team {
    const members: MemberState[] = [
        { name: "alice", status: "idle", initialized: true, turnCount: 1, sessionId: "ses_alice" },
    ]
    return {
        version: 1,
        teamRunId: "test-run",
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
        createdAt: Date.now(),
        activatedAt: Date.now(),
        activeTask,
        mutex: new AsyncMutex(),
        directory,
    } as unknown as Team
}

// A single user -> assistant turn so captureMemberOutput collects output.
const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "the full deliverable output" }] },
]

afterAll(cleanupTmpRoots)

describe("captureMemberOutput must not swallow persistence failure (finding: captured-output-write-failure-swallowed)", () => {
    test("a full-output write failure must propagate, not be swallowed", async () => {
        const root = tmpRoot("capture-write-swallowed")
        const teamDir = path.join(root, "team")
        // Fixed runId (safe path segment) so we can pre-create and sabotage it.
        const runId = "run-cap-fail"
        const task = makeParallelTask(runId)
        const team = makeTeam(teamDir, task)

        // Pre-create the run directory (atomicWrite's mkdir is then a no-op) and
        // make it READ-ONLY. readFile(outPath) ENOENTs (handled); atomicWrite's
        // tmp-file open fails with EACCES in the read-only dir.
        const runDirAbs = path.join(teamDir, "runs", runId)
        await mkdir(runDirAbs, { recursive: true })
        await chmod(runDirAbs, 0o555)

        try {
            // UNFIXED: .catch(logSwallowed) at handlers.ts:362 swallows the
            // EACCES -> captureMemberOutput resolves -> rejects assertion FAILS.
            // FIXED: the failure propagates -> rejects -> PASS.
            await expect(
                captureMemberOutput(team, team.members[0], messages),
            ).rejects.toThrow()
        } finally {
            // Restore writability so cleanupTmpRoots can remove the tree.
            await chmod(runDirAbs, 0o755).catch(() => {
                // best-effort
            })
        }
    })
})

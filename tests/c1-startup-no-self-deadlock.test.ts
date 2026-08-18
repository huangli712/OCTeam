/**
 * Regression test for C1: H7 fix caused self-deadlock.
 *
 * Bug: H7 added loadTeamState() inside team.mutex.runExclusive() in startup.ts.
 * loadTeamState() internally calls cached.mutex.runExclusive() (non-reentrant
 * AsyncMutex) when refreshing stale cache. When the cache is >1s old,
 * loadTeamState enters the mutex path and self-deadlocks, permanently
 * hanging the team lifecycle lock.
 *
 * Fix: read state.json directly via safeReadFile() instead of loadTeamState(),
 * bypassing the mutex re-entry. The teamLifecycleLockPath file lock already
 * guarantees no sibling process is concurrently writing state.json.
 *
 * This test verifies:
 * 1. Startup completes (does not hang) when disk has spawning=true
 *    (simulating a sibling process that already claimed the spawn slot).
 * 2. The disk spawning state is correctly detected and startup bails.
 */

import { afterAll, describe, expect, mock, test } from "bun:test"
import { writeFile } from "node:fs/promises"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask, TeamSpec } from "../src/core/types.js"
import { startOrchestration } from "../src/orchestration/lifecycle/startup.js"
import { initTeamState, loadTeamState, writeTeamSpec } from "../src/state/store.js"
import { rebuildSessionIndex } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"
import { statePath } from "../src/state/paths.js"

afterAll(cleanupTmpRoots)

describe("C1: startup does not self-deadlock when reading disk spawning state", () => {
    test("disk spawning=true (sibling process) is detected and startup bails within timeout", async () => {
        const root = tmpRoot("c1-deadlock")
        const masterSid = "ses_c1_master"

        // Live, activated team with one spawned member.
        const state = makeState("alpha", masterSid, [makeMember("alice")], Date.now())
        await initTeamState(root, state, masterSid)

        const spec: TeamSpec = {
            version: 1,
            name: "alpha",
            createdAt: Date.now(),
            members: [{ name: "alice", role: "coder", prompt: "do good work" }],
        }
        await writeTeamSpec(root, spec, masterSid)

        await rebuildSessionIndex(root, `${root}__unused`)

        // Load the team into cache (spawning=false).
        const team = await loadTeamState(root, "alpha", masterSid)

        // Simulate a sibling process writing spawning=true to disk.
        // Write directly to state.json, bypassing the cache.
        const diskState = JSON.parse(
            await import("node:fs").then(fs => fs.readFileSync(statePath(team.directory), "utf8")),
        )
        diskState.spawning = true
        diskState.spawningOwner = "sibling-process-uuid"
        await writeFile(statePath(team.directory), JSON.stringify(diskState), "utf8")

        // Set the cache to be stale (>1s) so the disk-read path is exercised.
        team._lastCacheCheck = 0
        team._diskMtime = 0  // force refresh

        const ctx: PluginContext = {
            storageRoot: root,
            scope: "project",
            directory: root,
            client: {
                app: { log: mock(async () => ({})) },
                session: {
                    create: mock(async () => ({ data: { id: "ses_should_not_happen" } })),
                    promptAsync: mock(async () => {}),
                    messages: mock(async () => ({ data: [] })),
                },
            },
        } as unknown as PluginContext

        const validate = () => null
        const buildTask = async (): Promise<ActiveTask | { error: string }> =>
            ({
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
            }) as ActiveTask
        const dispatch = async () => {}
        const successMessage = () => "ok"

        // Race against a 10s timeout. If the fix works, startup should bail
        // immediately with "already has active orchestration". If the old
        // self-deadlock bug is present, this Promise will hang.
        const result = await Promise.race([
            startOrchestration(
                "alpha",
                makeToolContext(masterSid),
                ctx,
                "team_parallel",
                validate,
                buildTask,
                dispatch,
                successMessage,
            ),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("C1 REGRESSION: startup self-deadlocked (hung >10s)")), 10_000),
            ),
        ])

        // Should bail because disk has spawning=true.
        expect(result).toContain("already has an active orchestration")
    })
})

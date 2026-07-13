import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"

import type { PluginContext } from "../src/core/context.js"
import { teamResultGetTool } from "../src/tools/query/results.js"
import { teamProgressTool } from "../src/tools/query/progress.js"
import { maybeTriggerReduce } from "../src/orchestration/modes/reduce.js"
import { runStatusFromReason } from "../src/orchestration/records/runs.js"
import { reconcileCrashedTeams } from "../src/orchestration/lifecycle/reconcile.js"
import { isSafePathSegment, teamDir, runEventsPath, runRecordPath } from "../src/state/paths.js"
import type { ActiveTask } from "../src/core/types.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { makeCtx, makeMember, makeState, makeTeam, makeToolContext, tmpRoot } from "./helpers.js"

// ============================================================================
// Fix1 — path-traversal rejection (BLOCKING-1, security)
// ============================================================================

describe("Fix1: isSafePathSegment", () => {
    test("accepts plain segments (uuid, member names)", () => {
        expect(isSafePathSegment("alice")).toBe(true)
        expect(isSafePathSegment("4f3a-9c2e-run")).toBe(true)
        expect(isSafePathSegment("a1b2c3d4-0000-1111-2222-333344445555")).toBe(true)
    })
    test("rejects traversal, separators, dot segments, empty, NUL", () => {
        expect(isSafePathSegment("../../etc")).toBe(false)
        expect(isSafePathSegment("..")).toBe(false)
        expect(isSafePathSegment(".")).toBe(false)
        expect(isSafePathSegment("a/b")).toBe(false)
        expect(isSafePathSegment("a\\b")).toBe(false)
        expect(isSafePathSegment("a\0b")).toBe(false)
        expect(isSafePathSegment("")).toBe(false)
    })
})

describe("Fix1: tools reject traversal in run_id / member", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })
    async function setup(root: string, sid: string, memberSid: string): Promise<void> {
        await initTeamState(root, makeState("alpha", sid, [makeMember("alice", memberSid)], Date.now()), sid)
        await rebuildSessionIndex(root, `${root}__unused`)
    }

    test("team_result_get rejects run_id with '..'", async () => {
        const root = tmpRoot("fix1-rg-runid")
        const sid = "ses_f1_m", memberSid = "ses_f1_a"
        tracked.push(sid, memberSid)
        await setup(root, sid, memberSid)
        const result = await teamResultGetTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "../../../../etc" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("invalid run_id")
    })

    test("team_result_get rejects member with separator", async () => {
        const root = tmpRoot("fix1-rg-member")
        const sid = "ses_f1b_m", memberSid = "ses_f1b_a"
        tracked.push(sid, memberSid)
        await setup(root, sid, memberSid)
        const result = await teamResultGetTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", member: "../alice" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("invalid member")
    })

    test("team_progress rejects run_id with '..'", async () => {
        const root = tmpRoot("fix1-pr-runid")
        const sid = "ses_f1c_m", memberSid = "ses_f1c_a"
        tracked.push(sid, memberSid)
        await setup(root, sid, memberSid)
        const result = await teamProgressTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "../../other/runs/x" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("invalid run_id")
    })
})

// ============================================================================
// Fix2 — maybeTriggerReduce skips an errored reducer (BLOCKING-2)
// ============================================================================

describe("Fix2: maybeTriggerReduce skips errored reducer", () => {
    const mockCtx = {} as PluginContext // never touched on early-return

    test("errored reducer → false (legacy delivery, no re-dispatch)", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", sessionId: "s", status: "errored" },
                { name: "bob", sessionId: "s2", status: "idle" },
            ],
            activeTask: {
                type: "parallel", mode: "isolated", startedAt: 0,
                responses: { alice: "1", bob: "2" },
                stages: [], currentStageIndex: 0,
                decisionHistory: [], decisionParseFailures: 0,
                reducePolicy: "select", reducerMember: "alice",
            } as any,
        })
        expect(await maybeTriggerReduce(mockCtx, team)).toBe(false)
        // reducer stays errored — NOT flipped back to running
        expect(team.members.find(m => m.name === "alice")!.status).toBe("errored")
        expect(team.activeTask!.reduceStage).toBeUndefined()
    })
})

// ============================================================================
// Fix4 — crash reconcile persists a run record + terminated event
// ============================================================================

describe("Fix4: runStatusFromReason('interrupted') → failed", () => {
    test("interrupted is a failure marker", () => {
        expect(runStatusFromReason("interrupted")).toBe("failed")
    })
})

describe("Fix4: reconcileCrashedTeams persists interrupted run", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })
    function ctxFor(root: string): PluginContext {
        return {
            projectStorageRoot: root,
            userStorageRoot: `${root}__user_unused`,
        } as unknown as PluginContext
    }

    test("busy team → NOT auto-failed (concurrent-instance safety); no interrupted event written", async () => {
        const root = tmpRoot("fix4-recon")
        const sid = "ses_f4"
        tracked.push(sid)
        const busy = {
            ...makeState("crash", sid, [makeMember("alice", "ses_alice")]),
            status: "busy" as const,
            activeTask: {
                type: "parallel",
                mode: "isolated",
                runId: "run-x",
                startedAt: 1000,
                wallClockTimeoutMs: 300000,
                tokensUsed: 42,
                tokensByMember: { alice: 42 },
                messagesSent: 0,
                responses: { alice: "truncated" },
                stages: [],
                currentStageIndex: 0,
                decisionHistory: [],
                decisionParseFailures: 0,
            } as ActiveTask,
        }
        await initTeamState(root, busy, sid)

        await reconcileCrashedTeams(ctxFor(root))

        // New semantics: reconcile must NOT auto-fail a busy team or write a
        // spurious terminated:interrupted event. A concurrent OpenCode instance
        // running server() init could otherwise mark another live process's
        // healthy in-flight orchestration as failed.
        const reloaded = await loadTeamState(root, "crash", sid)
        expect(reloaded.status).toBe("busy")
        expect(reloaded.activeTask).toBeDefined()
        // lastInterruptedTask is snapshotted for a potential team_resume.
        expect(reloaded.lastInterruptedTask).toEqual(busy.activeTask)

        // No run record or terminated event should be persisted.
        const dir = teamDir(root, "crash", sid)
        expect(existsSync(runRecordPath(dir, "run-x"))).toBe(false)
        expect(existsSync(runEventsPath(dir, "run-x"))).toBe(false)
    })
})

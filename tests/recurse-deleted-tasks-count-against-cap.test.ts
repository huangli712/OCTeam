import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { processIdle } from "../src/orchestration/idle.js"
import { createTask, getTask, listAllTasks, updateTask } from "../src/state/tasks.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { ActiveTask, MemberState, RecurseTask, Task } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { makeCtx, type DispatchCall } from "./helpers.js"

/**
 * Regression for finding recurse-deleted-tasks-count-against-cap.
 *
 * src/orchestration/recurse.ts:95 computes the capacity guard as
 *   tasks.length + dec.subtasks.length <= team.bounds.maxTasks
 * using the raw task count, which INCLUDES "deleted" tasks. Every other
 * live-task capacity check in the codebase (src/tools/task.ts:90-92,
 * src/tools/delegate.ts:132-134, src/tools/recurse.ts:61-63) filters out
 * status === "deleted" first. Because of this inconsistency, recurse mode
 * stops decomposing even when live capacity remains, simply because deleted
 * tasks still occupy slots in the count.
 *
 * This test seeds deleted tasks alongside a claimed root, sets maxTasks so
 * that branching is allowed by LIVE count but blocked by RAW count, and
 * asserts the decomposition proceeds. On the unfixed code the guard rejects
 * the decompose (root is finalized as a leaf with no children); once the
 * guard filters deleted tasks, branching proceeds (2 depth-1 children,
 * root re-queued as a pending aggregator).
 */


function statusIdleFrom(outputs: Record<string, string>) {
    return async () => ({ data: Object.fromEntries(Object.entries(outputs).map(([id]) => [id, { type: "idle" }])) })
}

function makeRecurseTask(): RecurseTask {
    return {
        type: "recurse",
        startedAt: 0,
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        decomposerMember: "alice",
        maxDepth: 3,
        maxSubtasks: 5,
        task: "build the app",
        signoffPolicy: "none",
    } as RecurseTask
}

function makeTeam(activeTask: ActiveTask): Team {
    const members: MemberState[] = [
        { name: "alice", status: "idle", initialized: true, turnCount: 0, sessionId: "ses_alice" },
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
        createdAt: 0,
        activeTask,
        mutex: new AsyncMutex(),
        directory: mkdtempSync(join(tmpdir(), "octeam-rec-del-")),
    } as unknown as Team
}

const DECOMPOSE_2 = `<decompose>{"subtasks":[
    {"subject":"part A","description":"do A"},
    {"subject":"part B","description":"do B"}
]}</decompose>`

describe("recurse maxTasks cap must ignore deleted tasks", () => {
    test("deleted tasks do not consume capacity: live(1) + 2 subtasks <= maxTasks(3) branches", async () => {
        const team = makeTeam(makeRecurseTask())
        // maxTasks=3: live count permits branching (1 live + 2 proposed = 3),
        // but raw count blocks it (3 raw + 2 proposed = 5 > 3).
        team.bounds.maxTasks = 3

        // 1 live task: the root, claimed by alice.
        const root = await createTask(team.directory, {
            subject: "root",
            description: "do it",
            depth: 0,
        })
        await updateTask(team.directory, root.id, { status: "claimed", owner: "alice" })

        // 2 deleted tasks: occupy slots in tasks.length but are NOT live.
        // Given explicit owners (!= alice) so they never match alice's claimed
        // task lookup in handleRecurseIdle.
        for (let i = 0; i < 2; i++) {
            const t = await createTask(team.directory, {
                subject: `stale-${i}`,
                description: "already gone",
                depth: 0,
            })
            await updateTask(team.directory, t.id, {
                status: "deleted",
                owner: `ghost-${i}`,
            })
        }

        // Sanity: 3 raw tasks, only 1 live.
        const all = await listAllTasks(team.directory)
        expect(all).toHaveLength(3)
        expect(all.filter(t => t.status !== "deleted")).toHaveLength(1)

        await processIdle(
            makeCtx({ outputs: { ses_alice: DECOMPOSE_2 }, calls: [], status: statusIdleFrom({ ses_alice: DECOMPOSE_2 }) }),
            team,
            team.members[0],
            "ses_alice",
        )

        // BRANCH must happen: 2 depth-1 children created, root re-queued pending.
        const after = await listAllTasks(team.directory)
        expect(after.filter(t => t.depth === 1)).toHaveLength(2)
        const rootAfter = await getTask(team.directory, root.id)
        expect(rootAfter!.status).toBe("pending")
        expect(rootAfter!.blockedBy).toHaveLength(2)
    })
})

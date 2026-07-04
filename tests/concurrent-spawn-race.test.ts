/**
 * Regression test for finding: concurrent-workflow-spawns-duplicate-sessions.
 *
 * Bug: startOrchestration (src/tools/shared.ts) checks team.activeTask under
 * team.mutex in Phase 1, then RELEASES the mutex. Phase 2 runs
 * ensureMembersReady (src/orchestration/dispatch.ts) OUTSIDE the mutex, which
 * spawns child sessions via ctx.client.session.create and overwrites
 * member.sessionId. Phase 3 re-acquires the mutex and re-checks activeTask,
 * but only guards the activeTask commit — NOT the spawn side effects.
 *
 * Two concurrent workflow starts on a team with unspawned members can both
 * pass Phase 1 (activeTask is still null), both enter Phase 2, and both
 * spawn duplicate sessions for the same member. The loser's sessionId is
 * orphaned in the member index.
 *
 * This test MUST FAIL on the current (unfixed) code: session.create is called
 * twice for one member. On fixed code it is called exactly once.
 *
 * Why the race is deterministic (no artificial delays): both calls share the
 * SAME in-memory Team singleton (loadTeamState registry cache, keyed by
 * directory — see src/state/store.ts:133). After Phase 1 releases the mutex,
 * each call computes toSpawn (sync) then awaits readTeamSpec (real file I/O
 * that yields to the macrotask queue). The second call's mutex callback and
 * toSpawn computation run as microtasks BEFORE the first call's readTeamSpec
 * I/O completes, so both capture the member with sessionId still undefined.
 * Both then spawn.
 */
import { afterEach, describe, expect, mock, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask, TeamSpec } from "../src/core/types.js"
import { startOrchestration } from "../src/tools/shared.js"
import { initTeamState, loadTeamState, writeTeamSpec } from "../src/state/store.js"
import { isIndexedMember, rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { makeMember, makeState, tmpRoot } from "./helpers.js"

describe("concurrent-workflow-spawns-duplicate-sessions", () => {
    const tracked: string[] = []
    afterEach(() => {
        for (const sid of tracked.splice(0)) unindexSession(sid)
    })

    test("two concurrent startOrchestration calls spawn exactly one session (no duplicate)", async () => {
        const root = tmpRoot("race-spawn")
        const masterSid = "ses_race_master"
        tracked.push(masterSid)

        // Live, activated team with one UNSPAWNED member (no sessionId).
        const state = makeState("alpha", masterSid, [makeMember("alice")], Date.now())
        await initTeamState(root, state, masterSid)

        // config.json is required by ensureMembersReady's readTeamSpec.
        const spec: TeamSpec = {
            version: 1,
            name: "alpha",
            createdAt: Date.now(),
            members: [{ name: "alice", role: "coder", prompt: "do good work" }],
        }
        await writeTeamSpec(root, spec, masterSid)

        // Index the master session so resolveCallerInTeam authorizes it.
        await rebuildSessionIndex(root, `${root}__unused`)

        const team = await loadTeamState(root, "alpha", masterSid)

        // Record every session.create call and return a unique id per call.
        let createCount = 0
        const createdSessions: string[] = []
        const sessionCreate = mock(async () => {
            const id = `ses_spawned_${++createCount}`
            createdSessions.push(id)
            tracked.push(id)
            return { data: { id } }
        })

        // Simulate the event handler flipping member.initialized after the
        // role-setup prompt is sent, so the role-setup barrier resolves
        // (mirrors the pattern in tests/dispatch-extra.test.ts:362-368).
        const promptAsync = mock(async () => {
            for (const m of team.members) {
                if (!m.isMaster) m.initialized = true
            }
        })

        const ctx: PluginContext = {
            storageRoot: root,
            scope: "project",
            directory: root,
            client: {
                app: { log: mock(async () => ({})) },
                session: {
                    create: sessionCreate as any,
                    promptAsync: promptAsync as any,
                    messages: mock(async () => ({ data: [] })),
                },
            },
        } as unknown as PluginContext

        // Minimal callbacks: validate passes, buildTask returns a serializable
        // ActiveTask, dispatch is a no-op (we only exercise the spawn path).
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

        // Fire two workflow starts concurrently. Both pass Phase 1 (activeTask
        // is null), both enter Phase 2 (ensureMembersReady outside the mutex),
        // and on unfixed code both spawn alice — producing a duplicate
        // session.create and an orphaned indexed session.
        const [r1, r2] = await Promise.all([
            startOrchestration(
                "alpha",
                { sessionID: masterSid } as any,
                ctx,
                "team_parallel",
                validate,
                buildTask,
                dispatch,
                successMessage,
            ),
            startOrchestration(
                "alpha",
                { sessionID: masterSid } as any,
                ctx,
                "team_parallel",
                validate,
                buildTask,
                dispatch,
                successMessage,
            ),
        ])

        // Exactly one call should win; the other should report the race.
        const results = [r1, r2].sort()
        expect(results[0]).toContain("already has an active orchestration")
        expect(results[1]).toBe("ok")

        // PRIMARY ASSERTION: session.create must be called exactly once.
        // On unfixed code this is 2 (the race spawns alice twice).
        expect(createCount).toBe(1)

        // The single spawned session is the member's current sessionId.
        const alice = team.members.find(m => m.name === "alice")!
        expect(alice.sessionId).toBe(createdSessions[0])

        // No orphaned sessions: every created session matches the member's
        // sessionId and is the only one indexed for this member.
        expect(createdSessions).toHaveLength(1)
        expect(isIndexedMember(createdSessions[0])).toBe(true)
    })
})

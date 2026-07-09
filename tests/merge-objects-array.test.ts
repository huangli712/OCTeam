/**
 * Regression coverage for mergeObjects equal-length array element merge.
 *
 * Background: store.ts mergeObjects recurses into plain objects so concurrent
 * sub-field changes both survive, but arrays used to short-circuit to a
 * whole-array rule (current != ancestor -> current wins entirely). That meant
 * two processes editing different indices of the SAME equal-length array
 * (e.g. pipeline stages[], workflow steps[]) lost one writer's change.
 *
 * Fix: when disk/ancestor/current are all equal-length arrays, merge
 * element-by-element. Unequal-length arrays (append/splice) keep the
 * whole-array rule — append-only arrays are single-writer in practice.
 *
 * These tests lock the new element-merge behavior and the fallback.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import type { Stage, TeamState } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { initTeamState, saveTeamState } from "../src/state/store.js"
import { statePath, teamDir } from "../src/state/paths.js"
import { cleanupTmpRoots, makeMember, makeState, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

/** Standalone Team simulating a second process's in-memory snapshot. */
function makeStandaloneTeam(directory: string, state: TeamState): Team {
    const clone: TeamState = JSON.parse(JSON.stringify(state))
    return {
        ...clone,
        directory,
        _diskSnapshot: JSON.parse(JSON.stringify(state)),
        mutex: { runExclusive: <T>(fn: () => Promise<T>) => fn() } as Team["mutex"],
    }
}

async function readDiskState(directory: string): Promise<TeamState> {
    const raw = await readFile(statePath(directory), "utf8")
    return JSON.parse(raw) as TeamState
}

describe("mergeObjects equal-length array element merge", () => {
    test("concurrent per-index field changes on stages[] both survive", async () => {
        const root = tmpRoot("merge-array")
        const sid = "ses_merge"
        const dir = teamDir(root, "beta", sid)

        const stages: Stage[] = [
            { member: "alice", task: "do A", completed: false },
            { member: "bob", task: "do B", completed: false },
        ]
        const seedState = makeState("beta", sid, [makeMember("alice"), makeMember("bob")])
        seedState.activeTask = {
            type: "pipeline",
            startedAt: Date.now(),
            wallClockTimeoutMs: 600_000,
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            responses: {},
            stages,
            currentStageIndex: 0,
            decisionHistory: [],
            decisionParseFailures: 0,
        } as TeamState["activeTask"]
        await initTeamState(root, seedState, sid)

        // Writer B captures a stale snapshot BEFORE A's mutation.
        const staleStateB: TeamState = JSON.parse(JSON.stringify(seedState))
        const teamB = makeStandaloneTeam(dir, staleStateB)

        // Writer A: marks stages[0] completed, saves to disk.
        const teamA = makeStandaloneTeam(dir, seedState)
        teamA.activeTask!.stages[0].completed = true
        await saveTeamState(teamA)

        // Writer B: marks stages[1] completed, saves. B's snapshot still has
        // stages[0].completed === false (stale). On UNFIXED code the array
        // short-circuit replaces the whole stages[] with B's -> stages[0]
        // reverts to false, losing A's change.
        teamB.activeTask!.stages[1].completed = true
        await saveTeamState(teamB)

        const final = await readDiskState(dir)
        expect(final.activeTask!.stages[0].completed).toBe(true)  // A's change preserved
        expect(final.activeTask!.stages[1].completed).toBe(true)  // B's change preserved
    })

    test("unequal-length array falls back to whole-array rule", async () => {
        const root = tmpRoot("merge-array-unequal")
        const sid = "ses_merge2"
        const dir = teamDir(root, "gamma", sid)

        const baseHistory = [{
            round: 1,
            decision: "done" as const,
            rationale: "ok",
            nextActions: [],
            timestamp: Date.now(),
        }]
        const seedState = makeState("gamma", sid, [makeMember("alice")])
        seedState.activeTask = {
            type: "loop",
            startedAt: Date.now(),
            wallClockTimeoutMs: 900_000,
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            responses: {},
            stages: [],
            currentStageIndex: 0,
            decisionHistory: baseHistory,
            decisionParseFailures: 0,
            currentRound: 1,
            maxRounds: 3,
        } as TeamState["activeTask"]
        await initTeamState(root, seedState, sid)

        // Writer B captures stale snapshot (1 entry) before A appends.
        const staleStateB: TeamState = JSON.parse(JSON.stringify(seedState))
        const teamB = makeStandaloneTeam(dir, staleStateB)

        // Writer A: appends a 2nd entry, saves.
        const teamA = makeStandaloneTeam(dir, seedState)
        teamA.activeTask!.decisionHistory.push({
            round: 2, decision: "continue", rationale: "A's entry",
            nextActions: [], timestamp: Date.now(),
        })
        await saveTeamState(teamA)

        // Writer B: appends a different 2nd entry, saves. ancestor (1) !=
        // current (2) != disk (2) lengths -> fallback to whole-array rule ->
        // B's array wins entirely (accepted limitation for append-only arrays).
        teamB.activeTask!.decisionHistory.push({
            round: 2, decision: "done", rationale: "B's entry",
            nextActions: [], timestamp: Date.now(),
        })
        await saveTeamState(teamB)

        const final = await readDiskState(dir)
        expect(final.activeTask!.decisionHistory.length).toBe(2)
        expect(final.activeTask!.decisionHistory[1]!.rationale).toBe("B's entry")
    })
})

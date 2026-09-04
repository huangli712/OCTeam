import { mkdirSync, writeFileSync } from "node:fs"
import { readFile as readFileAsync, writeFile as writeFileAsync } from "node:fs/promises"
import path from "node:path"

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import { handleArenaIdle, selectArenaWinner } from "../src/orchestration/modes/arena.js"
import { parseScoreboard } from "../src/orchestration/protocol/decisions.js"
import { persistRun, readRunRecord, runStatusFromReason } from "../src/orchestration/records/runs.js"
import { buildSummary } from "../src/orchestration/records/summary.js"
import type { ActiveTask, ArenaTask, MemberState, RunRecord } from "../src/core/types.js"
import { type DispatchCall, cleanupTmpRoots, makeMember, makeState, makeToolContext, tmpRoot } from './helpers.js';
import type { PluginContext } from "../src/core/context.js"
import { initTeamState, invalidateTeam, loadTeamState, saveTeamState, type Team } from "../src/state/store.js"
import { AsyncMutex } from "../src/state/locks.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { statePath, teamDir } from "../src/state/paths.js"
import { teamArenaTool } from "../src/tools/modes/arena.js"
import { teamResumeTool } from "../src/tools/control/resume.js"
import { teamResultGetTool, teamResultsTool } from "../src/tools/query/results.js"
import { getExpectedMember } from "../src/orchestration/lifecycle/idle.js"
import { handleStatusEvent } from "../src/orchestration/lifecycle/status.js"
import { checkTermination } from "../src/orchestration/lifecycle/termination.js"
import { resumeDispatch } from "../src/orchestration/lifecycle/resume.js"

afterAll(cleanupTmpRoots)

// =======================================================================
// Arena orchestration tests. This file is shared across arena todos
// (1b parseScoreboard, 1c selectArenaWinner, 1d zod round-trip, ...);
// keep each concern in its own describe block.
// =======================================================================

// --- parseScoreboard (pure function) ---

/** Build a <scoreboard> tag around a raw JSON payload string. */
function sb(payload: string): string {
    return `<scoreboard>${payload}</scoreboard>`
}

describe("parseScoreboard", () => {
    test("parses a valid scoreboard with two entries", () => {
        const r = parseScoreboard(
            sb('{"scores":[{"member":"alice","score":10,"passed":true},{"member":"bob","score":5,"passed":false}],"rationale":"alice fastest"}'),
        )
        expect(r.parseFailed).toBeUndefined()
        expect(r.scores).toHaveLength(2)
        expect(r.scores[0].member).toBe("alice")
        expect(r.scores[0].score).toBe(10)
        expect(r.scores[0].passed).toBe(true)
        expect(r.scores[1].member).toBe("bob")
        expect(r.scores[1].score).toBe(5)
        expect(r.scores[1].passed).toBe(false)
        expect(r.rationale).toBe("alice fastest")
    })

    test("returns parseFailed when the tag is missing", () => {
        const r = parseScoreboard("the candidates look fine, no scoreboard tag")
        expect(r.parseFailed).toBe(true)
        expect(r.scores).toEqual([])
        expect(r.rationale).toBe("")
    })

    test("returns parseFailed for malformed JSON inside the tag", () => {
        expect(parseScoreboard(sb("not valid json")).parseFailed).toBe(true)
    })

    test("returns parseFailed on empty/undefined-like input", () => {
        expect(parseScoreboard("").parseFailed).toBe(true)
        expect(parseScoreboard(undefined as unknown as string).parseFailed).toBe(true)
    })

    test("returns parseFailed when scores is an empty array", () => {
        const r = parseScoreboard(sb('{"scores":[]}'))
        expect(r.parseFailed).toBe(true)
        expect(r.scores).toEqual([])
    })

    test("returns parseFailed when scores is absent or not an array", () => {
        expect(parseScoreboard(sb('{"rationale":"no scores"}')).parseFailed).toBe(true)
        expect(parseScoreboard(sb('{"scores":"nope"}')).parseFailed).toBe(true)
    })

    test("strict: an entry missing a string member makes the whole scoreboard parseFailed", () => {
        const r = parseScoreboard(
            sb('{"scores":[{"member":"alice","score":1,"passed":true},{"score":2,"passed":true}]}'),
        )
        // One invalid entry fails the entire scoreboard (no lossy filter).
        expect(r.parseFailed).toBe(true)
        expect(r.scores).toEqual([])
    })

    test("returns parseFailed when no valid entries remain after dropping", () => {
        // Only entry lacks a member -> dropped -> zero valid entries -> parseFailed.
        const r = parseScoreboard(sb('{"scores":[{"score":2,"passed":true}]}'))
        expect(r.parseFailed).toBe(true)
        expect(r.scores).toEqual([])
    })

    test("rejects a non-numeric score as parseFailed (strict validation)", () => {
        const r = parseScoreboard(sb('{"scores":[{"member":"alice","score":"x","passed":true}]}'))
        expect(r.parseFailed).toBe(true)
    })

    test("rejects a non-finite score as parseFailed (strict validation)", () => {
        const r = parseScoreboard(sb('{"scores":[{"member":"alice","score":1e400,"passed":true}]}'))
        expect(r.parseFailed).toBe(true)
    })

    test("non-finite metric values fail the entire scoreboard", () => {
        const r = parseScoreboard(
            sb('{"scores":[{"member":"alice","metrics":{"speed":1e400,"accuracy":0.9},"passed":true}]}'),
        )
        // Pre-fix code silently dropped non-finite values, which could
        // change winner selection. Now the entire scoreboard fails.
        expect(r.parseFailed).toBe(true)
    })

    test("passed defaults to false when absent", () => {
        const r = parseScoreboard(sb('{"scores":[{"member":"alice","score":1}]}'))
        expect(r.scores[0].passed).toBe(false)
    })

    test("rationale defaults to empty string when absent", () => {
        const r = parseScoreboard(sb('{"scores":[{"member":"alice","score":1,"passed":true}]}'))
        expect(r.rationale).toBe("")
    })

    test("rejects duplicate member entries (parseFailed)", () => {
        const r = parseScoreboard(
            sb('{"scores":[{"member":"alice","score":1,"passed":true},{"member":"alice","score":2,"passed":true}]}'),
        )
        expect(r.parseFailed).toBe(true)
        expect(r.scores).toHaveLength(0)
    })

    test("parses the bilingual <评分板> alias", () => {
        const r = parseScoreboard('<评分板>{"scores":[{"member":"alice","score":1,"passed":true}]}</评分板>')
        expect(r.parseFailed).toBeUndefined()
        expect(r.scores).toHaveLength(1)
        expect(r.scores[0].member).toBe("alice")
    })
})

// --- selectArenaWinner (pure function) ---

describe("selectArenaWinner", () => {
    test("picks the highest passed score when direction is max", () => {
        const sel = selectArenaWinner(
            ["alice", "bob", "carol"],
            {
                scores: [
                    { member: "alice", score: 5, passed: true },
                    { member: "bob", score: 9, passed: true },
                    { member: "carol", score: 7, passed: true },
                ],
            },
            "max",
            "score",
        )
        expect(sel.winner).toBe("bob")
        expect(sel.reason).toBeUndefined()
    })

    test("picks the lowest passed score when direction is min", () => {
        const sel = selectArenaWinner(
            ["alice", "bob", "carol"],
            {
                scores: [
                    { member: "alice", score: 5, passed: true },
                    { member: "bob", score: 9, passed: true },
                    { member: "carol", score: 7, passed: true },
                ],
            },
            "min",
            "score",
        )
        expect(sel.winner).toBe("alice")
    })

    test("selects on metrics[winnerMetric] when winnerMetric is not 'score'", () => {
        const sel = selectArenaWinner(
            ["alice", "bob"],
            {
                scores: [
                    { member: "alice", score: 100, metrics: { speed: 3 }, passed: true },
                    { member: "bob", score: 1, metrics: { speed: 8 }, passed: true },
                ],
            },
            "max",
            "speed",
        )
        expect(sel.winner).toBe("bob")
    })

    test("breaks ties by earliest index in candidates", () => {
        const sel = selectArenaWinner(
            ["alice", "bob", "carol"],
            {
                scores: [
                    { member: "alice", score: 9, passed: true },
                    { member: "bob", score: 9, passed: true },
                    { member: "carol", score: 9, passed: true },
                ],
            },
            "max",
            "score",
        )
        expect(sel.winner).toBe("alice")
    })

    test("a high score with passed:false cannot win", () => {
        const sel = selectArenaWinner(
            ["alice", "bob"],
            {
                scores: [
                    { member: "alice", score: 3, passed: true },
                    { member: "bob", score: 99, passed: false },
                ],
            },
            "max",
            "score",
        )
        expect(sel.winner).toBe("alice")
    })

    test("unknown member not in candidates is ignored when all candidates ARE covered", () => {
        // All candidates (alice, bob) have entries. Mallory is an extra unknown
        // entry — she is ignored because she is not in the candidate list.
        const sel = selectArenaWinner(
            ["alice", "bob"],
            {
                scores: [
                    { member: "alice", score: 3, passed: true },
                    { member: "bob", score: 5, passed: true },
                    { member: "mallory", score: 99, passed: true },
                ],
            },
            "max",
            "score",
        )
        expect(sel.winner).toBe("bob")
    })

    test("a scored non-survivor absent from candidates cannot win", () => {
        // candidates is the survivingCandidates subset: carol errored during
        // implement, so she is excluded even though the evaluator scored her.
        const sel = selectArenaWinner(
            ["alice", "bob"],
            {
                scores: [
                    { member: "alice", score: 3, passed: true },
                    { member: "bob", score: 5, passed: true },
                    { member: "carol", score: 99, passed: true },
                ],
            },
            "max",
            "score",
        )
        expect(sel.winner).toBe("bob")
    })

    test("a candidate with duplicate scoreboard entries fails the whole scoreboard", () => {
        // alice has 2 entries — this is now a hard failure for the entire
        // scoreboard (not just alice becoming ineligible). The evaluator's
        // contract was violated.
        const sel = selectArenaWinner(
            ["alice", "bob"],
            {
                scores: [
                    { member: "alice", score: 99, passed: true },
                    { member: "alice", score: 98, passed: true },
                    { member: "bob", score: 5, passed: true },
                ],
            },
            "max",
            "score",
        )
        expect(sel.winner).toBeUndefined()
        expect(sel.reason).toContain("incomplete_scoreboard")
    })

    test("a member missing the winner metric is ineligible", () => {
        const sel = selectArenaWinner(
            ["alice", "bob"],
            {
                scores: [
                    { member: "alice", metrics: { accuracy: 0.9 }, passed: true },
                    { member: "bob", metrics: { speed: 4 }, passed: true },
                ],
            },
            "max",
            "speed",
        )
        expect(sel.winner).toBe("bob")
    })

    test("a non-finite metric value is ineligible", () => {
        const sel = selectArenaWinner(
            ["alice", "bob"],
            {
                scores: [
                    { member: "alice", score: Number.POSITIVE_INFINITY, passed: true },
                    { member: "bob", score: 5, passed: true },
                ],
            },
            "max",
            "score",
        )
        expect(sel.winner).toBe("bob")
    })

    test("returns no_eligible_candidate when nobody qualifies", () => {
        const sel = selectArenaWinner(
            ["alice", "bob"],
            {
                scores: [
                    { member: "alice", score: 3, passed: false },
                    { member: "bob", passed: true },
                ],
            },
            "max",
            "score",
        )
        expect(sel.winner).toBeUndefined()
        expect(sel.reason).toBe("no_eligible_candidate")
    })

    test("returns no_eligible_candidate for an empty candidate list", () => {
        const sel = selectArenaWinner(
            [],
            { scores: [{ member: "alice", score: 3, passed: true }] },
            "max",
            "score",
        )
        expect(sel.winner).toBeUndefined()
        expect(sel.reason).toBe("no_eligible_candidate")
    })
})

// --- RunRecordSchema arena round-trip + FAILED_REASON_MARKERS (1d) ---

/** Write a record.json payload for <teamDir>/runs/<runId>/record.json. */
function writeArenaRecord(teamDir: string, runId: string, payload: string): void {
    const dir = path.join(teamDir, "runs", runId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "record.json"), payload, "utf8")
}

/** A full arena RunRecord fixture including survivingCandidates + scoreboard. */
function arenaRecord(): RunRecord {
    return {
        version: 1,
        runId: "run-arena",
        teamRunId: "team-run-1",
        teamName: "test-team",
        type: "arena",
        reason: "arena_complete",
        status: "completed",
        startedAt: 1000,
        finishedAt: 5000,
        tokensUsed: 100,
        tokensByMember: {},
        messagesSent: 5,
        memberOutputs: {},
        arena: {
            candidates: ["alice", "bob", "carol"],
            survivingCandidates: ["alice", "bob"],
            evaluator: "eve",
            winner: "bob",
            scoreDirection: "max",
            winnerMetric: "score",
            scoreboard: {
                scores: [
                    { member: "alice", score: 3, passed: true, rationale: "ok" },
                    { member: "bob", score: 5, metrics: { speed: 2 }, passed: true, rationale: "fastest" },
                ],
                rationale: "bob wins",
            },
        },
    }
}

describe("RunRecordSchema arena round-trip (1d)", () => {
    test("round-trips a full arena record incl survivingCandidates without stripping", async () => {
        const root = tmpRoot("runs-arena-roundtrip")
        const record = arenaRecord()
        writeArenaRecord(root, record.runId, JSON.stringify(record))

        const rec = await readRunRecord(root, record.runId)

        expect(rec).not.toBeNull()
        expect(rec?.type).toBe("arena")
        // Deep-equal on the whole arena field catches ANY stripped key,
        // especially survivingCandidates (the schema-omission bug both
        // reviewers flagged: RunRecordSchema strips unknown keys).
        expect(rec?.arena).toEqual(record.arena)
        // Explicit guards on the fields the strip bug would silently drop.
        expect(rec?.arena?.survivingCandidates).toEqual(["alice", "bob"])
        expect(rec?.arena?.winner).toBe("bob")
        expect(rec?.arena?.scoreDirection).toBe("max")
        expect(rec?.arena?.winnerMetric).toBe("score")
        expect(rec?.arena?.scoreboard?.scores).toHaveLength(2)
        expect(rec?.arena?.scoreboard?.scores[1].metrics).toEqual({ speed: 2 })
    })

    test("parses a type:arena record with the arena field omitted (optional)", async () => {
        const root = tmpRoot("runs-arena-omitted")
        const record: RunRecord = {
            version: 1,
            runId: "run-arena-no-meta",
            teamRunId: "team-run-1",
            teamName: "test-team",
            type: "arena",
            reason: "arena_complete",
            status: "completed",
            startedAt: 1000,
            finishedAt: 5000,
            tokensUsed: 100,
            tokensByMember: {},
            messagesSent: 5,
            memberOutputs: {},
        }
        writeArenaRecord(root, record.runId, JSON.stringify(record))

        const rec = await readRunRecord(root, record.runId)

        expect(rec).not.toBeNull()
        expect(rec?.type).toBe("arena")
        expect(rec?.arena).toBeUndefined()
    })

    test("rejects an invalid arena.scoreDirection (schema-enforced, not as-cast)", async () => {
        const root = tmpRoot("runs-arena-bad-dir")
        // scoreDirection "up" is not in z.enum(["max","min"]); build raw JSON
        // since a typed RunRecord cannot express the invalid value.
        writeArenaRecord(root, "run-arena-bad-dir", JSON.stringify({
            version: 1,
            runId: "run-arena-bad-dir",
            teamRunId: "team-run-1",
            teamName: "test-team",
            type: "arena",
            reason: "arena_complete",
            status: "completed",
            startedAt: 1000,
            finishedAt: 5000,
            tokensUsed: 100,
            tokensByMember: {},
            messagesSent: 5,
            memberOutputs: {},
            arena: {
                candidates: ["alice", "bob"],
                evaluator: "eve",
                scoreDirection: "up",
                winnerMetric: "score",
            },
        }))

        const rec = await readRunRecord(root, "run-arena-bad-dir")

        expect(rec).toBeNull()
    })

    test("runStatusFromReason maps arena_failed:* to failed and arena_complete to completed", () => {
        expect(runStatusFromReason("arena_failed:eval_invalid")).toBe("failed")
        expect(runStatusFromReason("arena_failed:no_survivors")).toBe("failed")
        expect(runStatusFromReason("arena_complete")).toBe("completed")
    })
})

// =======================================================================
// team_arena tool: input validation, worktree guard, happy-path dispatch.
// Disk-backed team state + indexed master session (mirrors tollgate.test.ts).
// =======================================================================


const arenaTracked: string[] = []
afterEach(() => {
    for (const sid of arenaTracked.splice(0)) unindexSession(sid)
})

/** PluginContext exposing storageRoot + a promptAsync that records dispatches. */
function makeArenaCtx(root: string, calls: DispatchCall[]): PluginContext {
    return {
        storageRoot: root,
        scope: "project",
        directory: "/app",
        client: {
            session: {
                promptAsync: async (args: any) => {
                    const raw = (args.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "")
                    calls.push({ sessionId: args.path.id, text: raw })
                    return { data: {} }
                },
            },
        },
    } as unknown as PluginContext
}

/** A MemberState with a sessionId (so ensureMembersReady early-returns) and an
 * optional pre-set worktreePath (simulating worktree:true after spawn). */
function arenaMember(name: string, sessionId: string, worktree = true): MemberState {
    // A relative path resolves inside <teamDir>/worktrees/ (isValidTeamState
    // rejects worktreePaths outside the team's worktrees/ dir); the promptAsync
    // stub ignores query.directory, so the value only needs to be truthy + valid.
    return { ...makeMember(name, sessionId), worktreePath: worktree ? `worktrees/${name}` : undefined }
}

async function setupArenaTeam(
    root: string,
    masterSid: string,
    members: MemberState[],
): Promise<void> {
    await initTeamState(root, makeState("alpha", masterSid, members, Date.now()), masterSid)
    await rebuildSessionIndex(root, `${root}__unused`)
}

describe("team_arena tool", () => {
    test("happy path: commits an implement-phase arena task and dispatches every candidate", async () => {
        const root = tmpRoot("arena-tool-happy")
        const sid = "ses_arena_happy_m"
        arenaTracked.push(sid)
        await setupArenaTeam(root, sid, [
            arenaMember("alice", "ses_alice"),
            arenaMember("bob", "ses_bob"),
            arenaMember("carol", "ses_carol"),
        ])
        const calls: DispatchCall[] = []
        const result = await teamArenaTool(makeArenaCtx(root, calls)).execute(
            {
                team_id: "alpha",
                task: "implement a fast sorter",
                evaluator: "carol",
                candidates: ["alice", "bob"],
                eval_criteria: "fastest wall-clock time",
            },
            makeToolContext(sid),
        )

        expect(result).toBe('team_arena started on "alpha" (evaluator: carol, 2 candidate(s)).')

        const team = await loadTeamState(root, "alpha", sid)
        expect(team.activeTask?.type).toBe("arena")
        const at = team.activeTask as ArenaTask
        expect(at.arenaPhase).toBe("implement")
        expect(at.task).toBe("implement a fast sorter")
        expect(at.candidates).toEqual(["alice", "bob"])
        expect(at.evaluatorMember).toBe("carol")

        // Exactly the two candidates were dispatched, EACH with text === task
        // (guards the baseTaskFields task-omission bug). The evaluator waits.
        expect(calls).toHaveLength(2)
        expect(calls.every(c => c.text === "implement a fast sorter")).toBe(true)
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(true)
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(true)
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(false)
    })

    test("unknown evaluator is rejected", async () => {
        const root = tmpRoot("arena-tool-unknown-eval")
        const sid = "ses_arena_unknown_eval_m"
        arenaTracked.push(sid)
        await setupArenaTeam(root, sid, [
            arenaMember("alice", "ses_alice"),
            arenaMember("bob", "ses_bob"),
        ])
        const result = await teamArenaTool(makeArenaCtx(root, [])).execute(
            {
                team_id: "alpha",
                task: "t",
                evaluator: "ghost",
                candidates: ["alice", "bob"],
                eval_criteria: "x",
            },
            makeToolContext(sid),
        )
        expect(result).toBe('Error: unknown evaluator "ghost"')
    })

    test("evaluator who is the master is rejected with a non-master message", async () => {
        const root = tmpRoot("arena-tool-master-eval")
        const sid = "ses_arena_master_eval_m"
        arenaTracked.push(sid)
        // The master is NOT a persisted team member (master is a synthetic
        // runtime record built from the lead session index). Persisting
        // isMaster:true on a real member is now rejected at load time by
        // isValidTeamState (security hardening). So we test the tool-layer
        // rejection path directly: alice is a regular member, and the tool
        // should still reject an evaluator that resolves to the master via
        // the session index. Since the arena tool checks member.isMaster
        // (runtime flag), and only the synthetic master carries it, a real
        // member cannot be the master — so the relevant guard is the
        // nonMasterMembers filter in the candidates check. We instead verify
        // the load-time rejection of a tampered state.
        await setupArenaTeam(root, sid, [
            arenaMember("alice", "ses_alice"),
            arenaMember("bob", "ses_bob"),
            arenaMember("carol", "ses_carol"),
        ])
        // Tamper state.json to add isMaster:true to alice (simulating disk
        // tampering) and verify the load is rejected.
        const stateFile = statePath(teamDir(root, "alpha", sid))
        const raw = await readFileAsync(stateFile, "utf8")
        const tampered = JSON.parse(raw)
        tampered.members[0].isMaster = true
        await writeFileAsync(stateFile, JSON.stringify(tampered, null, 2))
        // Force a cache invalidation so the next load reads from disk.
        invalidateTeam(teamDir(root, "alpha", sid))
        const result = await teamArenaTool(makeArenaCtx(root, [])).execute(
            {
                team_id: "alpha",
                task: "t",
                evaluator: "alice",
                candidates: ["bob", "carol"],
                eval_criteria: "x",
            },
            makeToolContext(sid),
        )
        // The tampered state must be rejected at load time.
        expect(result).toContain("Error:")
        expect(result).not.toContain("unknown evaluator")
    })

    test("evaluator listed as a candidate is rejected", async () => {
        const root = tmpRoot("arena-tool-eval-in-cand")
        const sid = "ses_arena_eval_in_cand_m"
        arenaTracked.push(sid)
        await setupArenaTeam(root, sid, [
            arenaMember("alice", "ses_alice"),
            arenaMember("bob", "ses_bob"),
        ])
        const result = await teamArenaTool(makeArenaCtx(root, [])).execute(
            {
                team_id: "alpha",
                task: "t",
                evaluator: "alice",
                candidates: ["alice", "bob"],
                eval_criteria: "x",
            },
            makeToolContext(sid),
        )
        expect(result).toBe('Error: evaluator "alice" must not also be a candidate')
    })

    test("fewer than 2 candidates is rejected", async () => {
        const root = tmpRoot("arena-tool-one-cand")
        const sid = "ses_arena_one_cand_m"
        arenaTracked.push(sid)
        await setupArenaTeam(root, sid, [
            arenaMember("alice", "ses_alice"),
            arenaMember("carol", "ses_carol"),
        ])
        const result = await teamArenaTool(makeArenaCtx(root, [])).execute(
            {
                team_id: "alpha",
                task: "t",
                evaluator: "carol",
                candidates: ["alice"],
                eval_criteria: "x",
            },
            makeToolContext(sid),
        )
        expect(result).toBe("Error: team_arena requires at least 2 candidates")
    })

    test("duplicate candidate names are rejected", async () => {
        const root = tmpRoot("arena-tool-dup-cand")
        const sid = "ses_arena_dup_cand_m"
        arenaTracked.push(sid)
        await setupArenaTeam(root, sid, [
            arenaMember("alice", "ses_alice"),
            arenaMember("bob", "ses_bob"),
            arenaMember("carol", "ses_carol"),
        ])
        const result = await teamArenaTool(makeArenaCtx(root, [])).execute(
            {
                team_id: "alpha",
                task: "t",
                evaluator: "carol",
                candidates: ["a", "a"],
                eval_criteria: "x",
            },
            makeToolContext(sid),
        )
        expect(result).toBe("Error: candidates must have unique names")
    })

    test("no eval basis (neither eval_command nor eval_criteria) is rejected", async () => {
        const root = tmpRoot("arena-tool-no-basis")
        const sid = "ses_arena_no_basis_m"
        arenaTracked.push(sid)
        await setupArenaTeam(root, sid, [
            arenaMember("alice", "ses_alice"),
            arenaMember("bob", "ses_bob"),
            arenaMember("carol", "ses_carol"),
        ])
        const result = await teamArenaTool(makeArenaCtx(root, [])).execute(
            {
                team_id: "alpha",
                task: "t",
                evaluator: "carol",
                candidates: ["alice", "bob"],
            },
            makeToolContext(sid),
        )
        expect(result).toBe("Error: team_arena requires at least one of eval_command or eval_criteria")
    })

    test("unknown candidate is rejected", async () => {
        const root = tmpRoot("arena-tool-unknown-cand")
        const sid = "ses_arena_unknown_cand_m"
        arenaTracked.push(sid)
        await setupArenaTeam(root, sid, [
            arenaMember("alice", "ses_alice"),
            arenaMember("carol", "ses_carol"),
        ])
        const result = await teamArenaTool(makeArenaCtx(root, [])).execute(
            {
                team_id: "alpha",
                task: "t",
                evaluator: "carol",
                candidates: ["alice", "ghost"],
                eval_criteria: "x",
            },
            makeToolContext(sid),
        )
        expect(result).toBe('Error: candidate "ghost" is not a member of team "alpha"')
    })

    test("a candidate without an isolated worktree is rejected in buildTask", async () => {
        const root = tmpRoot("arena-tool-no-worktree")
        const sid = "ses_arena_no_worktree_m"
        arenaTracked.push(sid)
        await setupArenaTeam(root, sid, [
            arenaMember("alice", "ses_alice"),
            arenaMember("bob", "ses_bob", false), // no worktree:true
            arenaMember("carol", "ses_carol"),
        ])
        const result = await teamArenaTool(makeArenaCtx(root, [])).execute(
            {
                team_id: "alpha",
                task: "t",
                evaluator: "carol",
                candidates: ["alice", "bob"],
                eval_criteria: "x",
            },
            makeToolContext(sid),
        )
        expect(result).toBe(
            "team_arena requires every candidate to have an isolated worktree (create with worktree:true): bob",
        )
    })

    test("non-master caller is rejected (master-only)", async () => {
        const root = tmpRoot("arena-tool-nomaster")
        const masterSid = "ses_arena_nomaster_m"
        const memberSid = "ses_alice"
        arenaTracked.push(masterSid, memberSid)
        await setupArenaTeam(root, masterSid, [
            arenaMember("alice", memberSid),
            arenaMember("bob", "ses_bob"),
            arenaMember("carol", "ses_carol"),
        ])
        const result = await teamArenaTool(makeArenaCtx(root, [])).execute(
            {
                team_id: "alpha",
                task: "t",
                evaluator: "carol",
                candidates: ["alice", "bob"],
                eval_criteria: "x",
            },
            makeToolContext(memberSid),
        )
        expect(result).toContain("master-only")
    })
})


// =======================================================================
// Arena IMPLEMENT phase handler (2b): barrier, failure isolation, and the
// implement->evaluate transition. In-memory team objects (mirrors the
// tollgate.test.ts makeTeam harness); finishRun/saveTeamState/persistRun
// write under a tracked tmp directory so nothing touches on-disk load paths.
// =======================================================================

/** Look up a member without mutating it (the implement barrier reads status
 * from the fixture; handleArenaIdle ignores the trigger member's identity). */
function memberByName(team: Team, name: string): MemberState {
    const m = team.members.find(x => x.name === name)
    if (!m) throw new Error(`no member ${name}`)
    return m
}

/** Minimal valid arena ActiveTask (implement phase) with sensible defaults. */
function makeArenaTask(opts: Partial<ArenaTask> = {}): ArenaTask {
    return {
        type: "arena",
        task: "implement the widget",
        startedAt: 0,
        wallClockTimeoutMs: 600000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        candidates: ["alice", "bob"],
        evaluatorMember: "carol",
        arenaPhase: "implement",
        scoreDirection: "max",
        winnerMetric: "score",
        maxEvalRetries: 1,
        ...opts,
    } as ArenaTask
}

/** In-memory busy Team carrying worktree paths + a tracked tmp directory for IO. */
function makeArenaHandlerTeam(opts: {
    activeTask?: ActiveTask
    members?: Array<Partial<MemberState> & Pick<MemberState, "name">>
}): Team {
    const members: MemberState[] = (opts.members ?? []).map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: m.initialized ?? true,
        turnCount: m.turnCount ?? 0,
        sessionId: m.sessionId,
        agent: m.agent,
        isMaster: m.isMaster,
        worktreePath: m.worktreePath,
    }))
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
        activeTask: opts.activeTask,
        mutex: new AsyncMutex(),
        directory: tmpRoot("arena-handler"),
    } as unknown as Team
}

describe("arena implement phase", () => {
    test("2 idle candidates fire the barrier and dispatch the evaluator exactly once", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            candidates: ["alice", "bob"],
            evaluatorMember: "carol",
            evalCommand: "bun test",
            evalCriteria: "fastest wall-clock time",
        })
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" },
                { name: "carol", sessionId: "ses_carol", worktreePath: "/app/wt/carol" },
            ],
        })

        await handleArenaIdle(ctx, team, memberByName(team, "alice"))

        expect(task.arenaPhase).toBe("evaluate")
        expect(task.survivingCandidates).toEqual(["alice", "bob"])
        expect(team.activeTask).toBeDefined()
        // Evaluator dispatched EXACTLY once; its prompt names BOTH worktrees + the block.
        const evalCalls = calls.filter(c => c.sessionId === "ses_carol")
        expect(evalCalls).toHaveLength(1)
        expect(evalCalls[0].text).toContain("/app/wt/alice")
        expect(evalCalls[0].text).toContain("/app/wt/bob")
        expect(evalCalls[0].text).toContain("<scoreboard>")
        // Candidates are NOT re-dispatched by the barrier transition.
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(false)
    })

    test("evalCommand-only (no evalCriteria) reaches the evaluator prompt", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            candidates: ["alice", "bob"],
            evaluatorMember: "carol",
            evalCommand: "bun test",
            // evalCriteria intentionally omitted
        })
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" },
                { name: "carol", sessionId: "ses_carol", worktreePath: "/app/wt/carol" },
            ],
        })

        await handleArenaIdle(ctx, team, memberByName(team, "alice"))

        expect(task.arenaPhase).toBe("evaluate")
        const evalCalls = calls.filter(c => c.sessionId === "ses_carol")
        expect(evalCalls).toHaveLength(1)
        expect(evalCalls[0].text).toContain("bun test")
    })

    test("evaluator without a sessionId -> arena_failed:evaluator_unavailable, phase stays implement", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({ evalCriteria: "fastest" })
        const runId = task.runId!
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" },
                { name: "carol" }, // no session -> evaluator unavailable
            ],
        })

        await handleArenaIdle(ctx, team, memberByName(team, "alice"))

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        // NOT advanced to evaluate (no evaluate-phase state persisted).
        expect(task.arenaPhase).toBe("implement")
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(false)
        expect(calls.some(c => c.sessionId === "ses_lead")).toBe(true)
        const record = await readRunRecord(team.directory, runId)
        expect(record?.reason).toBe("arena_failed:evaluator_unavailable")
        expect(record?.status).toBe("failed")
    })

    test("evaluator in errored status -> arena_failed:evaluator_unavailable, phase stays implement", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({ evalCriteria: "fastest" })
        const runId = task.runId!
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" },
                { name: "carol", sessionId: "ses_carol", status: "errored" },
            ],
        })

        await handleArenaIdle(ctx, team, memberByName(team, "alice"))

        expect(team.status).toBe("failed")
        expect(task.arenaPhase).toBe("implement")
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(false)
        const record = await readRunRecord(team.directory, runId)
        expect(record?.reason).toBe("arena_failed:evaluator_unavailable")
        expect(record?.status).toBe("failed")
    })

    test("all candidates errored -> arena_failed:no_survivors, evaluator never dispatched", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({ evalCriteria: "fastest" })
        const runId = task.runId!
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "errored", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", status: "errored", worktreePath: "/app/wt/bob" },
                { name: "carol", sessionId: "ses_carol", worktreePath: "/app/wt/carol" },
            ],
        })

        await handleArenaIdle(ctx, team, memberByName(team, "bob"))

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        expect(task.arenaPhase).toBe("implement")
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(false)
        const record = await readRunRecord(team.directory, runId)
        expect(record?.reason).toBe("arena_failed:no_survivors")
        expect(record?.status).toBe("failed")
    })

    test("errored candidates over tolerance -> arena_failed:member_error:<firstErrored>", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({ evalCriteria: "fastest", maxErroredMembers: 0 })
        const runId = task.runId!
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "errored", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" }, // idle survivor
                { name: "carol", sessionId: "ses_carol", worktreePath: "/app/wt/carol" },
            ],
        })

        await handleArenaIdle(ctx, team, memberByName(team, "bob"))

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        expect(task.arenaPhase).toBe("implement")
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(false)
        const record = await readRunRecord(team.directory, runId)
        expect(record?.reason).toBe("arena_failed:member_error:alice")
        expect(record?.status).toBe("failed")
    })

    test("errored candidate within tolerance is excluded from survivors + prompt, evaluator still runs", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({ evalCriteria: "fastest", maxErroredMembers: 1 })
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "errored", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" }, // idle survivor
                { name: "carol", sessionId: "ses_carol", worktreePath: "/app/wt/carol" },
            ],
        })

        await handleArenaIdle(ctx, team, memberByName(team, "bob"))

        // Within tolerance: proceed to evaluate with the errored candidate excluded.
        expect(task.arenaPhase).toBe("evaluate")
        expect(task.survivingCandidates).toEqual(["bob"])
        const evalCalls = calls.filter(c => c.sessionId === "ses_carol")
        expect(evalCalls).toHaveLength(1)
        expect(evalCalls[0].text).toContain("/app/wt/bob")
        // The errored candidate's worktree is NOT named in the evaluator prompt.
        expect(evalCalls[0].text).not.toContain("/app/wt/alice")
    })
})


// =======================================================================
// Arena EVALUATE phase handler (2c): scoreboard parse, deterministic winner
// selection, eval retry on parse/selection failure, and direct delivery.
// Reuses the in-memory makeArenaHandlerTeam harness from the implement block.
// =======================================================================

/** A valid <scoreboard> naming alice+bob as passed; alice highest on score. */
function validScoreboard(): string {
    return sb('{"scores":[{"member":"alice","score":10,"passed":true},{"member":"bob","score":5,"passed":true}],"rationale":"alice fastest"}')
}

/** Three ready members (alice, bob candidates; carol evaluator), all worktrees. */
function evaluatePhaseMembers(): Array<Partial<MemberState> & Pick<MemberState, "name">> {
    return [
        { name: "alice", sessionId: "ses_alice", worktreePath: "/app/wt/alice" },
        { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" },
        { name: "carol", sessionId: "ses_carol", worktreePath: "/app/wt/carol" },
    ]
}

describe("arena evaluate phase", () => {
    test("valid scoreboard -> winner selected, run finishes arena_complete (completed)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            survivingCandidates: ["alice", "bob"],
            evalCriteria: "fastest",
            responses: { carol: validScoreboard() },
        })
        const runId = task.runId!
        const team = makeArenaHandlerTeam({ activeTask: task, members: evaluatePhaseMembers() })

        await handleArenaIdle(ctx, team, memberByName(team, "carol"))

        // Deterministic winner: alice (score 10) beats bob (score 5) on max.
        expect(task.winner).toBe("alice")
        expect(task.scoreboard?.scores).toHaveLength(2)
        // Delivered + persisted as a successful (completed) run.
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        expect(calls.some(c => c.sessionId === "ses_lead")).toBe(true)
        const record = await readRunRecord(team.directory, runId)
        expect(record?.reason).toBe("arena_complete")
        expect(record?.status).toBe("completed")
    })

    test("malformed scoreboard once -> stale response deleted, evaluator re-dispatched, not finished", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            survivingCandidates: ["alice", "bob"],
            evalCriteria: "fastest",
            maxEvalRetries: 1,
            responses: { carol: "no scoreboard tag here, just noise" },
        })
        const team = makeArenaHandlerTeam({ activeTask: task, members: evaluatePhaseMembers() })

        await handleArenaIdle(ctx, team, memberByName(team, "carol"))

        expect(task.evalAttempts).toBe(1)
        // Stale evaluator response deleted so resume cannot re-consume it.
        expect(task.responses.carol).toBeUndefined()
        // Evaluator re-dispatched exactly once with the same scoreboard prompt.
        const evalCalls = calls.filter(c => c.sessionId === "ses_carol")
        expect(evalCalls).toHaveLength(1)
        expect(evalCalls[0].text).toContain("<scoreboard>")
        // Still in evaluate phase; run NOT finished.
        expect(task.arenaPhase).toBe("evaluate")
        expect(team.activeTask).toBeDefined()
        expect(team.status).toBe("busy")
    })

    test("malformed scoreboard exhausts retries -> arena_failed:eval_invalid (failed)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            survivingCandidates: ["alice", "bob"],
            evalCriteria: "fastest",
            maxEvalRetries: 1,
            evalAttempts: 1, // next failure (-> 2) exceeds maxEvalRetries
            responses: { carol: "still no scoreboard" },
        })
        const runId = task.runId!
        const team = makeArenaHandlerTeam({ activeTask: task, members: evaluatePhaseMembers() })

        await handleArenaIdle(ctx, team, memberByName(team, "carol"))

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(false)
        const record = await readRunRecord(team.directory, runId)
        expect(record?.reason).toBe("arena_failed:eval_invalid")
        expect(record?.status).toBe("failed")
    })

    test("parsed scoreboard with no eligible candidate -> retry path (not a success)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            survivingCandidates: ["alice", "bob"],
            evalCriteria: "fastest",
            maxEvalRetries: 1,
            // Parses cleanly, but every entry passed:false -> no_eligible_candidate.
            responses: { carol: sb('{"scores":[{"member":"alice","score":10,"passed":false},{"member":"bob","score":5,"passed":false}]}') },
        })
        const team = makeArenaHandlerTeam({ activeTask: task, members: evaluatePhaseMembers() })

        await handleArenaIdle(ctx, team, memberByName(team, "carol"))

        // Same retry/increment/delete path as a malformed board (NOT a win).
        expect(task.winner).toBeUndefined()
        expect(task.evalAttempts).toBe(1)
        expect(task.responses.carol).toBeUndefined()
        const evalCalls = calls.filter(c => c.sessionId === "ses_carol")
        expect(evalCalls).toHaveLength(1)
        expect(task.arenaPhase).toBe("evaluate")
        expect(team.activeTask).toBeDefined()
    })

    test("a stray non-evaluator idle in evaluate phase is ignored (no state change)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            survivingCandidates: ["alice", "bob"],
            evalCriteria: "fastest",
            responses: { carol: validScoreboard() },
        })
        const team = makeArenaHandlerTeam({ activeTask: task, members: evaluatePhaseMembers() })

        // alice != evaluator (carol): must return with no side effects.
        await handleArenaIdle(ctx, team, memberByName(team, "alice"))

        expect(task.winner).toBeUndefined()
        expect(task.scoreboard).toBeUndefined()
        expect(calls).toHaveLength(0)
        expect(task.arenaPhase).toBe("evaluate")
        expect(team.activeTask).toBeDefined()
        expect(team.status).toBe("busy")
    })

    test("evaluate phase with empty survivingCandidates fails closed (no fallback to candidates)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            survivingCandidates: [], // corrupted/edited state -> fail closed
            candidates: ["alice", "bob"], // a fallback here would wrongly succeed
            evalCriteria: "fastest",
            responses: { carol: validScoreboard() },
        })
        const runId = task.runId!
        const team = makeArenaHandlerTeam({ activeTask: task, members: evaluatePhaseMembers() })

        await handleArenaIdle(ctx, team, memberByName(team, "carol"))

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        expect(task.winner).toBeUndefined()
        const record = await readRunRecord(team.directory, runId)
        expect(record?.reason).toBe("arena_failed:no_survivors")
        expect(record?.status).toBe("failed")
    })
})


// =======================================================================
// getExpectedMember arena branch (3a): identity validation. Implement phase
// accepts any candidate idle (null); evaluate phase expects ONLY the
// evaluator, so a stray candidate idle does not advance the state machine.
// =======================================================================

describe("arena getExpectedMember", () => {
    test("an implement-phase arena task expects no specific member (null)", () => {
        const task = makeArenaTask({ arenaPhase: "implement" })
        expect(getExpectedMember(task)).toBeNull()
    })

    test("an evaluate-phase arena task expects the evaluator", () => {
        const task = makeArenaTask({ arenaPhase: "evaluate", evaluatorMember: "carol" })
        expect(getExpectedMember(task)).toBe("carol")
    })
})


// =======================================================================
// Arena termination (3b): checkTermination's arena branch inside the
// errored-member block. Implement phase = candidate-count tolerance
// (same ordered branching as 2b); evaluate phase = evaluator-strict —
// tolerated candidate errors lingering from implement are IGNORED. The
// regression case is the load-bearing Metis guard. Wall-clock is pinned
// (now=TERM_NOW, task.startedAt=0) so the timeout branch never fires first.
// =======================================================================

const TERM_NOW = 1000 // task.startedAt is 0; keeps now-startedAt < wallClockTimeoutMs

describe("arena termination", () => {
    test("implement phase, one errored candidate within tolerance -> no termination (barrier proceeds)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "implement",
            candidates: ["alice", "bob"],
            evaluatorMember: "carol",
            maxErroredMembers: 1,
        })
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "errored", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" }, // survivor
                { name: "carol", sessionId: "ses_carol", worktreePath: "/app/wt/carol" },
            ],
        })

        await checkTermination(ctx, team, TERM_NOW)

        // Within tolerance with a survivor: the arena branch is a no-op and the
        // barrier (handleArenaIdle) owns delivery. A tolerance-0 generic path fails here.
        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
    })

    test("implement phase, errored candidates over tolerance -> arena_failed:member_error:<firstErrored>", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "implement",
            candidates: ["alice", "bob"],
            evaluatorMember: "carol",
            maxErroredMembers: 0,
        })
        const runId = task.runId!
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "errored", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" }, // survivor
                { name: "carol", sessionId: "ses_carol", worktreePath: "/app/wt/carol" },
            ],
        })

        await checkTermination(ctx, team, TERM_NOW)

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const record = await readRunRecord(team.directory, runId)
        expect(record?.reason).toBe("arena_failed:member_error:alice")
        expect(record?.status).toBe("failed")
    })

    test("evaluate phase, evaluator errored -> arena_failed:evaluator_error immediately", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            candidates: ["alice", "bob"],
            survivingCandidates: ["alice", "bob"],
            evaluatorMember: "carol",
            maxErroredMembers: 1,
        })
        const runId = task.runId!
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" },
                { name: "carol", sessionId: "ses_carol", status: "errored", worktreePath: "/app/wt/carol" },
            ],
        })

        await checkTermination(ctx, team, TERM_NOW)

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const record = await readRunRecord(team.directory, runId)
        expect(record?.reason).toBe("arena_failed:evaluator_error")
        expect(record?.status).toBe("failed")
    })

    test("REGRESSION (Metis): evaluate phase, tolerated non-evaluator candidate still errored, evaluator healthy -> NO termination", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            candidates: ["alice", "bob"],
            survivingCandidates: ["bob"], // alice errored within tolerance during implement
            evaluatorMember: "carol",
            maxErroredMembers: 1,
        })
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                // alice lingers errored (tolerated from implement) but is NOT the evaluator.
                { name: "alice", sessionId: "ses_alice", status: "errored", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" },
                { name: "carol", sessionId: "ses_carol", worktreePath: "/app/wt/carol" }, // healthy evaluator
            ],
        })

        await checkTermination(ctx, team, TERM_NOW)

        // Load-bearing Metis guard: a naive "any errored member -> fail" rule would
        // spuriously kill this healthy evaluate phase. The evaluator is fine, so no
        // termination fires and the run proceeds to winner selection.
        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
    })

    test("implement phase, all candidates errored -> arena_failed:no_survivors", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "implement",
            candidates: ["alice", "bob"],
            evaluatorMember: "carol",
            maxErroredMembers: 5, // even over-tolerant, zero survivors still fails
        })
        const runId = task.runId!
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "errored", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", status: "errored", worktreePath: "/app/wt/bob" },
                { name: "carol", sessionId: "ses_carol", worktreePath: "/app/wt/carol" }, // evaluator is NOT a candidate
            ],
        })

        await checkTermination(ctx, team, TERM_NOW)

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const record = await readRunRecord(team.directory, runId)
        expect(record?.reason).toBe("arena_failed:no_survivors")
        expect(record?.status).toBe("failed")
    })
})

// =======================================================================
// handleStatusEvent arena re-drive (3c): when the LAST candidate becomes
// errored via sustained retry, NO future idle event arrives. The re-drive
// switch case must re-fire handleArenaIdle so the barrier re-evaluates and
// the run advances to evaluate (or fails) instead of hanging to wall-clock.
// Disk-backed: handleStatusEvent resolves the member from the session index
// and loads the team from the registry (mirrors handlers-extra.test.ts), so
// this block uses setupArenaTeam/loadTeamState, not makeArenaHandlerTeam.
// =======================================================================

describe("arena handleStatusEvent re-drive", () => {
    test("last candidate erroring re-drives the barrier and dispatches the evaluator (no clock advance)", async () => {
        const root = tmpRoot("arena-hse-redrive")
        const masterSid = "ses_arena_hse_m"
        arenaTracked.push(masterSid, "ses_hse_alice", "ses_hse_bob", "ses_hse_carol")
        await setupArenaTeam(root, masterSid, [
            arenaMember("alice", "ses_hse_alice"),
            arenaMember("bob", "ses_hse_bob"),
            arenaMember("carol", "ses_hse_carol"),
        ])

        // ctx exposes BOTH session.status (drives the retry->errored escalation)
        // and a promptAsync that records dispatches. makeArenaCtx omits status,
        // which handleStatusEvent requires, so build the ctx inline here.
        const calls: DispatchCall[] = []
        const ctx = {
            storageRoot: root,
            scope: "project",
            directory: "/app",
            client: {
                session: {
                    status: async () => ({
                        data: { ses_hse_bob: { type: "retry", message: "sustained retry" } },
                    }),
                    promptAsync: async (args: any) => {
                        calls.push({ sessionId: args.path.id, text: args.body.parts[0].text })
                        return { data: {} }
                    },
                },
            },
        } as unknown as PluginContext

        // Implement-phase arena task: alice idle (survivor), carol evaluator idle,
        // bob retrying (about to error as the LAST terminal transition). startedAt
        // is now so checkTermination's wall-clock guard never fires first.
        const team = await loadTeamState(root, "alpha", masterSid)
        await team.mutex.runExclusive(async () => {
            team.activeTask = makeArenaTask({
                startedAt: Date.now(),
                candidates: ["alice", "bob"],
                evaluatorMember: "carol",
                maxErroredMembers: 1,
                evalCriteria: "fastest",
            })
            const bob = team.members.find(m => m.name === "bob")!
            bob.status = "running"
            bob.retryingSince = Date.now() - 120_000 // past the 60s escalation window
        })

        // Drive bob's terminal retry->errored transition. maxRetries defaults to 0
        // so it escalates immediately (no grace window). bob is the LAST candidate
        // to reach a terminal state, so no further idle event will arrive — only
        // the re-drive keeps the run from hanging.
        await handleStatusEvent(ctx, {
            type: "session.status",
            properties: { sessionID: "ses_hse_bob" },
        })

        const after = await loadTeamState(root, "alpha", masterSid)
        expect(after.members.find(m => m.name === "bob")?.status).toBe("errored")

        // LOAD-BEARING: without the `case "arena"` re-drive, the switch hits
        // default: break, records NO evaluator dispatch, and the run hangs to
        // wall-clock. This positive assertion — an evaluator dispatch recorded
        // WITHOUT advancing the clock (a single synchronous handleStatusEvent
        // call, no sweep/timeout) — is the deadlock-guard evidence.
        const evalCalls = calls.filter(c => c.sessionId === "ses_hse_carol")
        expect(evalCalls).toHaveLength(1)
        expect(evalCalls[0].text).toContain("<scoreboard>")

        // The barrier re-fired: the errored candidate is excluded from survivors
        // and the task advanced to the evaluate phase.
        const at = after.activeTask as ArenaTask
        expect(at.arenaPhase).toBe("evaluate")
        expect(at.survivingCandidates).toEqual(["alice"])
    })
})

// =======================================================================
// resumeArenaMode (4a): crash-recovery re-dispatch for BOTH phases via
// resumeDispatch. Implement phase re-dispatches only unfinished live
// candidates; zero real dispatch re-drives the barrier (errored candidates
// count as terminal-ready). Evaluate phase re-dispatches an evaluator with no
// response, parses an already-present one exactly once, and fails closed on an
// errored evaluator. Reuses the in-memory makeArenaHandlerTeam harness; no
// clock is advanced (every assertion holds after one synchronous resume).
// =======================================================================

describe("arena resume", () => {
    test("implement phase, all candidates have responses, none running -> zero dispatch, barrier re-driven, evaluator dispatched", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "implement",
            candidates: ["alice", "bob"],
            evaluatorMember: "carol",
            evalCriteria: "fastest",
            responses: { alice: "alice done", bob: "bob done" },
        })
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" },
                { name: "carol", sessionId: "ses_carol", worktreePath: "/app/wt/carol" },
            ],
        })

        await resumeDispatch(ctx, team, task)

        // Zero real dispatch: both candidates already have responses.
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(false)
        // dispatched === 0 re-drives the barrier -> evaluator dispatched once,
        // WITHOUT advancing the clock (single synchronous resume).
        expect(task.arenaPhase).toBe("evaluate")
        expect(task.survivingCandidates).toEqual(["alice", "bob"])
        const evalCalls = calls.filter(c => c.sessionId === "ses_carol")
        expect(evalCalls).toHaveLength(1)
        expect(evalCalls[0].text).toContain("<scoreboard>")
    })

    test("evaluate phase, evaluator missing response, not running -> evaluator re-dispatched", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            survivingCandidates: ["alice", "bob"],
            evalCriteria: "fastest",
            responses: {},
        })
        const team = makeArenaHandlerTeam({ activeTask: task, members: evaluatePhaseMembers() })

        await resumeDispatch(ctx, team, task)

        // Evaluator re-dispatched exactly once with the scoreboard prompt.
        const evalCalls = calls.filter(c => c.sessionId === "ses_carol")
        expect(evalCalls).toHaveLength(1)
        expect(evalCalls[0].text).toContain("<scoreboard>")
        // Still awaiting the evaluator; run not finished.
        expect(task.arenaPhase).toBe("evaluate")
        expect(task.winner).toBeUndefined()
        expect(team.activeTask).toBeDefined()
    })

    test("evaluate phase, evaluator missing from the team -> resumed run fails", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            evaluatorMember: "ghost",
            survivingCandidates: ["alice", "bob"],
            responses: {},
        })
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" },
            ],
        })

        await resumeDispatch(ctx, team, task)

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        expect(calls.some(call => call.sessionId === "ghost")).toBe(false)
        const record = await readRunRecord(team.directory, task.runId!)
        expect(record?.reason).toBe("arena_resume_missing_evaluator")
    })

    test("evaluate phase, bad evaluator response present -> handleArenaIdle consumes it once, deletes it, re-dispatches, evalAttempts===1", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            survivingCandidates: ["alice", "bob"],
            evalCriteria: "fastest",
            maxEvalRetries: 1,
            responses: { carol: "no scoreboard tag here, just noise" },
        })
        const team = makeArenaHandlerTeam({ activeTask: task, members: evaluatePhaseMembers() })

        await resumeDispatch(ctx, team, task)

        // Single-consume: parsed once -> bad response deleted + re-dispatched,
        // attempts incremented exactly once. A second resume would take the
        // missing-response re-dispatch branch (no response to re-consume), so
        // evalAttempts cannot double-increment on the same bad output.
        expect(task.evalAttempts).toBe(1)
        expect(task.responses.carol).toBeUndefined()
        const evalCalls = calls.filter(c => c.sessionId === "ses_carol")
        expect(evalCalls).toHaveLength(1)
        expect(evalCalls[0].text).toContain("<scoreboard>")
        expect(task.arenaPhase).toBe("evaluate")
        expect(team.activeTask).toBeDefined()
    })

    test("implement phase, one candidate errored + other already responded, none running -> no real dispatch, barrier re-driven", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "implement",
            candidates: ["alice", "bob"],
            evaluatorMember: "carol",
            evalCriteria: "fastest",
            maxErroredMembers: 1,
            responses: { bob: "bob done" },
        })
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "errored", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" },
                { name: "carol", sessionId: "ses_carol", worktreePath: "/app/wt/carol" },
            ],
        })

        await resumeDispatch(ctx, team, task)

        // alice errored -> dispatchToMember is a no-op (NOT counted); bob already
        // has a response -> skipped. Zero real dispatch -> barrier re-driven.
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(false)
        expect(task.arenaPhase).toBe("evaluate")
        expect(task.survivingCandidates).toEqual(["bob"])
        const evalCalls = calls.filter(c => c.sessionId === "ses_carol")
        expect(evalCalls).toHaveLength(1)
    })

    test("implement phase, ALL candidates errored -> zero dispatch, barrier re-driven with first candidate, run finishes arena_failed:no_survivors", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "implement",
            candidates: ["alice", "bob"],
            evaluatorMember: "carol",
            evalCriteria: "fastest",
            maxErroredMembers: 5, // even over-tolerant, zero survivors still fails
        })
        const runId = task.runId!
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", status: "errored", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", status: "errored", worktreePath: "/app/wt/bob" },
                { name: "carol", sessionId: "ses_carol", worktreePath: "/app/wt/carol" },
            ],
        })

        await resumeDispatch(ctx, team, task)

        // No candidate dispatch (all errored -> no-op); barrier re-driven with the
        // first candidate (errored counts as terminal-ready) -> no survivors ->
        // failed, NOT hung to wall-clock.
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(false)
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(false)
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        const record = await readRunRecord(team.directory, runId)
        expect(record?.reason).toBe("arena_failed:no_survivors")
        expect(record?.status).toBe("failed")
    })

    test("evaluate phase, evaluator errored -> arena_failed:evaluator_error, evaluator NOT re-dispatched", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeArenaCtx("/app", calls)
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            survivingCandidates: ["alice", "bob"],
            evalCriteria: "fastest",
            responses: {},
        })
        const runId = task.runId!
        const team = makeArenaHandlerTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice", worktreePath: "/app/wt/alice" },
                { name: "bob", sessionId: "ses_bob", worktreePath: "/app/wt/bob" },
                { name: "carol", sessionId: "ses_carol", status: "errored", worktreePath: "/app/wt/carol" },
            ],
        })

        await resumeDispatch(ctx, team, task)

        // Errored evaluator fails closed; it is NOT revived/re-dispatched.
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(false)
        const record = await readRunRecord(team.directory, runId)
        expect(record?.reason).toBe("arena_failed:evaluator_error")
        expect(record?.status).toBe("failed")
    })
})


// =======================================================================
// Arena summary (4b): buildSummary's arena case renders the winner line +
// scoreboard table. Reuses makeArenaTask / makeArenaHandlerTeam. Appended
// as a TOP-LEVEL describe (sibling of the blocks above), not nested.
// =======================================================================

describe("arena summary", () => {
    test("happy: buildSummary renders winner, direction, metric, and every scoreboard row", async () => {
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            candidates: ["alice", "bob"],
            survivingCandidates: ["alice", "bob"],
            evaluatorMember: "carol",
            scoreDirection: "max",
            winnerMetric: "score",
            winner: "alice",
            scoreboard: {
                scores: [
                    { member: "alice", score: 10, passed: true, rationale: "fastest" },
                    { member: "bob", score: 5, passed: true, rationale: "slower" },
                ],
                rationale: "alice fastest",
            },
        })
        const team = makeArenaHandlerTeam({ activeTask: task })

        const summary = await buildSummary(team, task, "arena_complete")

        // Winner line: name + scoreDirection + winnerMetric.
        expect(summary).toContain("alice")
        expect(summary).toContain("max")
        expect(summary).toContain("score")
        // A row for EVERY scoreboard member.
        expect(summary).toContain("bob")
    })

    test("failure: no winner (eval failed) states no-winner + does not throw", async () => {
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            candidates: ["alice", "bob"],
            survivingCandidates: ["alice", "bob"],
            evaluatorMember: "carol",
            scoreDirection: "max",
            winnerMetric: "score",
            winner: undefined,
            scoreboard: undefined, // eval failed: no scoreboard produced
        })
        const team = makeArenaHandlerTeam({ activeTask: task })

        const summary = await buildSummary(team, task, "arena_failed:eval_invalid")

        expect(typeof summary).toBe("string")
        expect(summary).toContain("no winner selected")
    })
})


// =======================================================================
// Arena persist (4c): persistRun writes task.arena metadata into the
// RunRecord and readRunRecord round-trips it without stripping any key
// (especially survivingCandidates). Reuses makeArenaTask /
// makeArenaHandlerTeam. Appended as a TOP-LEVEL describe (sibling of the
// blocks above), not nested.
// =======================================================================

describe("arena persist", () => {
    test("happy: persistRun writes winner + full scoreboard + survivingCandidates, round-trips intact", async () => {
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            candidates: ["alice", "bob"],
            survivingCandidates: ["alice", "bob"],
            evaluatorMember: "carol",
            scoreDirection: "max",
            winnerMetric: "score",
            winner: "alice",
            scoreboard: {
                scores: [
                    { member: "alice", score: 10, metrics: { speed: 2 }, passed: true, rationale: "fastest" },
                    { member: "bob", score: 5, passed: true, rationale: "slower" },
                ],
                rationale: "alice fastest",
            },
        })
        const runId = task.runId!
        const team = makeArenaHandlerTeam({ activeTask: task })

        await persistRun(team, "arena_complete")

        const record = await readRunRecord(team.directory, runId)

        expect(record).not.toBeNull()
        expect(record?.type).toBe("arena")
        expect(record?.arena?.winner).toBe("alice")
        expect(record?.arena?.scoreDirection).toBe("max")
        expect(record?.arena?.winnerMetric).toBe("score")
        expect(record?.arena?.survivingCandidates).toEqual(["alice", "bob"])
        // Deep-equal the WHOLE arena field: proves nothing is stripped on the
        // persist->schema-parse round-trip (evaluator maps from evaluatorMember).
        expect(record?.arena).toEqual({
            candidates: ["alice", "bob"],
            survivingCandidates: ["alice", "bob"],
            evaluator: "carol",
            winner: "alice",
            scoreDirection: "max",
            winnerMetric: "score",
            scoreboard: {
                scores: [
                    { member: "alice", score: 10, metrics: { speed: 2 }, passed: true, rationale: "fastest" },
                    { member: "bob", score: 5, passed: true, rationale: "slower" },
                ],
                rationale: "alice fastest",
            },
        })
    })

    test("failure: a failed run with no winner persists arena with candidates present and winner undefined", async () => {
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            candidates: ["alice", "bob"],
            evaluatorMember: "carol",
            scoreDirection: "max",
            winnerMetric: "score",
            winner: undefined,
            scoreboard: undefined,
        })
        const runId = task.runId!
        const team = makeArenaHandlerTeam({ activeTask: task })

        await persistRun(team, "arena_failed:eval_invalid")

        const record = await readRunRecord(team.directory, runId)

        // schema-optional winner/scoreboard: the record still validates.
        expect(record).not.toBeNull()
        expect(record?.type).toBe("arena")
        expect(record?.arena?.winner).toBeUndefined()
        expect(record?.arena?.scoreboard).toBeUndefined()
        expect(record?.arena?.candidates).toEqual(["alice", "bob"])
    })
})


// =======================================================================
// Arena team_resume (4d): team_resume blanket-resets EVERY errored member to
// idle before dispatch. For arena that DESTROYS terminal-error semantics — a
// tolerated errored candidate would be revived + re-dispatched (reviving a
// competitor changes the field) and an errored evaluator would be re-dispatched
// instead of failing. 4d carves out arena: SKIP the errored->idle reset for any
// member in task.candidates (all phases) and for task.evaluatorMember (all
// phases). Non-arena tasks keep the blanket reset unchanged. These tests drive
// the REAL teamResumeTool against a disk-backed team so they exercise the
// Phase-1 reset carve-out (the 4a "arena resume" block above calls resumeDispatch
// directly and never touches the reset loop). Appended as a TOP-LEVEL describe
// (sibling of the blocks above), not nested.
// =======================================================================

/** Set up a disk-backed team in the failed+interrupted state team_resume needs:
 *  members on disk, status="failed", lastInterruptedTask=task, and the named
 *  members marked terminally errored (simulating a crash mid-work). */
async function setupFailedInterrupted(
    root: string,
    masterSid: string,
    members: MemberState[],
    task: ActiveTask,
    erroredNames: string[],
): Promise<Team> {
    await setupArenaTeam(root, masterSid, members)
    const team = await loadTeamState(root, "alpha", masterSid)
    await team.mutex.runExclusive(async () => {
        team.status = "failed"
        team.lastInterruptedTask = task
        for (const name of erroredNames) {
            const m = team.members.find(x => x.name === name)
            if (m) {
                m.status = "errored"
                m.error = "interrupted mid-work"
            }
        }
        await saveTeamState(team)
    })
    return team
}

describe("arena team_resume", () => {
    test("happy: implement-phase tolerated errored candidate STAYS errored across resume; barrier re-drives to evaluate", async () => {
        const root = tmpRoot("arena-resume-impl-candidate")
        const sid = "ses_arena_resume_impl_m"
        arenaTracked.push(sid)
        const task = makeArenaTask({
            arenaPhase: "implement",
            candidates: ["alice", "bob"],
            evaluatorMember: "carol",
            evalCriteria: "fastest",
            maxErroredMembers: 1,
            responses: { bob: "bob done" },
        })
        const team = await setupFailedInterrupted(
            root,
            sid,
            [
                arenaMember("alice", "ses_alice"),
                arenaMember("bob", "ses_bob"),
                arenaMember("carol", "ses_carol"),
            ],
            task,
            ["alice"], // alice errored during implement, within tolerance
        )
        const calls: DispatchCall[] = []
        const res = await teamResumeTool(makeArenaCtx(root, calls)).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(res).toContain("Resumed arena")

        const after = await loadTeamState(root, "alpha", sid)
        // 4d CORE: the tolerated errored candidate is NOT revived by the reset
        // loop — it stays terminally errored so failure isolation holds.
        expect(after.members.find(m => m.name === "alice")?.status).toBe("errored")
        // It was NOT re-dispatched (a revived competitor would change the field).
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)
        // resumeArenaMode re-drove the barrier: alice excluded from survivors,
        // the run advanced to evaluate, evaluator dispatched exactly once.
        const at = after.activeTask as ArenaTask
        expect(at.arenaPhase).toBe("evaluate")
        expect(at.survivingCandidates).toEqual(["bob"])
        const evalCalls = calls.filter(c => c.sessionId === "ses_carol")
        expect(evalCalls).toHaveLength(1)
        expect(evalCalls[0].text).toContain("<scoreboard>")
        // team.directory only referenced to keep the disk root alive for cleanup.
        expect(team.directory).toContain("arena-resume-impl-candidate")
    })

    test("failure: evaluate-phase errored evaluator STAYS errored; run finishes arena_failed:evaluator_error (not revived, not hung)", async () => {
        const root = tmpRoot("arena-resume-eval-evaluator")
        const sid = "ses_arena_resume_eval_m"
        arenaTracked.push(sid)
        const task = makeArenaTask({
            arenaPhase: "evaluate",
            candidates: ["alice", "bob"],
            survivingCandidates: ["alice", "bob"],
            evaluatorMember: "carol",
            evalCriteria: "fastest",
            responses: {},
        })
        const runId = task.runId!
        const team = await setupFailedInterrupted(
            root,
            sid,
            [
                arenaMember("alice", "ses_alice"),
                arenaMember("bob", "ses_bob"),
                arenaMember("carol", "ses_carol"),
            ],
            task,
            ["carol"], // evaluator errored mid-evaluate
        )
        const calls: DispatchCall[] = []
        await teamResumeTool(makeArenaCtx(root, calls)).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        const after = await loadTeamState(root, "alpha", sid)
        // 4d CORE: the evaluator is NOT revived — it stays errored.
        expect(after.members.find(m => m.name === "carol")?.status).toBe("errored")
        // Not re-dispatched; the run fails closed instead of hanging.
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(false)
        expect(after.status).toBe("failed")
        expect(after.activeTask).toBeUndefined()
        const record = await readRunRecord(team.directory, runId)
        expect(record?.reason).toBe("arena_failed:evaluator_error")
        expect(record?.status).toBe("failed")
    })

    test("Oracle round-2: implement-phase errored evaluator STAYS errored; live-check fails at implement->evaluate -> arena_failed:evaluator_unavailable", async () => {
        const root = tmpRoot("arena-resume-impl-evaluator")
        const sid = "ses_arena_resume_impl_eval_m"
        arenaTracked.push(sid)
        const task = makeArenaTask({
            arenaPhase: "implement",
            candidates: ["alice", "bob"],
            evaluatorMember: "carol",
            evalCriteria: "fastest",
            responses: { alice: "alice done", bob: "bob done" },
        })
        const runId = task.runId!
        const team = await setupFailedInterrupted(
            root,
            sid,
            [
                arenaMember("alice", "ses_alice"),
                arenaMember("bob", "ses_bob"),
                arenaMember("carol", "ses_carol"),
            ],
            task,
            ["carol"], // evaluator errored during implement
        )
        const calls: DispatchCall[] = []
        await teamResumeTool(makeArenaCtx(root, calls)).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        const after = await loadTeamState(root, "alpha", sid)
        // 4d CORE (evaluator carve-out covers implement too): NOT revived.
        expect(after.members.find(m => m.name === "carol")?.status).toBe("errored")
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(false)
        // Both candidates already responded -> barrier fires on re-drive ->
        // startArenaEvaluation live-check sees the errored evaluator -> fail closed.
        expect(after.status).toBe("failed")
        expect(after.activeTask).toBeUndefined()
        const record = await readRunRecord(team.directory, runId)
        expect(record?.reason).toBe("arena_failed:evaluator_unavailable")
        expect(record?.status).toBe("failed")
    })

    test("regression: non-arena (parallel) interrupted task STILL resets an errored member to idle (blanket reset unchanged)", async () => {
        const root = tmpRoot("arena-resume-nonarena-regression")
        const sid = "ses_arena_resume_regression_m"
        arenaTracked.push(sid)
        const task: ActiveTask = {
            type: "parallel",
            mode: "isolated",
            startedAt: 0,
            wallClockTimeoutMs: 600000,
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            responses: { bob: "bob done" },
            stages: [],
            currentStageIndex: 0,
            decisionHistory: [],
            decisionParseFailures: 0,
            runId: crypto.randomUUID(),
            task: "do the thing",
        } as ActiveTask
        await setupFailedInterrupted(
            root,
            sid,
            [
                arenaMember("alice", "ses_alice"),
                arenaMember("bob", "ses_bob"),
            ],
            task,
            ["bob"], // bob errored; parallel has NO candidate/evaluator carve-out
        )
        const calls: DispatchCall[] = []
        await teamResumeTool(makeArenaCtx(root, calls)).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )

        const after = await loadTeamState(root, "alpha", sid)
        // The blanket reset is UNCHANGED for non-arena: bob was revived from
        // errored -> idle. bob has a response so it is not re-dispatched, and
        // alice's re-dispatch (dispatched===1) means no barrier re-drive, so bob
        // is left cleanly idle — the exact pre-4d behavior.
        expect(after.members.find(m => m.name === "bob")?.status).toBe("idle")
        expect(calls.some(c => c.sessionId === "ses_bob")).toBe(false)
        // alice (no response) IS re-dispatched, proving the resume proceeded.
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(true)
    })
})


// =======================================================================
// Arena result rendering (4e): team_result_get renders the winner +
// scoreboard audit trail, and team_results appends winner=<name> to the
// run-line. The winner is read VERBATIM from record.arena.winner (never
// re-derived from the scoreboard) so a higher-scoring non-survivor is
// audited [ineligible], not crowned. Disk-backed team + indexed session.
// =======================================================================

describe("arena team_result_get", () => {
    test("happy: renders winner, evaluator, direction/metric, surviving set, and a scoreboard row per candidate; run-line shows winner=<name>", async () => {
        const root = tmpRoot("arena-result-get-happy")
        const sid = "ses_arena_result_get_happy_m"
        arenaTracked.push(sid)
        await setupArenaTeam(root, sid, [
            arenaMember("alice", "ses_alice"),
            arenaMember("bob", "ses_bob"),
            arenaMember("carol", "ses_carol"),
        ])
        const tdir = teamDir(root, "alpha", sid)
        const record = arenaRecord() // winner bob; surviving [alice, bob]; scoreboard [alice, bob]
        writeArenaRecord(tdir, record.runId, JSON.stringify(record))

        const text = await teamResultGetTool(makeArenaCtx(root, [])).execute(
            { team_id: "alpha", run_id: record.runId },
            makeToolContext(sid),
        )

        // Winner is taken verbatim from record.arena.winner.
        expect(text).toContain("Winner: bob")
        expect(text).toContain("(max score)")
        expect(text).toContain("Evaluator: eve")
        expect(text).toContain("Surviving: alice, bob")
        // One scoreboard row per candidate: member, metric value, passed, rationale.
        expect(text).toContain("- alice: score=3 passed=true")
        expect(text).toContain("ok")
        expect(text).toContain("- bob: score=5 passed=true")
        expect(text).toContain("fastest")

        // Run-line (team_results list) shows winner=<name>.
        const listText = await teamResultsTool(makeArenaCtx(root, [])).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(listText).toContain("winner=bob")
    })

    test("ineligible-tag: a scored non-survivor is tagged [ineligible]; the rendered winner is the persisted one, NOT the higher-scoring non-survivor", async () => {
        const root = tmpRoot("arena-result-get-ineligible")
        const sid = "ses_arena_result_get_ineligible_m"
        arenaTracked.push(sid)
        await setupArenaTeam(root, sid, [
            arenaMember("alice", "ses_alice"),
            arenaMember("bob", "ses_bob"),
            arenaMember("carol", "ses_carol"),
        ])
        const tdir = teamDir(root, "alpha", sid)
        // carol errored during implement (not in survivingCandidates) but was
        // still scored — and scores HIGHEST (99). The persisted winner is bob
        // (a surviving member). A renderer that re-derives from the scoreboard
        // would wrongly crown carol; this asserts it reads the persisted winner.
        const record: RunRecord = {
            version: 1,
            runId: "run-arena-ineligible",
            teamRunId: "team-run-1",
            teamName: "alpha",
            type: "arena",
            reason: "arena_complete",
            status: "completed",
            startedAt: 1000,
            finishedAt: 5000,
            tokensUsed: 100,
            tokensByMember: {},
            messagesSent: 5,
            memberOutputs: {},
            arena: {
                candidates: ["alice", "bob", "carol"],
                survivingCandidates: ["alice", "bob"],
                evaluator: "eve",
                winner: "bob",
                scoreDirection: "max",
                winnerMetric: "score",
                scoreboard: {
                    scores: [
                        { member: "alice", score: 3, passed: true },
                        { member: "bob", score: 5, passed: true },
                        { member: "carol", score: 99, passed: true },
                    ],
                },
            },
        }
        writeArenaRecord(tdir, record.runId, JSON.stringify(record))

        const text = await teamResultGetTool(makeArenaCtx(root, [])).execute(
            { team_id: "alpha", run_id: record.runId },
            makeToolContext(sid),
        )

        // Rendered winner is the persisted bob, NOT the higher-scoring carol.
        expect(text).toContain("Winner: bob")
        expect(text).not.toContain("Winner: carol")
        // The high-scoring non-survivor row is tagged [ineligible].
        const carolRow = text.split("\n").find(l => l.startsWith("- carol:"))
        expect(carolRow).toBeDefined()
        expect(carolRow!).toContain("[ineligible]")
        // A surviving member's row is NOT tagged ineligible.
        const bobRow = text.split("\n").find(l => l.startsWith("- bob:"))
        expect(bobRow).toBeDefined()
        expect(bobRow!).not.toContain("[ineligible]")
    })

    test("failure: an arena record with no winner renders winner (none) + the reason and does not throw", async () => {
        const root = tmpRoot("arena-result-get-nowinner")
        const sid = "ses_arena_result_get_nowinner_m"
        arenaTracked.push(sid)
        await setupArenaTeam(root, sid, [
            arenaMember("alice", "ses_alice"),
            arenaMember("bob", "ses_bob"),
            arenaMember("carol", "ses_carol"),
        ])
        const tdir = teamDir(root, "alpha", sid)
        const record: RunRecord = {
            version: 1,
            runId: "run-arena-nowinner",
            teamRunId: "team-run-1",
            teamName: "alpha",
            type: "arena",
            reason: "arena_failed:eval_invalid",
            status: "failed",
            startedAt: 1000,
            finishedAt: 5000,
            tokensUsed: 100,
            tokensByMember: {},
            messagesSent: 5,
            memberOutputs: {},
            arena: {
                candidates: ["alice", "bob"],
                survivingCandidates: ["alice", "bob"],
                evaluator: "eve",
                scoreDirection: "max",
                winnerMetric: "score",
            },
        }
        writeArenaRecord(tdir, record.runId, JSON.stringify(record))

        const text = await teamResultGetTool(makeArenaCtx(root, [])).execute(
            { team_id: "alpha", run_id: record.runId },
            makeToolContext(sid),
        )

        // No winner: renders (none) + the failure reason, without throwing.
        expect(text).toContain("Winner: (none)")
        expect(text).toContain("arena_failed:eval_invalid")
    })
})

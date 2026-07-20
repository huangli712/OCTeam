/**
 * team_quorum tests — Group A-G test matrix from the implementation plan.
 *
 * Group A: barrier + tally (handleQuorumIdle unit tests)
 * Group B: parseBallot edge cases
 * Group C: end-to-end with error path (defends B1 + B3)
 * Group D: integration (compiler-enforced dispatch points)
 * Group E: persistence (defends B2)
 * Group F: misc (F2 ballot isolation, F5 wait-all/no-early-exit)
 * Group G: resume (defends v4 fix D)
 */
import { describe, expect, test } from "bun:test"

import { handleQuorumIdle } from "../src/orchestration/modes/quorum.js"
import { RunRecordSchema } from "../src/orchestration/records/schemas.js"
import { runRecordPath } from "../src/state/paths.js"
import type { QuorumTask } from "../src/core/types.js"
import { makeCtx, makeTeam, type DispatchCall } from "./helpers.js"
import { readFile } from "node:fs/promises"

// --- fixtures ---

function makeQuorumTask(opts: Partial<QuorumTask> = {}): QuorumTask {
    return {
        type: "quorum",
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
        runId: crypto.randomUUID(),
        task: "Should we ship?",
        voteKey: "decision",
        voteOptions: undefined,
        participants: ["alice", "bob", "carol"],
        ballots: {},
        erroredCount: 0,
        ...opts,
    } as QuorumTask
}

function vote(value: string, rationale?: string): string {
    const r = rationale ? `, "rationale": "${rationale}"` : ""
    return `<vote>{"decision": "${value}"${r}}</vote>`
}

// ============================================================
// Group A: barrier + tally
// ============================================================

describe("handleQuorumIdle: barrier + tally", () => {
    test("A1: basic pass — strict majority (N=3, [A,A,B])", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["alice", "bob", "carol"],
            responses: {
                alice: vote("ship"),
                bob: vote("ship"),
                carol: vote("hold"),
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_a", status: "idle" },
                { name: "bob", sessionId: "ses_b", status: "idle" },
                { name: "carol", sessionId: "ses_c", status: "idle" },
            ],
        })

        await handleQuorumIdle(ctx, team)

        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("quorum_succeeded:ship")
    })

    test("A2: basic fail — no majority (N=5, [A,A,B,B,C])", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["a", "b", "c", "d", "e"],
            responses: {
                a: vote("A"), b: vote("A"),
                c: vote("B"), d: vote("B"),
                e: vote("C"),
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: ["a", "b", "c", "d", "e"].map(n => ({
                name: n, sessionId: `ses_${n}`, status: "idle" as const,
            })),
        })

        await handleQuorumIdle(ctx, team)

        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall).toBeDefined()
        expect(leaderCall!.text).toContain("quorum_no_majority")
    })

    test("A3: tie impossible — [A,A,B,B] fails (k=3 > 2)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["a", "b", "c", "d"],
            responses: { a: vote("A"), b: vote("A"), c: vote("B"), d: vote("B") },
        })
        const team = makeTeam({
            activeTask: task,
            members: ["a", "b", "c", "d"].map(n => ({
                name: n, sessionId: `ses_${n}`, status: "idle" as const,
            })),
        })

        await handleQuorumIdle(ctx, team)

        expect(team.activeTask).toBeUndefined()
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")
        expect(leaderCall!.text).toContain("quorum_no_majority")
    })

    test("A4: unanimous (N=3, all A)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["a", "b", "c"],
            responses: { a: vote("A"), b: vote("A"), c: vote("A") },
        })
        const team = makeTeam({
            activeTask: task,
            members: ["a", "b", "c"].map(n => ({
                name: n, sessionId: `ses_${n}`, status: "idle" as const,
            })),
        })

        await handleQuorumIdle(ctx, team)
        expect(calls.find(c => c.sessionId === "ses_lead")!.text).toContain("quorum_succeeded:A")
    })

    test("A5: single valid ballot wins when others errored (N=3, 2 errored, [A])", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["a", "b", "c"],
            responses: { a: vote("A") },  // b and c errored, no response
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "a", sessionId: "ses_a", status: "idle" },
                { name: "b", sessionId: "ses_b", status: "errored" },
                { name: "c", sessionId: "ses_c", status: "errored" },
            ],
        })

        await handleQuorumIdle(ctx, team)
        // nEff=1, threshold=1, A=1 >= 1 → SUCCEEDED
        expect(calls.find(c => c.sessionId === "ses_lead")!.text).toContain("quorum_succeeded:A")
    })
})

// ============================================================
// Group B: parseBallot edge cases (indirectly via handleQuorumIdle)
// ============================================================

describe("parseBallot edge cases", () => {
    test("B2: missing <vote> tag → invalid", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["a", "b", "c"],
            responses: {
                a: "I think ship is fine",  // no tag
                b: vote("ship"),
                c: vote("ship"),
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: ["a", "b", "c"].map(n => ({
                name: n, sessionId: `ses_${n}`, status: "idle" as const,
            })),
        })

        await handleQuorumIdle(ctx, team)
        // a abstains, nEff=2, threshold=2, ship=2 → SUCCEEDED
        expect(calls.find(c => c.sessionId === "ses_lead")!.text).toContain("quorum_succeeded:ship")
        expect(task.erroredCount).toBe(1)
    })

    test("B3: malformed JSON inside <vote> → invalid", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["a", "b", "c"],
            responses: {
                a: "<vote>{not json}</vote>",
                b: vote("ship"),
                c: vote("ship"),
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: ["a", "b", "c"].map(n => ({
                name: n, sessionId: `ses_${n}`, status: "idle" as const,
            })),
        })

        await handleQuorumIdle(ctx, team)
        expect(task.erroredCount).toBe(1)
        expect(calls.find(c => c.sessionId === "ses_lead")!.text).toContain("quorum_succeeded:ship")
    })

    test("B5: non-whitelist value → invalid", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["a", "b", "c"],
            voteOptions: ["A", "B"],
            responses: {
                a: vote("C"),  // not in whitelist
                b: vote("A"),
                c: vote("A"),
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: ["a", "b", "c"].map(n => ({
                name: n, sessionId: `ses_${n}`, status: "idle" as const,
            })),
        })

        await handleQuorumIdle(ctx, team)
        expect(task.erroredCount).toBe(1)
        expect(calls.find(c => c.sessionId === "ses_lead")!.text).toContain("quorum_succeeded:A")
    })

    test("B7: CJK tag <投票> parses correctly", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["a", "b", "c"],
            responses: {
                a: `<投票>{"decision": "通过"}</投票>`,
                b: `<投票>{"decision": "通过"}</投票>`,
                c: `<投票>{"decision": "驳回"}</投票>`,
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: ["a", "b", "c"].map(n => ({
                name: n, sessionId: `ses_${n}`, status: "idle" as const,
            })),
        })

        await handleQuorumIdle(ctx, team)
        expect(calls.find(c => c.sessionId === "ses_lead")!.text).toContain("quorum_succeeded:通过")
    })
})

// ============================================================
// Group C: end-to-end with error path (defends B1 + B3)
// ============================================================

describe("error-path defenses (B1 tolerance + B3 re-drive)", () => {
    test("C1: invalid ballot abstains within default tolerance", async () => {
        // N=5, 1 member outputs non-tag, others [A,A,A,B] → nEff=4, k=3, A wins
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["a", "b", "c", "d", "e"],
            responses: {
                a: "no tag here",
                b: vote("A"), c: vote("A"), d: vote("A"), e: vote("B"),
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: ["a", "b", "c", "d", "e"].map(n => ({
                name: n, sessionId: `ses_${n}`, status: "idle" as const,
            })),
        })

        await handleQuorumIdle(ctx, team)
        expect(task.erroredCount).toBe(1)
        expect(task.nEff).toBe(4)
        expect(task.threshold).toBe(3)
        expect(calls.find(c => c.sessionId === "ses_lead")!.text).toContain("quorum_succeeded:A")
    })

    test("C6: loose tolerance — 4 of 5 errored, single ballot wins", async () => {
        // max_errored=4 (explicit), 4 errored, 1 votes A → nEff=1, threshold=1, A wins
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["a", "b", "c", "d", "e"],
            maxErroredMembers: 4,
            responses: { a: vote("A") },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "a", sessionId: "ses_a", status: "idle" },
                ...["b", "c", "d", "e"].map(n => ({
                    name: n, sessionId: `ses_${n}`, status: "errored" as const,
                })),
            ],
        })

        await handleQuorumIdle(ctx, team)
        expect(task.nEff).toBe(1)
        expect(task.threshold).toBe(1)
        expect(calls.find(c => c.sessionId === "ses_lead")!.text).toContain("quorum_succeeded:A")
    })

    test("A5 variant: default tolerance N-1 allows all-but-one errored", async () => {
        // Default maxErroredMembers = participants.length - 1 = 2 (N=3)
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["a", "b", "c"],
            // No explicit maxErroredMembers; defaults to 2 via buildTask
            responses: { a: vote("A") },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "a", sessionId: "ses_a", status: "idle" },
                { name: "b", sessionId: "ses_b", status: "errored" },
                { name: "c", sessionId: "ses_c", status: "errored" },
            ],
        })

        await handleQuorumIdle(ctx, team)
        expect(calls.find(c => c.sessionId === "ses_lead")!.text).toContain("quorum_succeeded:A")
    })
})

// ============================================================
// Group E: persistence (defends B2)
// ============================================================

describe("persistence", () => {
    test("E1: record.json contains quorum block after tally", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["alice", "bob", "carol"],
            responses: {
                alice: vote("ship"),
                bob: vote("ship"),
                carol: vote("hold"),
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_a", status: "idle" },
                { name: "bob", sessionId: "ses_b", status: "idle" },
                { name: "carol", sessionId: "ses_c", status: "idle" },
            ],
        })

        await handleQuorumIdle(ctx, team)

        // persistRun is called inside finishRun; read the record back
        const recordRaw = await readFile(runRecordPath(team.directory, task.runId!), "utf8")
        const parsed = RunRecordSchema.safeParse(JSON.parse(recordRaw))
        expect(parsed.success).toBe(true)
        if (!parsed.success) return
        const record = parsed.data

        expect(record.type).toBe("quorum")
        expect(record.quorum).toBeDefined()
        expect(record.quorum!.winningOption).toBe("ship")
        expect(record.quorum!.threshold).toBe(2)
        expect(record.quorum!.nEff).toBe(3)
        expect(record.quorum!.ballots?.alice.vote).toBe("ship")
        expect(record.quorum!.ballots?.alice.status).toBe("valid")
    })

    test("E3: RunRecordSchema round-trips a quorum record", () => {
        const record = {
            version: 1 as const,
            runId: "test-rid",
            teamRunId: "test-trid",
            teamName: "test-team",
            type: "quorum" as const,
            reason: "quorum_succeeded:ship",
            status: "completed" as const,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            tokensUsed: 100,
            tokensByMember: { alice: 50, bob: 50 },
            messagesSent: 2,
            memberOutputs: {},
            quorum: {
                task: "ship?",
                voteKey: "decision",
                participants: ["alice", "bob"],
                winningOption: "ship",
                nEff: 2,
                threshold: 2,
                erroredCount: 0,
                ballots: {
                    alice: { vote: "ship", status: "valid" as const },
                    bob: { vote: "ship", status: "valid" as const },
                },
            },
        }
        const parsed = RunRecordSchema.safeParse(record)
        expect(parsed.success).toBe(true)
        if (parsed.success) {
            expect(parsed.data.quorum?.winningOption).toBe("ship")
            expect(parsed.data.quorum?.ballots?.alice.vote).toBe("ship")
        }
    })

    test("D4/E2: OrchestrationTypeSchema accepts 'quorum' (no silent drop)", () => {
        const record = {
            version: 1 as const,
            runId: "x", teamRunId: "x", teamName: "x",
            type: "quorum" as const,
            reason: "quorum_succeeded:X",
            status: "completed" as const,
            startedAt: 0, finishedAt: 0,
            tokensUsed: 0, tokensByMember: {}, messagesSent: 0,
            memberOutputs: {},
        }
        const parsed = RunRecordSchema.safeParse(record)
        expect(parsed.success).toBe(true)
    })
})

// ============================================================
// Group F: misc
// ============================================================

describe("misc", () => {
    test("F2: non-participant response is not tallied", async () => {
        // dave is a member but NOT a participant; his response must not appear in ballots
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["alice", "bob", "carol"],
            responses: {
                alice: vote("ship"),
                bob: vote("ship"),
                carol: vote("hold"),
                dave: vote("ship"),  // dave is not a participant
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_a", status: "idle" },
                { name: "bob", sessionId: "ses_b", status: "idle" },
                { name: "carol", sessionId: "ses_c", status: "idle" },
                { name: "dave", sessionId: "ses_d", status: "idle" },
            ],
        })

        await handleQuorumIdle(ctx, team)

        expect(task.ballots).toBeDefined()
        expect(task.ballots!.dave).toBeUndefined()  // dave not in participants
        expect(Object.keys(task.ballots!)).toEqual(["alice", "bob", "carol"])
    })

    test("F3: reason string carries winning option", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["a", "b", "c"],
            responses: { a: vote("X"), b: vote("X"), c: vote("Y") },
        })
        const team = makeTeam({
            activeTask: task,
            members: ["a", "b", "c"].map(n => ({
                name: n, sessionId: `ses_${n}`, status: "idle" as const,
            })),
        })

        await handleQuorumIdle(ctx, team)
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")!
        expect(leaderCall.text).toContain("quorum_succeeded:X")
    })

    test("F4: members subset enforced via task.participants", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["alice", "bob"],  // subset
            responses: { alice: vote("A"), bob: vote("A") },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_a", status: "idle" },
                { name: "bob", sessionId: "ses_b", status: "idle" },
                { name: "carol", sessionId: "ses_c", status: "idle" },  // not a participant
            ],
        })

        await handleQuorumIdle(ctx, team)
        // Only alice and bob tallied; carol excluded
        expect(Object.keys(task.ballots!)).toEqual(["alice", "bob"])
        expect(task.nEff).toBe(2)
        expect(task.threshold).toBe(2)
    })

    test("F5: explicit wait-all — barrier waits for all participants", async () => {
        // 3 of 5 idle (already passing threshold) but 2 still running.
        // Barrier must NOT fire early.
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeQuorumTask({
            participants: ["a", "b", "c", "d", "e"],
            responses: { a: vote("A"), b: vote("A"), c: vote("A") },  // d, e still running
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "a", sessionId: "ses_a", status: "idle" },
                { name: "b", sessionId: "ses_b", status: "idle" },
                { name: "c", sessionId: "ses_c", status: "idle" },
                { name: "d", sessionId: "ses_d", status: "running" },  // not terminal
                { name: "e", sessionId: "ses_e", status: "running" },  // not terminal
            ],
        })

        await handleQuorumIdle(ctx, team)

        // Run must NOT have finished — barrier waits for d and e.
        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
        expect(calls.some(c => c.sessionId === "ses_lead")).toBe(false)
    })
})

// ============================================================
// Group G: resume (defends v4 fix D — quorum-specific predicate)
// ============================================================

describe("resume predicates (v4 fix D defense)", () => {
    test("G1 (indirect): resumeQuorumMode filters errored participants from dispatch count", async () => {
        // Scenario from Momus v3 concern D1: N=3, A/B idle+response, C errored+no-response.
        // Without the errored guard, dispatch would count C as a no-op dispatch,
        // suppressing the zero-dispatch barrier re-drive and hanging the run.
        //
        // We verify the predicate logic directly: errored participant must not pass.
        // (Full resume integration test would require handleStatusEvent mocking; see plan §7 step 8.)
        const task = makeQuorumTask({
            participants: ["alice", "bob", "carol"],
            responses: { alice: vote("A"), bob: vote("A") },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_a", status: "idle" },
                { name: "bob", sessionId: "ses_b", status: "idle" },
                { name: "carol", sessionId: "ses_c", status: "errored" },
            ],
        })

        // Simulate the resumeQuorumMode predicate (mirror of resume.ts:resumeQuorumMode)
        const participantSet = new Set(task.participants)
        const memberShouldDispatch = (m: { name: string; status: string; sessionId?: string }) =>
            participantSet.has(m.name)
            && m.status !== "errored"
            && !!m.sessionId
            && !task.responses[m.name]

        // alice and bob have responses → false
        // carol is errored → false (the v4 fix D1 guard)
        for (const m of team.members) {
            expect(memberShouldDispatch(m)).toBe(false)
        }

        // Zero dispatches → barrier would re-drive (assert via direct handleQuorumIdle call)
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        await handleQuorumIdle(ctx, team)
        expect(calls.find(c => c.sessionId === "ses_lead")!.text).toContain("quorum_succeeded:A")
    })
})

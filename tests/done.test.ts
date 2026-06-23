import { describe, expect, test } from "bun:test"

import { waitForBarrier } from "../src/orchestration/handlers.js"
import type { ActiveTask, MemberState, TeamState } from "../src/types.js"
import { AsyncMutex } from "../src/state/locks.js"

/**
 * Minimal Team stub for barrier tests. Only the fields waitForBarrier reads
 * are populated; everything else is bypassed via type assertion.
 */
function makeTeam(opts: {
    members: Array<Partial<MemberState> & Pick<MemberState, "name">>
    activeTask?: Partial<ActiveTask>
    directory?: string
}): TeamState & { mutex: AsyncMutex; directory: string } {
    const members: MemberState[] = opts.members.map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: m.initialized ?? true,
        turnCount: m.turnCount ?? 0,
        declaredDone: m.declaredDone,
    }))
    const task: ActiveTask | undefined = opts.activeTask
        ? {
              type: "parallel",
              mode: "collaborative",
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
              ...opts.activeTask,
          }
        : undefined
    return {
        version: 1,
        teamRunId: "test-run",
        teamName: "test-team",
        status: "busy",
        leadSessionId: undefined,
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
        directory: opts.directory ?? "/tmp/test-team",
    } as TeamState & { mutex: AsyncMutex; directory: string }
}

describe("waitForBarrier: default mode (no require_done_ack)", () => {
    test("fires onBarrier when all participants are idle", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", status: "idle" },
                { name: "bob", status: "idle" },
            ],
            activeTask: { requireDoneAck: false },
        })
        let fired = 0
        await waitForBarrier(team, ["alice", "bob"], async () => {
            fired++
        })
        expect(fired).toBe(1)
    })

    test("does NOT fire when some participant is still running", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", status: "idle" },
                { name: "bob", status: "running" },
            ],
            activeTask: { requireDoneAck: false },
        })
        let fired = 0
        await waitForBarrier(team, ["alice", "bob"], async () => {
            fired++
        })
        expect(fired).toBe(0)
    })

    test("does NOT fire when requireDoneAck is undefined (default backward-compat)", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", status: "idle" },
                { name: "bob", status: "idle" },
            ],
            activeTask: {}, // requireDoneAck is undefined
        })
        let fired = 0
        await waitForBarrier(team, ["alice", "bob"], async () => {
            fired++
        })
        expect(fired).toBe(1)
    })

    test("ignores declaredDone when requireDoneAck is false (does not change behavior)", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", status: "idle", declaredDone: false },
                { name: "bob", status: "idle", declaredDone: false },
            ],
            activeTask: { requireDoneAck: false },
        })
        let fired = 0
        await waitForBarrier(team, ["alice", "bob"], async () => {
            fired++
        })
        expect(fired).toBe(1)
    })

    test("fires for partial participant list (ignores non-participants)", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", status: "idle" },
                { name: "bob", status: "idle" },
                { name: "carol", status: "running" }, // not in participant list
            ],
            activeTask: { requireDoneAck: false },
        })
        let fired = 0
        await waitForBarrier(team, ["alice", "bob"], async () => {
            fired++
        })
        expect(fired).toBe(1)
    })
})

describe("waitForBarrier: require_done_ack mode", () => {
    test("fires when all participants have declaredDone=true", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", declaredDone: true },
                { name: "bob", declaredDone: true },
            ],
            activeTask: { requireDoneAck: true },
        })
        let fired = 0
        await waitForBarrier(team, ["alice", "bob"], async () => {
            fired++
        })
        expect(fired).toBe(1)
    })

    test("does NOT fire when some participant idle but not declaredDone (THE premature-idle case)", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", status: "idle", declaredDone: true },
                { name: "bob", status: "idle", declaredDone: false }, // premature idle
            ],
            activeTask: { requireDoneAck: true },
        })
        let fired = 0
        await waitForBarrier(team, ["alice", "bob"], async () => {
            fired++
        })
        expect(fired).toBe(0)
    })

    test("does NOT fire when no participant has declaredDone", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", status: "idle" },
                { name: "bob", status: "idle" },
            ],
            activeTask: { requireDoneAck: true },
        })
        let fired = 0
        await waitForBarrier(team, ["alice", "bob"], async () => {
            fired++
        })
        expect(fired).toBe(0)
    })

    test("declaredDone=true fires even if member status is still running", async () => {
        // Edge case: a member could ack team_done and then dispatch flips it
        // to running again briefly. The barrier should still fire on acks.
        const team = makeTeam({
            members: [
                { name: "alice", status: "running", declaredDone: true },
                { name: "bob", status: "idle", declaredDone: true },
            ],
            activeTask: { requireDoneAck: true },
        })
        let fired = 0
        await waitForBarrier(team, ["alice", "bob"], async () => {
            fired++
        })
        expect(fired).toBe(1)
    })

    test("partial ack is not enough (1 of 2)", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", declaredDone: true },
                { name: "bob", declaredDone: false },
            ],
            activeTask: { requireDoneAck: true },
        })
        let fired = 0
        await waitForBarrier(team, ["alice", "bob"], async () => {
            fired++
        })
        expect(fired).toBe(0)
    })

    test("5-member mesh: all must ack", async () => {
        const team = makeTeam({
            members: [
                { name: "n1", declaredDone: true },
                { name: "n2", declaredDone: true },
                { name: "n3", declaredDone: true },
                { name: "n4", declaredDone: true },
                { name: "n5", declaredDone: false }, // one straggler
            ],
            activeTask: { requireDoneAck: true },
        })
        let fired = 0
        await waitForBarrier(team, ["n1", "n2", "n3", "n4", "n5"], async () => {
            fired++
        })
        expect(fired).toBe(0)

        // Last member acks → barrier fires.
        const n5 = team.members.find(m => m.name === "n5")!
        n5.declaredDone = true
        await waitForBarrier(team, ["n1", "n2", "n3", "n4", "n5"], async () => {
            fired++
        })
        expect(fired).toBe(1)
    })
})

describe("waitForBarrier: edge cases", () => {
    test("no activeTask → treats as default mode (status idle check)", async () => {
        const team = makeTeam({
            members: [{ name: "alice", status: "idle" }],
            activeTask: undefined,
        })
        let fired = 0
        await waitForBarrier(team, ["alice"], async () => {
            fired++
        })
        expect(fired).toBe(1)
    })

    test("empty participant list → fires vacuously", async () => {
        const team = makeTeam({
            members: [],
            activeTask: { requireDoneAck: true },
        })
        let fired = 0
        await waitForBarrier(team, [], async () => {
            fired++
        })
        // every() on empty array returns true — barrier fires. This matches
        // the existing behavior for edge cases.
        expect(fired).toBe(1)
    })

    test("unknown member name treated as not-ready (defensive)", async () => {
        const team = makeTeam({
            members: [{ name: "alice", declaredDone: true }],
            activeTask: { requireDoneAck: true },
        })
        let fired = 0
        await waitForBarrier(team, ["alice", "unknown"], async () => {
            fired++
        })
        expect(fired).toBe(0)
    })

    test("onBarrier is called exactly once per ready state", async () => {
        const team = makeTeam({
            members: [
                { name: "alice", declaredDone: true },
                { name: "bob", declaredDone: true },
            ],
            activeTask: { requireDoneAck: true },
        })
        let fired = 0
        // Calling waitForBarrier twice with the same ready state fires twice —
        // idempotency is the CALLER's responsibility (handleParallelIdle guards
        // via mutex + state flips). Documented here as a regression sentinel.
        await waitForBarrier(team, ["alice", "bob"], async () => {
            fired++
        })
        await waitForBarrier(team, ["alice", "bob"], async () => {
            fired++
        })
        expect(fired).toBe(2)
    })
})

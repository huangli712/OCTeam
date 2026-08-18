/**
 * Coverage-gap regression tests for maybeTriggerSignoff's two fallback paths
 * (audit 2026-06-30 finding #5):
 *   - decider mode + decider unavailable (no sessionId OR errored) → fall back
 *   - peer-quorum mode + zero eligible reviewers → fall back
 *
 * Both paths return false (caller must do direct delivery) AND reset
 * task.signoffStage to false. Without coverage these were silent dead-code
 * branches (lines 53-57 and 64-67 of src/orchestration/control/signoff.ts).
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import type { ActiveTask, MemberState, TeamState } from "../src/core/types.js"
import { handleSignoffIdle, maybeTriggerSignoff } from "../src/orchestration/control/signoff.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { statePath } from "../src/state/paths.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"

const tracked: string[] = []

afterAll(cleanupTmpRoots)

afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

function makeParallelTask(overrides: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "parallel",
        mode: "isolated",
        startedAt: Date.now(),
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: { alice: "alice output", bob: "bob output" },
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        ...overrides,
    } as ActiveTask
}

async function setupSignoffTeam(opts: {
    root: string
    masterSid: string
    members: MemberState[]
    task: ActiveTask
}): Promise<{ team: ReturnType<typeof loadTeamState> extends Promise<infer T> ? T : never }> {
    const base = makeState("signoff-team", opts.masterSid, opts.members, Date.now())
    const state: TeamState = {
        ...base,
        status: "busy",
        activeTask: opts.task,
    }
    await initTeamState(opts.root, state, opts.masterSid)
    await rebuildSessionIndex(opts.root, `${opts.root}__unused`)
    return { team: await loadTeamState(opts.root, "signoff-team", opts.masterSid) }
}

describe("maybeTriggerSignoff: fallback to direct delivery (return false)", () => {
        test("decider mode + decider member is errored → fail closed", async () => {
        const root = tmpRoot("signoff-decider-errored")
        const masterSid = "ses_signoff_master_1"
        tracked.push(masterSid)
        const erroredDecider: MemberState = {
            ...makeMember("carol", "ses_carol_1"),
            status: "errored",
        }
        const { team } = await setupSignoffTeam({
            root,
            masterSid,
            members: [makeMember("alice", "ses_alice_1"), erroredDecider],
            task: makeParallelTask({
                signoffPolicy: "decider",
                signoffDecider: "carol",
            }),
        })

        const triggered = await maybeTriggerSignoff(makeCtx({ storageRoot: root, directory: root, promptAsync: async () => ({}) }), team)
        expect(triggered).toBe(true)
        expect(team.activeTask).toBeUndefined()
    })

    test("decider mode + decider has no sessionId (legacy/uninitialized) → fail closed", async () => {
        const root = tmpRoot("signoff-decider-no-sid")
        const masterSid = "ses_signoff_master_2"
        tracked.push(masterSid)
        const noSessionDecider: MemberState = {
            ...makeMember("carol"),
            sessionId: undefined,
        }
        const { team } = await setupSignoffTeam({
            root,
            masterSid,
            members: [makeMember("alice", "ses_alice_2"), noSessionDecider],
            task: makeParallelTask({
                signoffPolicy: "decider",
                signoffDecider: "carol",
            }),
        })

        const triggered = await maybeTriggerSignoff(makeCtx({ storageRoot: root, directory: root, promptAsync: async () => ({}) }), team)
        expect(triggered).toBe(true)
        expect(team.activeTask).toBeUndefined()
    })

    test("decider mode + decider name not in team → fail closed", async () => {
        const root = tmpRoot("signoff-decider-missing")
        const masterSid = "ses_signoff_master_3"
        tracked.push(masterSid)
        const { team } = await setupSignoffTeam({
            root,
            masterSid,
            members: [makeMember("alice", "ses_alice_3")],
            task: makeParallelTask({
                signoffPolicy: "decider",
                signoffDecider: "nonexistent",
            }),
        })

        const triggered = await maybeTriggerSignoff(makeCtx({ storageRoot: root, directory: root, promptAsync: async () => ({}) }), team)
        expect(triggered).toBe(true)
        expect(team.activeTask).toBeUndefined()
    })

    test("peer-quorum mode + all non-master members are errored → fail closed", async () => {
        const root = tmpRoot("signoff-quorum-all-errored")
        const masterSid = "ses_signoff_master_4"
        tracked.push(masterSid)
        const { team } = await setupSignoffTeam({
            root,
            masterSid,
            members: [
                { ...makeMember("alice", "ses_alice_4"), status: "errored" },
                { ...makeMember("bob", "ses_bob_4"), status: "errored" },
            ],
            task: makeParallelTask({
                signoffPolicy: "peer-quorum",
                signoffQuorum: 0.5,
            }),
        })

        const triggered = await maybeTriggerSignoff(makeCtx({ storageRoot: root, directory: root, promptAsync: async () => ({}) }), team)
        expect(triggered).toBe(true)
        expect(team.activeTask).toBeUndefined()
    })

    test("peer-quorum mode + only master + no other members → fail closed", async () => {
        const root = tmpRoot("signoff-quorum-no-reviewers")
        const masterSid = "ses_signoff_master_5"
        tracked.push(masterSid)
        const { team } = await setupSignoffTeam({
            root,
            masterSid,
            members: [],  // master is implicit; no reviewing peers
            task: makeParallelTask({
                signoffPolicy: "peer-quorum",
                signoffQuorum: 0.5,
            }),
        })

        const triggered = await maybeTriggerSignoff(makeCtx({ storageRoot: root, directory: root, promptAsync: async () => ({}) }), team)
        expect(triggered).toBe(true)
        expect(team.activeTask).toBeUndefined()
    })

    test("no signoffPolicy → no trigger (caller delivers directly)", async () => {
        const root = tmpRoot("signoff-no-policy")
        const masterSid = "ses_signoff_master_6"
        tracked.push(masterSid)
        const { team } = await setupSignoffTeam({
            root,
            masterSid,
            members: [makeMember("alice", "ses_alice_6")],
            task: makeParallelTask({}),  // no signoffPolicy
        })

        const triggered = await maybeTriggerSignoff(makeCtx({ storageRoot: root, directory: root, promptAsync: async () => ({}) }), team)
        expect(triggered).toBe(false)
        // signoffStage was never set; still undefined.
        expect(team.activeTask!.signoffStage).toBeUndefined()
    })
})

describe("maybeTriggerSignoff: peer-quorum dispatch roster", () => {
    test("persists only successfully dispatched reviewers after a partial failure", async () => {
        const root = tmpRoot("signoff-quorum-partial-dispatch")
        const masterSid = "ses_signoff_master_partial"
        tracked.push(masterSid)
        const { team } = await setupSignoffTeam({
            root,
            masterSid,
            members: [
                makeMember("alice", "ses_alice_partial"),
                makeMember("bob", "ses_bob_partial"),
            ],
            task: makeParallelTask({
                signoffPolicy: "peer-quorum",
                signoffQuorum: 0.5,
            }),
        })
        const ctx = makeCtx({
            storageRoot: root,
            directory: root,
            promptAsync: async request => {
                if (request.path.id === "ses_bob_partial") throw new Error("dispatch failed")
                return {}
            },
        })

        expect(await maybeTriggerSignoff(ctx, team)).toBe(true)
        expect(team.activeTask?.signoffReviewers).toEqual(["alice"])
        const persisted: unknown = JSON.parse(await readFile(statePath(team.directory), "utf8"))
        expect(persisted).toMatchObject({ activeTask: { signoffReviewers: ["alice"] } })

        const alice = team.members.find(member => member.name === "alice")
        if (alice === undefined) throw new Error("Missing alice fixture")
        alice.status = "idle"
        if (team.activeTask === undefined) throw new Error("Missing active task")
        team.activeTask.signoffRawOutputs = {
            alice: '<signoff>{"approved":true,"rationale":"ready"}</signoff>',
        }

        await handleSignoffIdle(ctx, team, alice)

        expect(team.activeTask).toBeUndefined()
    })
})

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"

import type { PluginContext } from "../src/core/context.js"
import type { MemberState, TeamState } from "../src/core/types.js"
import { ensureMembersReady } from "../src/orchestration/control/members.js"
import { statePath } from "../src/state/paths.js"
import { unindexSession } from "../src/state/resolve.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, tmpRoot } from "./helpers.js"

type SessionDeleteRequest = { readonly path: { readonly id: string } }

/** Let spawn planning read readiness once, then reject the first barrier poll. */
function triggerBarrierTimeoutOnSecondRead(member: MemberState): void {
    let initialized = member.initialized
    let readCount = 0
    Object.defineProperty(member, "initialized", {
        configurable: true,
        enumerable: true,
        get(): boolean {
            readCount += 1
            if (readCount === 2) throw new Error("forced role-setup barrier timeout")
            return initialized
        },
        set(value: boolean): void {
            initialized = value
        },
    })
}

function requireMember(members: readonly MemberState[], name: string): MemberState {
    const member = members.find(candidate => candidate.name === name)
    if (member === undefined) throw new Error(`${name} fixture member is missing`)
    return member
}

async function readDiskState(directory: string): Promise<TeamState> {
    const raw = await readFile(statePath(directory), "utf8")
    return JSON.parse(raw)
}

function makeDeleteRecordingCtx(root: string, deletedSessionIds: string[]): PluginContext {
    return makeCtx({
        storageRoot: root,
        overrides: {
            client: {
                app: { log: async () => ({}) },
                session: {
                    delete: async ({ path }: SessionDeleteRequest) => {
                        deletedSessionIds.push(path.id)
                        return { data: {} }
                    },
                },
            },
        },
    })
}

afterAll(cleanupTmpRoots)

const trackedSessionIds: string[] = []
afterEach(() => {
    for (const sessionId of trackedSessionIds.splice(0)) unindexSession(sessionId)
})

describe("role-setup timeout readiness revalidation", () => {
    test("recovers a live uninitialized member from ready persisted state with the same session", async () => {
        const root = tmpRoot("timeout-revalidate-recover")
        const leadSid = "ses_revalidate_recover_lead"
        const memberSid = "ses_revalidate_recover_member"
        trackedSessionIds.push(memberSid)

        await initTeamState(root, makeState("recover", leadSid, [makeMember("alice", memberSid)]), leadSid)
        const team = await loadTeamState(root, "recover", leadSid)
        const liveMember = requireMember(team.members, "alice")
        liveMember.initialized = false
        liveMember.status = "running"
        triggerBarrierTimeoutOnSecondRead(liveMember)

        const deletedSessionIds: string[] = []
        await expect(ensureMembersReady(makeDeleteRecordingCtx(root, deletedSessionIds), team)).resolves.toBeUndefined()

        const recoveredMember = requireMember(team.members, "alice")
        const diskMember = requireMember((await readDiskState(team.directory)).members, "alice")
        expect(deletedSessionIds).toEqual([])
        expect(recoveredMember.initialized).toBe(true)
        expect(recoveredMember.status).toBe("idle")
        expect(recoveredMember.sessionId).toBe(memberSid)
        expect(diskMember.initialized).toBe(true)
        expect(diskMember.status).toBe("idle")
        expect(diskMember.sessionId).toBe(memberSid)
    })

    test("rejects and deletes a member that is uninitialized in live and persisted state", async () => {
        const root = tmpRoot("timeout-revalidate-reject")
        const leadSid = "ses_revalidate_reject_lead"
        const memberSid = "ses_revalidate_reject_member"
        trackedSessionIds.push(memberSid)

        const member = makeMember("bob", memberSid)
        member.initialized = false
        member.status = "running"
        await initTeamState(root, makeState("reject", leadSid, [member]), leadSid)
        const team = await loadTeamState(root, "reject", leadSid)
        triggerBarrierTimeoutOnSecondRead(requireMember(team.members, "bob"))

        const deletedSessionIds: string[] = []
        await expect(ensureMembersReady(makeDeleteRecordingCtx(root, deletedSessionIds), team)).rejects.toThrow(
            "role-setup barrier timed out",
        )

        const liveMember = requireMember(team.members, "bob")
        const diskMember = requireMember((await readDiskState(team.directory)).members, "bob")
        expect(deletedSessionIds).toEqual([memberSid])
        expect(liveMember.initialized).toBe(false)
        expect(liveMember.status).toBe("errored")
        expect(liveMember.sessionId).toBeUndefined()
        expect(diskMember.initialized).toBe(false)
        expect(diskMember.status).toBe("errored")
        expect(diskMember.sessionId).toBeUndefined()
    })

    test("rejects and deletes only the new live session when persisted readiness has an old session", async () => {
        const root = tmpRoot("timeout-revalidate-mismatch")
        const leadSid = "ses_revalidate_mismatch_lead"
        const oldSessionId = "ses_revalidate_mismatch_old"
        const newSessionId = "ses_revalidate_mismatch_new"
        trackedSessionIds.push(oldSessionId, newSessionId)

        await initTeamState(root, makeState("mismatch", leadSid, [makeMember("carol", oldSessionId)]), leadSid)
        const team = await loadTeamState(root, "mismatch", leadSid)
        const liveMember = requireMember(team.members, "carol")
        liveMember.sessionId = newSessionId
        liveMember.initialized = false
        liveMember.status = "running"

        const beforeMember = requireMember((await readDiskState(team.directory)).members, "carol")
        expect(beforeMember.initialized).toBe(true)
        expect(beforeMember.sessionId).toBe(oldSessionId)
        triggerBarrierTimeoutOnSecondRead(liveMember)

        const deletedSessionIds: string[] = []
        await expect(ensureMembersReady(makeDeleteRecordingCtx(root, deletedSessionIds), team)).rejects.toThrow(
            "role-setup barrier timed out",
        )

        const failedMember = requireMember(team.members, "carol")
        const diskMember = requireMember((await readDiskState(team.directory)).members, "carol")
        expect(deletedSessionIds).toEqual([newSessionId])
        expect(failedMember.initialized).toBe(false)
        expect(failedMember.status).toBe("errored")
        expect(failedMember.sessionId).toBeUndefined()
        expect(diskMember.initialized).toBe(false)
        expect(diskMember.status).toBe("errored")
        expect(diskMember.sessionId).toBeUndefined()
    })

    test("rejects matching persisted readiness from a different teamRunId without deleting the live session", async () => {
        const root = tmpRoot("timeout-revalidate-generation")
        const leadSid = "ses_revalidate_generation_lead"
        const memberSid = "ses_revalidate_generation_member"
        const liveRunId = "11111111-1111-4111-8111-111111111111"
        const replacementRunId = "22222222-2222-4222-8222-222222222222"
        trackedSessionIds.push(memberSid)

        const state = makeState("generation", leadSid, [makeMember("dana", memberSid)])
        state.teamRunId = liveRunId
        await initTeamState(root, state, leadSid)
        const team = await loadTeamState(root, "generation", leadSid)

        const replacementState = await readDiskState(team.directory)
        replacementState.teamRunId = replacementRunId
        await writeFile(statePath(team.directory), JSON.stringify(replacementState, null, 2), "utf8")

        const liveMember = requireMember(team.members, "dana")
        liveMember.initialized = false
        liveMember.status = "running"
        triggerBarrierTimeoutOnSecondRead(liveMember)

        const deletedSessionIds: string[] = []
        await expect(ensureMembersReady(makeDeleteRecordingCtx(root, deletedSessionIds), team)).rejects.toThrow(
            "role-setup barrier timed out",
        )

        const failedMember = requireMember(team.members, "dana")
        const persistedState = await readDiskState(team.directory)
        const persistedMember = requireMember(persistedState.members, "dana")
        expect(deletedSessionIds).toEqual([])
        expect(failedMember.initialized).toBe(false)
        expect(persistedState.teamRunId).toBe(replacementRunId)
        expect(persistedMember.initialized).toBe(true)
        expect(persistedMember.status).toBe("idle")
        expect(persistedMember.sessionId).toBe(memberSid)
    })
})

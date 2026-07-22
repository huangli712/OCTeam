import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"

import {
    MemberHoldsActiveTaskError,
    TaskAlreadyClaimedError,
    claimTask,
    createTask,
    updateTask,
} from "../src/state/tasks.js"
import { claimMutexPath } from "../src/state/paths.js"
import { cleanupTmpRoots, tmpRoot } from './helpers.js';

afterAll(cleanupTmpRoots)

async function setupTeamDir(label: string): Promise<string> {
    const root = tmpRoot(label)
    // claimTask expects <teamDirectory>; tasks/ subdir is created on demand.
    return path.join(root, "team")
}

async function seedTask(teamDir: string, subject: string): Promise<string> {
    const t = await createTask(teamDir, {
        subject,
        description: `desc-${subject}`,
    })
    return t.id
}

describe("claimMutexPath", () => {
    test("returns tasks/claims/claim-mutex.lock under team dir", () => {
        const p = claimMutexPath("/teams/abc")
        expect(p).toBe(
            path.join("/teams/abc", "tasks", "claims", "claim-mutex.lock"),
        )
    })
})

describe("claimTask: per-member concurrency cap (1 active task)", () => {
    test("member cannot claim a 2nd task while holding a claimed task", async () => {
        const dir = await setupTeamDir("cap-claimed")
        const t1 = await seedTask(dir, "T1")
        const t2 = await seedTask(dir, "T2")

        await claimTask(dir, t1, "alice")
        await expect(claimTask(dir, t2, "alice")).rejects.toBeInstanceOf(
            MemberHoldsActiveTaskError,
        )
    })

    test("member cannot claim a 2nd task while holding an in_progress task", async () => {
        const dir = await setupTeamDir("cap-inprogress")
        const t1 = await seedTask(dir, "T1")
        const t2 = await seedTask(dir, "T2")

        const claimed = await claimTask(dir, t1, "alice")
        await updateTask(dir, claimed.id, { status: "in_progress" })

        await expect(claimTask(dir, t2, "alice")).rejects.toBeInstanceOf(
            MemberHoldsActiveTaskError,
        )
    })

    test("member can claim again after completing the previous task", async () => {
        const dir = await setupTeamDir("cap-complete")
        const t1 = await seedTask(dir, "T1")
        const t2 = await seedTask(dir, "T2")

        const claimed = await claimTask(dir, t1, "alice")
        await updateTask(dir, claimed.id, { status: "completed" })

        const second = await claimTask(dir, t2, "alice")
        expect(second.owner).toBe("alice")
        expect(second.status).toBe("claimed")
    })

    test("member can claim again after deleting the previous task", async () => {
        const dir = await setupTeamDir("cap-delete")
        const t1 = await seedTask(dir, "T1")
        const t2 = await seedTask(dir, "T2")

        const claimed = await claimTask(dir, t1, "alice")
        await updateTask(dir, claimed.id, { status: "deleted" })

        const second = await claimTask(dir, t2, "alice")
        expect(second.owner).toBe("alice")
    })

    test("different members can hold tasks concurrently", async () => {
        const dir = await setupTeamDir("cap-multi")
        const t1 = await seedTask(dir, "T1")
        const t2 = await seedTask(dir, "T2")

        const c1 = await claimTask(dir, t1, "alice")
        const c2 = await claimTask(dir, t2, "bob")

        expect(c1.owner).toBe("alice")
        expect(c2.owner).toBe("bob")
    })

    test("MemberHoldsActiveTaskError message identifies member and held task", async () => {
        const dir = await setupTeamDir("cap-msg")
        const t1 = await seedTask(dir, "T1")
        const t2 = await seedTask(dir, "T2")

        await claimTask(dir, t1, "alice")
        await expect(claimTask(dir, t2, "alice")).rejects.toThrow(
            new RegExp(`alice.*${t1}.*claimed`, "i"),
        )
    })

    test("original TaskAlreadyClaimedError still fires when another member holds the task", async () => {
        const dir = await setupTeamDir("cap-existing")
        const t1 = await seedTask(dir, "T1")

        await claimTask(dir, t1, "alice")
        // Bob tries to claim the same task already held by alice.
        await expect(claimTask(dir, t1, "bob")).rejects.toBeInstanceOf(
            TaskAlreadyClaimedError,
        )
    })
})

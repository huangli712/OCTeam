/**
 * Concurrency stress tests for claimTask (src/state/tasks.ts) — the TOCTOU-safe
 * task claim path the delegate/recurse pools depend on.
 *
 * GAP CLOSED: the existing tasks.test.ts only claims SEQUENTIALLY (await claim,
 * then await claim). No test fires concurrent claims, so neither the
 * claim-mutex (claimMutexPath) nor the per-member 1-task cap is exercised under
 * real overlap. These tests fire many simultaneous claims and assert the
 * invariants hold: exactly one winner per task, and one active task per member.
 */
import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"

import {
    MemberHoldsActiveTaskError,
    TaskAlreadyClaimedError,
    claimTask,
    createTask,
    listAllTasks,
} from "../src/state/tasks.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

function teamDirFor(label: string): string {
    return path.join(tmpRoot(label), "team")
}

async function seed(dir: string, subject: string): Promise<string> {
    const t = await createTask(dir, { subject, description: `d-${subject}` })
    return t.id
}

describe("claimTask under concurrency: one winner per task", () => {
    test("100 simultaneous claims on the SAME task → exactly one succeeds", async () => {
        const dir = teamDirFor("claim-stampede")
        const taskId = await seed(dir, "hot")

        // 100 distinct members race to claim the single pending task.
        const attempts = Array.from({ length: 100 }, (_, i) =>
            claimTask(dir, taskId, `member-${i}`).then(
                () => ({ ok: true as const }),
                (err: unknown) => ({ ok: false as const, err }),
            ),
        )
        const results = await Promise.all(attempts)

        const winners = results.filter(r => r.ok)
        const losers = results.filter(r => !r.ok)

        // CRITICAL invariant: exactly one claim wins the task.
        expect(winners.length).toBe(1)
        expect(losers.length).toBe(99)
        // Every loser failed with the expected claim error (not a crash/path error).
        for (const l of losers) {
            expect((l as { err: unknown }).err).toBeInstanceOf(TaskAlreadyClaimedError)
        }

        // On disk the task is claimed by exactly one owner.
        const tasks = await listAllTasks(dir)
        const claimed = tasks.filter(t => t.status === "claimed")
        expect(claimed.length).toBe(1)
        expect(claimed[0].owner).toMatch(/^member-\d+$/)
    }, 30_000) // 100 contending claims serialize through the claim-mutex (~5s); raise the per-test cap above the 5s default.

    test("concurrent claims on DISTINCT tasks all succeed (no false contention)", async () => {
        const dir = teamDirFor("claim-distinct")
        const ids = await Promise.all(
            Array.from({ length: 20 }, (_, i) => seed(dir, `t${i}`)),
        )
        // Each task claimed by its own distinct member, all at once.
        const results = await Promise.all(
            ids.map((id, i) =>
                claimTask(dir, id, `m-${i}`).then(
                    () => true,
                    () => false,
                ),
            ),
        )
        // No false contention: every distinct-task claim succeeds.
        expect(results.every(Boolean)).toBe(true)
        const tasks = await listAllTasks(dir)
        expect(tasks.filter(t => t.status === "claimed").length).toBe(20)
    })
})

describe("claimTask under concurrency: per-member 1-task cap (TOCTOU)", () => {
    test("one member firing claims on TWO tasks at once → at most one is held", async () => {
        const dir = teamDirFor("claim-cap-race")
        const t1 = await seed(dir, "A")
        const t2 = await seed(dir, "B")

        // alice races to claim BOTH tasks simultaneously. The claim-mutex +
        // "no active task" check must prevent her from holding both — exactly
        // the TOCTOU the claimMutexPath critical section closes.
        const [r1, r2] = await Promise.all([
            claimTask(dir, t1, "alice").then(
                () => ({ ok: true as const }),
                (err: unknown) => ({ ok: false as const, err }),
            ),
            claimTask(dir, t2, "alice").then(
                () => ({ ok: true as const }),
                (err: unknown) => ({ ok: false as const, err }),
            ),
        ])

        const oks = [r1, r2].filter(r => r.ok)
        const fails = [r1, r2].filter(r => !r.ok)

        // INVARIANT: alice holds at most ONE task (the 1-active-task cap).
        expect(oks.length).toBe(1)
        expect(fails.length).toBe(1)
        // The rejected one is the per-member cap error (or a claim race) — not a crash.
        const err = (fails[0] as { err: unknown }).err
        expect(
            err instanceof MemberHoldsActiveTaskError
                || err instanceof TaskAlreadyClaimedError,
        ).toBe(true)

        // On disk: alice owns exactly one claimed task; the other stays pending.
        const tasks = await listAllTasks(dir)
        const aliceHeld = tasks.filter(t => t.owner === "alice" && t.status === "claimed")
        expect(aliceHeld.length).toBe(1)
        const pending = tasks.filter(t => t.status === "pending")
        expect(pending.length).toBe(1)
    })

    test("5 members each firing 2 concurrent claims → each holds at most one task", async () => {
        const dir = teamDirFor("claim-cap-multi")
        // 10 tasks, 5 members; each member races two claims.
        const ids = await Promise.all(
            Array.from({ length: 10 }, (_, i) => seed(dir, `t${i}`)),
        )
        const members = ["a", "b", "c", "d", "e"]
        const attempts: Promise<unknown>[] = []
        members.forEach((m, i) => {
            // Each member targets two different tasks at once.
            attempts.push(claimTask(dir, ids[i * 2], m).catch(() => undefined))
            attempts.push(claimTask(dir, ids[i * 2 + 1], m).catch(() => undefined))
        })
        await Promise.all(attempts)

        const tasks = await listAllTasks(dir)
        // INVARIANT: no member holds more than one active (claimed) task.
        for (const m of members) {
            const held = tasks.filter(t => t.owner === m && t.status === "claimed")
            expect(held.length).toBeLessThanOrEqual(1)
        }
    })
})

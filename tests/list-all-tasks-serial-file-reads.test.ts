/**
 * Regression test for confirmed finding "list-all-tasks-serial-file-reads".
 *
 * Bug: src/state/tasks.ts:157 (listAllTasks) reads every task file SERIALLY in
 * a for-loop (`await readTaskFile(...)` per entry). listAllTasks is on the hot
 * path of the idle tail, claimTask's "no active task" scan, summary/reduce
 * reads, reapStaleClaims, and the sweep. Near team.bounds.maxTasks the
 * wall-clock latency therefore scales linearly with file count.
 *
 * Fix: issue the per-file reads CONCURRENTLY (e.g. Promise.all over the
 * entries) so the latency is bounded by the slowest single read, not the sum.
 *
 * How this test distinguishes serial vs parallel DETERMINISTICALLY (no wall-
 * clock measurement, no flakiness): it instruments fs.readFile (the single read
 * primitive listAllTasks -> readTaskFile uses) to track PEAK CONCURRENCY — the
 * high-water mark of simultaneous in-flight reads — and makes each read PENDING
 * (resolved only when the test releases it) so the control-flow difference is
 * forced to steady state:
 *
 *   - SERIAL (current): the for-loop awaits read 0 before calling read 1, so
 *     with read 0 held pending, no other read ever starts -> peak == 1.
 *   - PARALLEL (fixed): Promise.all initiates every read in one synchronous
 *     pass -> all N reads are in flight before any resolves -> peak == N.
 *
 * The assertion `peak >= 2` therefore FAILS on the unfixed code (peak == 1)
 * and PASSES on the fixed code (peak == N). It is implementation-agnostic: any
 * parallelization (full Promise.all OR bounded concurrency) yields peak > 1.
 *
 * fs.readFile is intercepted by mutating the shared `node:fs/promises` default-
 * export namespace that tasks.ts imports (verified to be the same object), and
 * restored in finally so other tests are unaffected.
 */

import { afterAll, describe, expect, test } from "bun:test"

import fs from "node:fs/promises"

import { createTask, listAllTasks } from "../src/state/tasks.js"
import { tmpRoot, cleanupTmpRoots } from "./helpers.js"
import { waitUntil } from "../src/core/utils.js"

afterAll(cleanupTmpRoots)

describe("listAllTasks must read task files concurrently (finding: list-all-tasks-serial-file-reads)", () => {
    test("peak in-flight reads exceeds 1 (not purely serial)", async () => {
        const root = tmpRoot("list-all-tasks-serial")
        const teamDir = `${root}/team`

        // Seed N real task files (via real fs, before intercepting readFile).
        const N = 6
        for (let i = 0; i < N; i++) {
            await createTask(teamDir, { subject: `t${i}`, description: "x" })
        }

        // --- Intercept fs.readFile with a DEFERRED, instrumented stand-in. ---
        // Each read stays PENDING until release() is called, so the control-flow
        // difference (serial await vs concurrent fan-out) is forced to steady
        // state. Track peak concurrency across all in-flight reads.
        const realReadFile = fs.readFile
        let inFlight = 0
        let peak = 0
        let initiated = 0
        const releasers: Array<() => void> = []
        const fsNamespace = fs as unknown as { readFile: typeof fs.readFile }

        fsNamespace.readFile = ((file: string) => {
            initiated++
            inFlight++
            if (inFlight > peak) peak = inFlight
            return new Promise<string>(resolve => {
                releasers.push(() => {
                    inFlight--
                    // Valid minimal Task JSON so readTaskFile -> isValidTask
                    // accepts it and listAllTasks returns the row.
                    resolve(
                        JSON.stringify({
                            id: "00000000-0000-0000-0000-000000000000",
                            subject: String(file),
                            status: "pending",
                            blockedBy: [],
                        }),
                    )
                })
            })
        }) as typeof fs.readFile

        try {
            // Do NOT await yet — drive listAllTasks until its reads have begun.
            const pending = listAllTasks(teamDir)

            // Wait until listAllTasks has reached the read phase (readdir
            // resolves, then the read loop starts). In PARALLEL mode, once the
            // first read initiates the synchronous fan-out has already happened,
            // so peak is already N. In SERIAL mode the first read initiates and
            // then blocks (pending) — peak stays 1.
            await waitUntil(() => initiated >= 1, { timeoutMs: 1000, pollMs: 1 })
            // Let any same-tick fan-out settle (defensive; map is synchronous).
            for (let i = 0; i < 10; i++) await Promise.resolve()

            // Core contract: reads must overlap, not run purely serially.
            //   UNFIXED (serial for-loop): peak == 1 -> FAILS.
            //   FIXED   (concurrent):      peak >= 2 -> PASSES.
            expect(peak).toBeGreaterThanOrEqual(2)

            // Release the deferred reads and collect the result so no promise is
            // left dangling. listAllTasks must still return all N tasks.
            for (const release of releasers) release()
            const tasks = await pending
            expect(tasks).toHaveLength(N)
        } finally {
            fsNamespace.readFile = realReadFile
        }
    })
})

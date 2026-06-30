/**
 * Stress + invariant tests for AsyncMutex (src/state/locks.ts) — the
 * process-level per-team serialization primitive that the entire event-handler
 * state machine relies on.
 *
 * GAP CLOSED: the existing suite only ever constructs `new AsyncMutex()` as a
 * fixture and calls runExclusive sequentially. No test exercises the actual
 * mutual-exclusion invariant under overlapping calls, the rejected-run
 * non-poisoning contract (locks.ts:80-84), or FIFO ordering. These are the
 * core guarantees that make "concurrent idle events serialize" true.
 */
import { describe, expect, test } from "bun:test"

import { AsyncMutex } from "../src/state/locks.js"

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

describe("AsyncMutex: mutual exclusion under overlap", () => {
    test("concurrent runExclusive calls never overlap (critical section is serial)", async () => {
        const mutex = new AsyncMutex()
        let active = 0
        let maxActive = 0
        const order: number[] = []

        // Fire 50 overlapping critical sections, each with an await inside so
        // the scheduler WOULD interleave them if the mutex did not serialize.
        const tasks = Array.from({ length: 50 }, (_, i) =>
            mutex.runExclusive(async () => {
                active++
                maxActive = Math.max(maxActive, active)
                // Yield to the event loop mid-section — the moment another
                // section could slip in if exclusion were broken.
                await sleep(1)
                order.push(i)
                active--
            }),
        )
        await Promise.all(tasks)

        // The invariant: at no point were two sections active simultaneously.
        expect(maxActive).toBe(1)
        // FIFO: sections completed in submission order.
        expect(order).toEqual(Array.from({ length: 50 }, (_, i) => i))
    })

    test("a rejected run does NOT poison the chain (subsequent runs still execute)", async () => {
        const mutex = new AsyncMutex()
        const ran: string[] = []

        // First run rejects; the caller receives the rejection...
        const failing = mutex.runExclusive(async () => {
            ran.push("a-start")
            throw new Error("boom")
        })
        // ...but the chain must NOT be poisoned: b and c still run.
        const b = mutex.runExclusive(async () => {
            ran.push("b")
        })
        const c = mutex.runExclusive(async () => {
            ran.push("c")
        })

        await expect(failing).rejects.toThrow("boom")
        await Promise.all([b, c])

        // Both subsequent sections executed despite the earlier rejection.
        expect(ran).toEqual(["a-start", "b", "c"])
    })

    test("a synchronously-throwing fn rejects the caller but keeps the chain alive", async () => {
        const mutex = new AsyncMutex()
        const ran: string[] = []
        // fn throws synchronously (before its first await). chain.then(fn, fn)
        // must still settle so the next runExclusive proceeds.
        const failing = mutex.runExclusive(async () => {
            throw new Error("sync-throw")
        })
        const next = mutex.runExclusive(async () => {
            ran.push("next")
        })
        await expect(failing).rejects.toThrow("sync-throw")
        await next
        expect(ran).toEqual(["next"])
    })

    test("return value of fn is propagated to the caller", async () => {
        const mutex = new AsyncMutex()
        const result = await mutex.runExclusive(async () => 42)
        expect(result).toBe(42)
    })

    test("interleaved submissions serialize by submission order even with varied delays", async () => {
        const mutex = new AsyncMutex()
        const order: string[] = []
        // Submit in order a,b,c but give 'a' the LONGEST delay. If the mutex
        // serializes correctly, a still completes first (it was submitted first
        // and holds the lock); b and c wait regardless of their shorter delays.
        const a = mutex.runExclusive(async () => {
            await sleep(15)
            order.push("a")
        })
        const b = mutex.runExclusive(async () => {
            await sleep(1)
            order.push("b")
        })
        const c = mutex.runExclusive(async () => {
            await sleep(1)
            order.push("c")
        })
        await Promise.all([a, b, c])
        expect(order).toEqual(["a", "b", "c"])
    })
})

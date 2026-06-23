import { describe, expect, test } from "bun:test"

import { MEMBER_NAME_POOL, pickName } from "../src/tools/lifecycle.js"

describe("pickName (random, no reuse)", () => {
    test("returns a pool name when nothing taken", () => {
        const name = pickName(new Set())
        expect(MEMBER_NAME_POOL).toContain(name as (typeof MEMBER_NAME_POOL)[number])
    })

    test("never returns a taken name", () => {
        // Take all but one pool name; the result must be the remaining one.
        const remaining = "pat"
        const taken = new Set(MEMBER_NAME_POOL.filter(n => n !== remaining))
        for (let i = 0; i < 50; i++) {
            expect(pickName(taken)).toBe(remaining)
        }
    })

    test("sequential picks with accumulation are unique (8-member team)", () => {
        const taken = new Set<string>()
        const picked: string[] = []
        for (let i = 0; i < 8; i++) {
            const n = pickName(taken)
            expect(taken.has(n)).toBe(false)
            taken.add(n)
            picked.push(n)
        }
        expect(new Set(picked).size).toBe(8)
    })

    test("falls back to member-N when pool exhausted", () => {
        const taken = new Set<string>(MEMBER_NAME_POOL)
        expect(pickName(taken)).toBe(`member-${MEMBER_NAME_POOL.length + 1}`)
    })

    test("pool has 16 unique names exceeding the 8-member cap", () => {
        expect(MEMBER_NAME_POOL.length).toBe(16)
        expect(new Set(MEMBER_NAME_POOL).size).toBe(16)
    })
})

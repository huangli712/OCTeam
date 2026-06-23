import { describe, expect, test } from "bun:test"

import { MEMBER_NAME_POOL, deriveAgent, pickName } from "../src/tools/lifecycle.js"

describe("deriveAgent (role label → agent)", () => {
    test("coder/developer/implementer → build", () => {
        expect(deriveAgent("coder")).toBe("build")
        expect(deriveAgent("developer")).toBe("build")
        expect(deriveAgent("implementer")).toBe("build")
        expect(deriveAgent("writer")).toBe("build")
    })

    test("reviewer/architect/auditor → oracle (read-only)", () => {
        expect(deriveAgent("reviewer")).toBe("oracle")
        expect(deriveAgent("architect")).toBe("oracle")
        expect(deriveAgent("auditor")).toBe("oracle")
    })

    test("verifier/verification → build (writes/runs tests, needs write access)", () => {
        expect(deriveAgent("verifier")).toBe("build")
        expect(deriveAgent("verification")).toBe("build")
        expect(deriveAgent("verify")).toBe("build")
    })

    test("researcher/explorer → explore", () => {
        expect(deriveAgent("researcher")).toBe("explore")
        expect(deriveAgent("explorer")).toBe("explore")
    })

    test("finder/searcher/librarian → librarian", () => {
        expect(deriveAgent("finder")).toBe("librarian")
        expect(deriveAgent("searcher")).toBe("librarian")
        expect(deriveAgent("librarian")).toBe("librarian")
    })

    test("research checked before search (researcher → explore, not librarian)", () => {
        // "researcher" contains the substring "search"; ordering must resolve it
        // to explore, not librarian.
        expect(deriveAgent("researcher")).toBe("explore")
    })

    test("case-insensitive", () => {
        expect(deriveAgent("CODER")).toBe("build")
        expect(deriveAgent("Reviewer")).toBe("oracle")
    })


    test("unknown label → build (default)", () => {
        expect(deriveAgent("foobar")).toBe("build")
        expect(deriveAgent("")).toBe("build")
    })
})

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

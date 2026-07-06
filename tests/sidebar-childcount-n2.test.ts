/**
 * Regression test for confirmed finding "sidebar-childcount-n2".
 *
 * Bug: src/tui/tree.ts:139 computes each child node's childCount INSIDE the
 * children.map loop with `allSessions.filter(c => c.parentID === s.id).length`.
 * That is a full scan of allSessions per child, so building the sidebar is
 * O(children * allSessions). Near maxTasks / busy trees the refresh cost grows
 * quadratically with the session count.
 *
 * Fix: build a parent->count (or parent->children) Map ONCE from allSessions
 * (a single O(allSessions) pass) and look up each child's count in O(1).
 *
 * How this test distinguishes O(C*S) from O(C+S) DETERMINISTICALLY (no wall-
 * clock, no flakiness): each mock session's `parentID` is a GETTER that
 * increments a shared counter on every read. The total number of `parentID`
 * reads across one loadChildren call is exactly:
 *
 *   - SERIAL/QUADRATIC (current, tree.ts:139): line 120's children filter
 *     reads every session once (S reads), then line 139's per-child filter
 *     reads every session once PER child (C*S reads) -> total = S + C*S
 *     = S*(C+1).
 *   - LINEAR (fixed, Map-based): line 120 (S reads) + one pass to build the
 *     count map (S reads) + O(1) map lookups (0 reads) -> total ~ 2*S.
 *
 * The invariant asserted is `reads < sessionsCount * childrenCount`:
 * "parentID is read fewer than (sessions x children) times" i.e. the impl did
 * NOT perform a full scan per child. This holds for ANY linear fix (full
 * Promise.all / single Map / etc.) and fails ONLY for a Θ(C*S) per-child scan.
 *   UNFIXED: S*(C+1) >= S*C  -> assertion FAILS.
 *   FIXED:   ~2*S < S*C (for C>=3) -> assertion PASSES.
 *
 * A correctness assertion (c0's childCount == 3) guarantees the refactor keeps
 * behavior, so the test cannot pass by accidentally dropping the count.
 */

import { describe, expect, test } from "bun:test"

import { loadChildren } from "../src/tui/tree.js"

type MockSession = {
    id: string
    title: string
    time: { created: number }
    parentID: string | undefined
}

function makeSession(
    id: string,
    parent: string | undefined,
    created: number,
    counter: { n: number },
): MockSession {
    return {
        id,
        title: id,
        time: { created },
        get parentID(): string | undefined {
            counter.n++
            return parent
        },
    } as MockSession
}

describe("loadChildren childCount must not scan allSessions per child (finding: sidebar-childcount-n2)", () => {
    test("parentID reads are linear in sessions, not children x sessions", async () => {
        const reads = { n: 0 }
        const currentSessionId = "root"
        const base = 1_700_000_000_000

        // 10 children of "root" (these become the C nodes).
        const sessions: MockSession[] = []
        for (let i = 0; i < 10; i++) {
            sessions.push(makeSession(`c${i}`, currentSessionId, base + i, reads))
        }
        // 3 grandchildren whose parent is c0 -> c0.childCount must be 3.
        for (let i = 0; i < 3; i++) {
            sessions.push(makeSession(`g${i}`, "c0", base + 100 + i, reads))
        }
        // 17 filler sessions (not children of root) that every per-child filter
        // would wastefully scan. Total sessions S = 30.
        for (let i = 0; i < 17; i++) {
            sessions.push(makeSession(`f${i}`, "other", base + 200 + i, reads))
        }

        const sessionsCount = sessions.length         // 30
        const childrenCount = 10                       // c0..c9 are children of root

        // Minimal TUI plugin API mock. messages() returns empty so duration is "";
        // status() returns idle. list() returns the instrumented sessions.
        const api = {
            client: {
                session: {
                    list: async () => ({ data: sessions }),
                    messages: async () => ({ data: [] }),
                },
            },
            state: {
                session: {
                    status: () => ({ type: "idle" }),
                },
            },
        } as unknown as Parameters<typeof loadChildren>[0]

        // Reset reads AFTER setup (list() return etc. don't touch getters, but be
        // safe). We only want to measure the loadChildren call itself.
        reads.n = 0
        const nodes = await loadChildren(api, currentSessionId)

        // Correctness: c0's childCount is 3 (refactor must preserve this).
        const c0 = nodes.find(n => n.sessionId === "c0")
        expect(c0).toBeDefined()
        expect(c0!.childCount).toBe(3)
        // All 10 children of root are present.
        expect(nodes).toHaveLength(10)

        // Core contract: parentID must NOT be read once-per-child-per-session.
        //   UNFIXED (per-child filter): reads = S*(C+1) >= S*C -> FAILS.
        //   FIXED   (Map / single pass): reads ~ 2*S < S*C      -> PASSES.
        expect(reads.n).toBeLessThan(sessionsCount * childrenCount)
    })
})

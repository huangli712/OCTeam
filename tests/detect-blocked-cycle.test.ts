/**
 * Table-driven tests for the blocked_by cycle detector (three-color DFS).
 * detectBlockedByCycle is a pure function over the declared dependency graph:
 * it returns the offending cycle path (e.g. ["A","B","A"]) or null when the
 * graph is acyclic.
 */
import { describe, expect, it } from "bun:test"

import { detectBlockedByCycle } from "../src/tools/modes/delegate.js"

type Task = { ref?: string; blocked_by?: string[] }

describe("detectBlockedByCycle", () => {
    // Deterministic cases: cycle path is fully determined by the graph and the
    // task-array order (Map insertion order drives the DFS start node).
    const cases: Array<{ name: string; tasks: Task[]; expected: string[] | null }> = [
        {
            name: "empty graph is acyclic",
            tasks: [],
            expected: null,
        },
        {
            name: "single task with no blocked_by is acyclic",
            tasks: [{ ref: "A" }],
            expected: null,
        },
        {
            name: "linear chain A->B->C is acyclic",
            tasks: [
                { ref: "A", blocked_by: ["B"] },
                { ref: "B", blocked_by: ["C"] },
                { ref: "C" },
            ],
            expected: null,
        },
        {
            name: "self-loop A->A returns the self cycle",
            tasks: [{ ref: "A", blocked_by: ["A"] }],
            expected: ["A", "A"],
        },
        {
            name: "2-cycle A<->B returns A,B,A",
            tasks: [
                { ref: "A", blocked_by: ["B"] },
                { ref: "B", blocked_by: ["A"] },
            ],
            expected: ["A", "B", "A"],
        },
        {
            name: "3-cycle A->B->C->A returns A,B,C,A",
            tasks: [
                { ref: "A", blocked_by: ["B"] },
                { ref: "B", blocked_by: ["C"] },
                { ref: "C", blocked_by: ["A"] },
            ],
            expected: ["A", "B", "C", "A"],
        },
    ]

    for (const c of cases) {
        it(c.name, () => {
            expect(detectBlockedByCycle(c.tasks)).toEqual(c.expected)
        })
    }

    it("multi-component graph reports a cycle from the cyclic component", () => {
        // A/B form a cycle; C/D are an acyclic tail. The detector must find a
        // cycle (exact path depends on iteration order; only assert non-null).
        const tasks: Task[] = [
            { ref: "A", blocked_by: ["B"] },
            { ref: "B", blocked_by: ["A"] },
            { ref: "C", blocked_by: ["D"] },
            { ref: "D" },
        ]
        expect(detectBlockedByCycle(tasks)).not.toBeNull()
    })
})

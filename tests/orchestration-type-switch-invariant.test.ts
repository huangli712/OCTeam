/**
 * Invariant test for the three 9-way dispatchers over OrchestrationType:
 *   - processIdle    (src/orchestration/handlers.ts) — Record<OrchestrationType, ...> table
 *   - resumeDispatch (src/orchestration/resume.ts) — switch with `_exhaustive: never` guard
 *   - buildSummary   (src/orchestration/summary.ts) — switch with `_exhaustive: never` guard
 *
 * processIdle was converted from a switch to a Record table in P1-6: the
 * Record<OrchestrationType, ...> type enforces compile-time completeness.
 * This meta-test locks the weaker runtime invariant — every OrchestrationType
 * appears as a key/case — so adding a new type without updating any one of
 * the three dispatchers fails this test at CI time.
 *
 * Source-inspection approach is used because processIdle / resumeDispatch have
 * heavy host-ctx + state dependencies that make dynamic invocation brittle.
 * Reading the source as text + brace-counting to extract the switch body is
 * stable for this codebase's style (single switch per function on task.type).
 */
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

// Must match src/core/types.ts OrchestrationType union. Update both together.
const ORCHESTRATION_TYPES = [
    "parallel",
    "consensus",
    "pipeline",
    "loop",
    "delegate",
    "route",
    "arbitrate",
    "recurse",
    "tollgate",
    "workflow",
    "arena",
] as const

/**
 * Extract the body of the first `switch (...) { ... }` block that appears at
 * the top level of the named function. Brace-counting keeps the slice bounded
 * to the switch (and ignores nested braces inside case bodies). Throws if the
 * function or its switch cannot be located — surfaces test mis-wiring loudly.
 */
async function readSwitchBody(filePath: string, fnName: string): Promise<string> {
    const fullPath = path.resolve(filePath)
    const src = await readFile(fullPath, "utf8")
    // Locate the function declaration by name (works for both `function foo(`
    // and `export async function foo(` styles).
    const fnIdx = src.search(new RegExp(`\\bfunction\\s+${fnName}\\s*\\(`))
    if (fnIdx === -1) {
        throw new Error(`${filePath}: function ${fnName} not found`)
    }
    // First `switch (` after the function start.
    const switchIdx = src.indexOf("switch (", fnIdx)
    if (switchIdx === -1) {
        throw new Error(`${filePath}: no switch in ${fnName}`)
    }
    // Brace-match from the switch's opening `{`.
    const openBrace = src.indexOf("{", switchIdx)
    if (openBrace === -1) throw new Error(`${filePath}: malformed switch in ${fnName}`)
    let depth = 0
    let end = -1
    for (let i = openBrace; i < src.length; i++) {
        const ch = src[i]
        if (ch === "{") depth++
        else if (ch === "}") {
            depth--
            if (depth === 0) {
                end = i
                break
            }
        }
    }
    if (end === -1) throw new Error(`${filePath}: unterminated switch in ${fnName}`)
    return src.slice(switchIdx, end + 1)
}

describe("11-way switch invariant: every OrchestrationType has a case in all three switches", () => {
    test("processIdle (handlers.ts) covers all 11 OrchestrationTypes via idleDispatch table", async () => {
        // After P1-6, processIdle dispatches via a Record<OrchestrationType, ...>
        // table (idleDispatch) instead of a switch. Record enforces compile-time
        // completeness; this test verifies all 11 keys are present in the source.
        const src = await readFile(path.resolve("src/orchestration/handlers.ts"), "utf8")
        for (const t of ORCHESTRATION_TYPES) {
            // Each type appears as a top-level key: `    parallel: async ...`
            expect(src).toMatch(new RegExp(`^    ${t}:\\s*async`, "m"))
        }
    })

    test("resumeDispatch (tools/dispatch.ts) covers all 11 OrchestrationTypes", async () => {
        // pipeline and loop share a single case block (`case "pipeline":\ncase "loop": {`),
        // so each must appear as its own label — the test asserts both labels exist.
        const body = await readSwitchBody("src/tools/dispatch.ts", "resumeDispatch")
        for (const t of ORCHESTRATION_TYPES) {
            expect(body).toContain(`case "${t}"`)
        }
    })

    test("buildSummary (orchestration/summary.ts) covers all 11 OrchestrationTypes", async () => {
        const body = await readSwitchBody("src/orchestration/summary.ts", "buildSummary")
        for (const t of ORCHESTRATION_TYPES) {
            expect(body).toContain(`case "${t}"`)
        }
    })

    test("ORCHESTRATION_TYPES list itself matches the documented count", () => {
        // Sanity guard: if someone shrinks the list above to "fix" the test
        // instead of updating the source, this count assertion catches it.
        expect(ORCHESTRATION_TYPES).toHaveLength(11)
        // And the entries are unique.
        expect(new Set(ORCHESTRATION_TYPES).size).toBe(11)
    })
})

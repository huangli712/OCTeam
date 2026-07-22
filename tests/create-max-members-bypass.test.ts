/**
 * Regression test for confirmed finding "create-max-members-bypass".
 *
 * Bug: src/tools/lifecycle/create.ts:210 persists bounds.maxMembers via
 * defaultBounds(args.bounds) WITHOUT validating that the configured cap is at
 * least as large as the initial members.length. The zod schema validates the
 * two inputs independently:
 *   - members: .min(1).max(8)           (create.ts:96-97)
 *   - bounds.maxMembers: .min(1)        (create.ts:100)
 * There is NO cross-field check that maxMembers >= members.length. So a caller
 * can create a team with maxMembers: 1 and 2 (or more) members — the team is
 * persisted already over its configured member cap.
 *
 * Harm: every downstream invariant that assumes members.length <=
 * bounds.maxMembers is violated at birth:
 *   - team_add_member checks `team.members.length >= team.bounds.maxMembers`
 *     (add.ts:43) — but the team already exceeds it, so NO member can EVER be
 *     added (the cap is already broken and immutable from creation).
 *   - spawn loops, bounds reporting, and quota accounting all read a cap that
 *     the team has never respected.
 *
 * Fix: validate `args.bounds.maxMembers >= args.members.length` in create.ts
 * before persisting, and reject with a clear error if violated.
 *
 * This test creates a team with maxMembers: 1 and 2 members, then asserts the
 * creation is rejected. On UNFIXED code it succeeds and the persisted team has
 * members.length (2) > bounds.maxMembers (1) → test FAILS. On FIXED code the
 * creation is rejected → test PASSES.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import type { ToolContext } from "@opencode-ai/plugin"
import { teamCreateTool } from "../src/tools/lifecycle/create.js"
import { loadTeamState } from "../src/state/store.js"
import { unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeToolContext, tmpRoot } from './helpers.js';


const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})
afterAll(cleanupTmpRoots)

describe("create maxMembers bypass (finding: create-max-members-bypass)", () => {
    test("team_create with maxMembers < members.length must be rejected", async () => {
        const root = tmpRoot("create-max-bypass")
        const sid = "ses_create_max_bypass"
        tracked.push(sid)

        const tool = teamCreateTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            {
                name: "alpha",
                members: [
                    { role: "coder", prompt: "code" },
                    { role: "tester", prompt: "test" },
                ],
                bounds: { maxMembers: 1 },
            },
            makeToolContext(sid),
        )

        // --- ASSERT: creation must be REJECTED ---
        // On UNFIXED code: create.ts:210 persists bounds.maxMembers=1 with 2
        // members → succeeds → result contains "created" → FAIL.
        // On FIXED code: cross-validation rejects → result contains "Error" → PASS.
        expect(result).toMatch(/Error:.*maxMembers/i)
        expect(result).not.toContain("created")

        // --- ASSERT: no team state persisted ---
        // On UNFIXED code: the team dir was created + state.json written →
        // loadTeamState succeeds → FAIL. On FIXED code: loadTeamState throws
        // (no state.json) → PASS.
        expect(loadTeamState(root, "alpha", sid)).rejects.toThrow()
    })

    test("control: maxMembers === members.length is accepted (boundary)", async () => {
        // Proves the rejection targets the OVER-CAP case, not maxMembers per se.
        const root = tmpRoot("create-max-ok")
        const sid = "ses_create_max_ok"
        tracked.push(sid)

        const tool = teamCreateTool(makeCtx({ storageRoot: root }))
        const result = await tool.execute(
            {
                name: "beta",
                members: [
                    { role: "coder", prompt: "code" },
                    { role: "tester", prompt: "test" },
                ],
                bounds: { maxMembers: 2 },
            },
            makeToolContext(sid),
        )

        expect(result).toContain("created")
        const team = await loadTeamState(root, "beta", sid)
        expect(team.members.length).toBe(2)
        expect(team.bounds.maxMembers).toBe(2)
    })
})

/**
 * Regression test for confirmed finding "untyped-team-state-json".
 *
 * Bug: src/tui/teams.ts:79 parses state.json with a bare `JSON.parse(raw)`
 * (untyped) and src/tui/teams.ts:95 maps members through `(m: any)`, reading
 * fields like `m.name` and `m.status` with no shape validation. The server-side
 * loader (src/state/store.ts isValidTeamState) validates the persisted TeamState
 * shape and rejects drifted/corrupt data at the load boundary, but the TUI
 * sidebar loader does NOT use it. As a result, disk-state shape drift becomes
 * either a runtime skip (if a field access crashes) or — worse — broken
 * display: a TeamMemberRow is emitted with a non-string `status`/`name` that
 * the TeamMemberRow type claims is always `string`.
 *
 * This test seeds two teams under the session's project-scope storage:
 *   - "good":  valid shape (member alice, status "idle")
 *   - "broken": syntactically valid JSON but a member whose `status` is a
 *     number. The member's name is a safe path segment, so the current code
 *     does NOT crash (countMailbox resolves, no assertSafeSegment throw); it
 *     silently emits a row with status: 123 — broken display.
 *
 * Contract asserted: the loader MUST NOT emit a structurally malformed
 * TeamMemberRow. Every emitted row's `name` and `status` must be strings
 * (the types say so). On the UNFIXED code the "broken" team's member row has
 * status: 123 (number) -> the assertion FAILS for the right reason. Once the
 * loader validates the parsed state (reusing isValidTeamState or equivalent)
 * and routes invalid shape through the existing skip path, no malformed row is
 * emitted -> the assertion PASSES.
 *
 * The assertion is intentionally implementation-agnostic: any fix that
 * eliminates broken display (rejecting the corrupt team OR producing typed
 * rows) satisfies it. The "good" team guard proves the loader still works, so
 * the failure is specifically the malformed row, not a broken loader.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { loadTeams } from "../src/tui/teams.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

describe("tui team loader must reject untyped/corrupt state (finding: untyped-team-state-json)", () => {
    test("a member with a non-string status is not emitted as a broken row", async () => {
        const cwd = process.cwd()
        const root = tmpRoot("tui-untyped-state")
        const sid = "ses_tui_untyped"

        // loadTeams reads <cwd>/.octeam — run from the isolated tmp root.
        process.chdir(root)
        try {
            const teamsRoot = path.join(root, ".octeam", sid, "teams")

            // --- "good": valid TeamState shape ---
            const goodDir = path.join(teamsRoot, "good")
            await mkdir(goodDir, { recursive: true })
            await writeFile(
                path.join(goodDir, "state.json"),
                JSON.stringify({
                    version: 1,
                    teamRunId: "run-good",
                    teamName: "good",
                    status: "live",
                    members: [{ name: "alice", status: "idle", initialized: true, turnCount: 0 }],
                    bounds: {
                        maxMembers: 8,
                        maxParallelMembers: 4,
                        maxMessagesPerRun: 100,
                        maxWallClockMinutes: 30,
                        maxMemberTurns: 50,
                        maxTasks: 200,
                        messagePayloadMaxBytes: 32768,
                        messageUnreadMaxBytes: 1048576,
                    },
                    createdAt: 0,
                }),
            )

            // --- "broken": syntactically valid JSON, but member.status is a
            //     number. name is a safe segment so the current code does NOT
            //     crash in countMailbox/assertSafeSegment; it silently emits a
            //     row with status: 123 (broken display). ---
            const brokenDir = path.join(teamsRoot, "broken")
            await mkdir(brokenDir, { recursive: true })
            await writeFile(
                path.join(brokenDir, "state.json"),
                JSON.stringify({
                    version: 1,
                    teamRunId: "run-broken",
                    teamName: "broken",
                    status: "live",
                    members: [{ name: "bob", status: 123, initialized: true, turnCount: 0 }],
                    bounds: {
                        maxMembers: 8,
                        maxParallelMembers: 4,
                        maxMessagesPerRun: 100,
                        maxWallClockMinutes: 30,
                        maxMemberTurns: 50,
                        maxTasks: 200,
                        messagePayloadMaxBytes: 32768,
                        messageUnreadMaxBytes: 1048576,
                    },
                    createdAt: 0,
                }),
            )

            const result = await loadTeams(root, sid)
            expect(result.status).toBe("error")
            const summaries = "data" in result ? result.data ?? [] : []

            // Guard: the loader works — the valid team renders correctly.
            const good = summaries.find(s => s.name === "good")
            expect(good).toBeDefined()
            const alice = good!.members.find(m => m.name === "alice")
            expect(alice).toBeDefined()
            expect(alice!.status).toBe("idle")

            // Core contract: NO structurally malformed member row is emitted.
            // TeamMemberRow.name and .status are typed `string`; the loader
            // must never emit `undefined` or a non-string (e.g. a number that
            // slipped through untyped JSON.parse + (m: any)).
            for (const s of summaries) {
                for (const m of s.members) {
                    expect(typeof m.name).toBe("string")
                    expect(typeof m.status).toBe("string")
                }
            }
        } finally {
            process.chdir(cwd)
        }
    })
})

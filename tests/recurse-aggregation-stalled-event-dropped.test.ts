/**
 * Regression test for confirmed finding "aggregation-stalled-event-dropped".
 *
 * Bug: src/orchestration/modes/recurse.ts:178 records an event with
 * `kind: "aggregation_stalled"` via recordEvent (fire-and-forget append to
 * runs/<runId>/events.jsonl). The RunEventKind union (src/core/types.ts:328)
 * includes "aggregation_stalled", so recordEvent accepts and writes it. BUT
 * src/orchestration/runs/run-schemas.ts:110 RunEventSchema.kind z.enum(...) omits
 * "aggregation_stalled" (the schema enum and the TS type have drifted). When
 * readRunEvents reads the line back, parseRunEvent -> RunEventSchema.safeParse
 * FAILS on the unknown kind, and the catch at runs.ts:294 SILENTLY DROPS the
 * line. Result: team_progress / team_result timelines lose the
 * stalled-recursion reason even though the event was correctly recorded.
 *
 * This test reproduces the round-trip exactly as production does:
 *   1. recordEvent(team, { kind: "aggregation_stalled", ... })  (same call as recurse.ts:178)
 *   2. wait for the fire-and-forget append to land in events.jsonl
 *   3. readRunEvents(team.directory, runId)
 *   4. assert the aggregation_stalled event survives the parse
 *
 * On UNFIXED code: step 2 confirms the line is on disk (recordEvent wrote it),
 * but step 4 returns an empty/missing result — the schema drops it -> FAILS
 * for the right reason. A control event of a known-good kind ("decomposed") is
 * also written and asserted present, proving readRunEvents itself works and the
 * drop is specific to the missing enum entry. On FIXED code (enum includes
 * "aggregation_stalled") both events are returned -> PASS.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { recordEvent } from "../src/orchestration/runs/events.js"
import { readRunEvents } from "../src/orchestration/runs/runs.js"
import { runEventsPath } from "../src/state/paths.js"
import { waitUntil } from "../src/core/utils.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { Team } from "../src/state/store.js"

describe("readRunEvents must not drop aggregation_stalled (finding: aggregation-stalled-event-dropped)", () => {
    test("an aggregation_stalled event written by recordEvent is returned by readRunEvents", async () => {
        const runId = crypto.randomUUID()
        const team = {
            deleted: false,
            directory: mkdtempSync(join(tmpdir(), "octeam-evt-stalled-")),
            activeTask: { runId },
            mutex: new AsyncMutex(),
        } as unknown as Team

        // Write events exactly as recurse.ts does (recordEvent is the single
        // write path used at recurse.ts:176 and recurse.ts:112).
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "decomposed", // control: a kind present in the schema enum
            member: "alice",
            detail: "root -> 2 @d1",
        })
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "aggregation_stalled", // the dropped kind (recurse.ts:178)
            member: "alice",
            detail: "root still pending after 3 aggregation dispatches",
        })

        // Wait for the fire-and-forget appends to land on disk (recordEvent is
        // async, not awaited at call sites). We confirm BOTH lines are present
        // in the raw file — proving recordEvent wrote the event — BEFORE
        // testing whether readRunEvents keeps it.
        const eventsFile = runEventsPath(team.directory, runId)
        await waitUntil(
            () =>
                existsSync(eventsFile)
                && readFileSync(eventsFile, "utf8").includes('"kind":"decomposed"')
                && readFileSync(eventsFile, "utf8").includes('"kind":"aggregation_stalled"'),
            { timeoutMs: 2000, pollMs: 10 },
        )

        const events = await readRunEvents(team.directory, runId)

        // Control: readRunEvents works — a known-good kind is returned.
        expect(events.some(e => e.kind === "decomposed")).toBe(true)

        // Contract under test: the aggregation_stalled event must survive the
        // schema parse. On the UNFIXED code the enum at runs.ts:110 omits this
        // kind, safeParse fails, and the line is silently dropped -> the find
        // returns false -> test FAILS for the right reason.
        const stalled = events.filter(e => e.kind === "aggregation_stalled")
        expect(stalled).toHaveLength(1)
        expect(stalled[0].member).toBe("alice")
        expect(stalled[0].detail).toBe("root still pending after 3 aggregation dispatches")
    })
})

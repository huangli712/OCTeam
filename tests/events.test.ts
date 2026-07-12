import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { recordEvent } from "../src/orchestration/runs/events.js"
import { readRunEvents } from "../src/orchestration/records/runs.js"
import { runEventsPath } from "../src/state/paths.js"
import { waitUntil } from "../src/core/utils.js"
import type { ActiveTask } from "../src/core/types.js"
import { __test__ as logTest, initLogger } from "../src/core/log.js"

import { makeCtx, makeTeam } from "./helpers.js"
function tmpTeamDir(): string {
    return mkdtempSync(join(tmpdir(), "octeam-events-"))
}


describe("recordEvent + readRunEvents", () => {
    test("path helper composes runs/<runId>/events.jsonl", () => {
        expect(runEventsPath("/team", "r1")).toBe("/team/runs/r1/events.jsonl")
    })

    test("appends one parseable JSON line per call", async () => {
        const dir = tmpTeamDir()
        const team = makeTeam({ directory: dir, activeTask: { type: "parallel", runId: "run-1", startedAt: 0, responses: {}, stages: [], currentStageIndex: 0 } as unknown as ActiveTask })
        recordEvent(team, { timestamp: 1, kind: "dispatched", member: "alice" })
        recordEvent(team, { timestamp: 2, kind: "captured", member: "alice", bytes: 100 })
        // recordEvent is fire-and-forget; wait for both appends to flush
        // (presence of the 2nd event guarantees the 1st is also on disk).
        await waitUntil(
            () => existsSync(runEventsPath(dir, "run-1"))
                && readFileSync(runEventsPath(dir, "run-1"), "utf8").includes('"kind":"captured"'),
            { timeoutMs: 2000, pollMs: 10 },
        )
        const events = await readRunEvents(dir, "run-1")
        expect(events).toHaveLength(2)
        expect(events[0].kind).toBe("dispatched")
        expect(events[1].bytes).toBe(100)
    })

    test("readRunEvents sorts by timestamp, not file order", async () => {
        const dir = tmpTeamDir()
        // write out-of-order on disk
        await fs.mkdir(join(dir, "runs", "r2"), { recursive: true })
        const path = runEventsPath(dir, "r2")
        await fs.writeFile(
            path,
            JSON.stringify({ timestamp: 30, kind: "round", round: 2 }) + "\n" +
            JSON.stringify({ timestamp: 10, kind: "dispatched", member: "a" }) + "\n" +
            JSON.stringify({ timestamp: 20, kind: "captured", member: "a" }) + "\n",
        )
        const events = await readRunEvents(dir, "r2")
        expect(events.map(e => e.timestamp)).toEqual([10, 20, 30])
    })

    test("readRunEvents skips malformed lines", async () => {
        const dir = tmpTeamDir()
        await fs.mkdir(join(dir, "runs", "r3"), { recursive: true })
        await fs.writeFile(
            runEventsPath(dir, "r3"),
            JSON.stringify({ timestamp: 1, kind: "dispatched" }) + "\n" +
            "{ this is not json\n" +
            JSON.stringify({ timestamp: 2, kind: "terminated", reason: "done" }) + "\n",
        )
        const events = await readRunEvents(dir, "r3")
        expect(events).toHaveLength(2)
        expect(events[1].kind).toBe("terminated")
    })

    test("readRunEvents returns [] when file absent", async () => {
        const dir = tmpTeamDir()
        expect(await readRunEvents(dir, "nope")).toEqual([])
    })

    test("recordEvent without runId is a no-op (no crash, no file)", async () => {
        const dir = tmpTeamDir()
        const team = makeTeam({ directory: dir })
        recordEvent(team, { timestamp: 1, kind: "dispatched", member: "alice" })
        // recordEvent is a synchronous no-op without an activeTask (no runId);
        // yield once to let pending tasks flush, then the runs directory must
        // not have been created.
        await new Promise(r => setImmediate(r))
        expect(fs.readdir(join(dir, "runs"))).rejects.toThrow()
    })
})

describe("recordEvent failure logging", () => {
beforeEach(() => logTest.resetState())
afterEach(() => logTest.resetState())

    test("logs warning when append fails (write failure visible to operators)", async () => {
        const dir = tmpTeamDir()
        // Block the runs/ directory path with a regular file so appendJsonl
        // fails (ENOTDIR when refuseSymlink lstats the nested path).
        writeFileSync(join(dir, "runs"), "not a directory")

        const cap: { body?: unknown } = {}
        initLogger(makeCtx({ overrides: { client: { app: { log: mock(async (args: unknown) => { cap.body = (args as { body?: unknown }).body; return { data: {} } }) } } } }))

        const team = makeTeam({ directory: dir, activeTask: { type: "parallel", runId: "run-err", startedAt: 0, responses: {}, stages: [], currentStageIndex: 0 } as unknown as ActiveTask })
        recordEvent(team, { timestamp: 1, kind: "dispatched", member: "alice" })

        // recordEvent is fire-and-forget; wait for the catch + logger.warn to fire.
        await waitUntil(
            () => cap.body !== undefined,
            { timeoutMs: 2000, pollMs: 10 },
        )

        const body = cap.body as { message: string; level: string; extra: { runId: string; eventKind: string; error: string } }
        expect(body.message).toBe("recordEvent append failed")
        expect(body.level).toBe("warn")
        expect(body.extra.runId).toBe("run-err")
        expect(body.extra.eventKind).toBe("dispatched")
        expect(body.extra.error).toBeDefined()
    })
})

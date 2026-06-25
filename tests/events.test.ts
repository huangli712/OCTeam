import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { recordEvent } from "../src/orchestration/events.js"
import { readRunEvents } from "../src/orchestration/runs.js"
import { runEventsPath } from "../src/state/paths.js"
import type { ActiveTask } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { AsyncMutex } from "../src/state/locks.js"

function tmpTeamDir(): string {
    return mkdtempSync(join(tmpdir(), "octeam-events-"))
}

function makeTeam(directory: string, runId?: string): Team {
    const task: ActiveTask | undefined = runId
        ? ({ type: "parallel", runId, startedAt: 0, responses: {}, stages: [], currentStageIndex: 0 } as unknown as ActiveTask)
        : undefined
    return {
        teamName: "t",
        activeTask: task,
        mutex: new AsyncMutex(),
        directory,
    } as unknown as Team
}

describe("recordEvent + readRunEvents", () => {
    test("path helper composes runs/<runId>/events.jsonl", () => {
        expect(runEventsPath("/team", "r1")).toBe("/team/runs/r1/events.jsonl")
    })

    test("appends one parseable JSON line per call", async () => {
        const dir = tmpTeamDir()
        const team = makeTeam(dir, "run-1")
        recordEvent(team, { timestamp: 1, kind: "dispatched", member: "alice" })
        recordEvent(team, { timestamp: 2, kind: "captured", member: "alice", bytes: 100 })
        // fire-and-forget: give the async appends a tick to flush
        await new Promise(r => setTimeout(r, 50))
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
        const team = makeTeam(dir) // no activeTask → no runId
        recordEvent(team, { timestamp: 1, kind: "dispatched", member: "alice" })
        await new Promise(r => setTimeout(r, 30))
        await expect(fs.readdir(join(dir, "runs"))).rejects.toThrow()
    })
})

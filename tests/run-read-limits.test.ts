import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { readRunEvents, readRunRecord } from "../src/orchestration/records/runs.js"
import { runEventsPath, runRecordPath } from "../src/state/paths.js"
import { cleanupTmpRoots, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
    try {
        await promise
    } catch (error) {
        return error instanceof Error ? error.message : String(error)
    }
    throw new Error("expected promise to reject")
}

describe("run record read limits", () => {
    test("readRunRecord rejects a record larger than 2 MiB", async () => {
        const teamDirectory = tmpRoot("run-record-cap")
        const runId = "oversized"
        const recordPath = runRecordPath(teamDirectory, runId)
        await fs.mkdir(path.dirname(recordPath), { recursive: true })
        await fs.writeFile(recordPath, JSON.stringify({
            version: 1,
            runId,
            teamRunId: "team-run",
            teamName: "alpha",
            type: "parallel",
            status: "completed",
            reason: "done",
            startedAt: 0,
            finishedAt: 1,
            tokensUsed: 0,
            tokensByMember: {},
            messagesSent: 0,
            memberOutputs: {},
            padding: "x".repeat(2 * 1024 * 1024),
        }))

        expect(await rejectionMessage(readRunRecord(teamDirectory, runId))).toMatch(/2097152-byte cap/)
    })

    test("readRunEvents skips a line larger than 1 MiB and keeps later events", async () => {
        const teamDirectory = tmpRoot("run-event-line-cap")
        const runId = "oversized-line"
        const eventsPath = runEventsPath(teamDirectory, runId)
        await fs.mkdir(path.dirname(eventsPath), { recursive: true })
        const oversized = JSON.stringify({
            timestamp: 1,
            kind: "dispatched",
            member: "oversized",
            padding: "x".repeat(1_048_577),
        })
        const valid = JSON.stringify({ timestamp: 2, kind: "dispatched", member: "valid" })
        await fs.writeFile(eventsPath, `${oversized}\n${valid}\n`)

        const events = await readRunEvents(teamDirectory, runId)
        expect(events.map(event => event.member)).toEqual(["valid"])
    })
})

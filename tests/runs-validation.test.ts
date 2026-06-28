/**
 * Regression tests for runs.ts zod validation (H3 / Rank 8 minimal scope).
 *
 * Before the fix, run records were read via bare `JSON.parse(raw) as RunRecord`
 * with no schema check — a structurally-invalid-but-parseable record flowed
 * downstream as a valid RunRecord and caused silent runtime type errors. Now
 * parseRunRecord/parseRunEvent validate via zod safeParse; a bad record is
 * treated the same as corrupt JSON (skipped, returns null/[]).
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { cleanupTmpRoots, tmpRoot } from "./helpers.js"
import { listRunRecords, readRunRecord } from "../src/orchestration/runs.js"

afterAll(cleanupTmpRoots)

/** A minimal valid RunRecord matching RunRecordSchema (src/orchestration/runs.ts). */
function validRecord(runId: string, finishedAt: number): string {
    return JSON.stringify({
        version: 1,
        runId,
        teamRunId: "team-run-1",
        teamName: "test-team",
        type: "parallel",
        reason: "complete",
        status: "completed",
        startedAt: 1000,
        finishedAt,
        tokensUsed: 100,
        tokensByMember: {},
        messagesSent: 5,
        memberOutputs: {},
    })
}

/** Write a record.json payload for <teamDir>/runs/<runId>/record.json. */
function writeRecord(teamDir: string, runId: string, payload: string): void {
    const dir = path.join(teamDir, "runs", runId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "record.json"), payload, "utf8")
}

describe("runs.ts zod validation (H3)", () => {
    it("readRunRecord returns the parsed object for a well-formed record", async () => {
        const root = tmpRoot("runs-valid")
        writeRecord(root, "run-good", validRecord("run-good", 5000))
        const rec = await readRunRecord(root, "run-good")
        expect(rec).not.toBeNull()
        expect(rec?.runId).toBe("run-good")
        expect(rec?.type).toBe("parallel")
        expect(rec?.status).toBe("completed")
    })

    it("readRunRecord returns null for a structurally-invalid record (wrong shape)", async () => {
        const root = tmpRoot("runs-bad-shape")
        // Valid JSON, but missing required fields (no version, runId, type, etc.).
        writeRecord(root, "run-bad", JSON.stringify({ random: "garbage" }))
        const rec = await readRunRecord(root, "run-bad")
        expect(rec).toBeNull()
    })

    it("readRunRecord returns null for corrupt (unparseable) JSON", async () => {
        const root = tmpRoot("runs-corrupt")
        writeRecord(root, "run-corrupt", "{not valid json!!!")
        const rec = await readRunRecord(root, "run-corrupt")
        expect(rec).toBeNull()
    })

    it("readRunRecord returns null for an absent run", async () => {
        const root = tmpRoot("runs-absent")
        const rec = await readRunRecord(root, "never-existed")
        expect(rec).toBeNull()
    })

    it("listRunRecords skips corrupt/invalid runs and returns only valid ones (newest-first)", async () => {
        const root = tmpRoot("runs-mixed")
        writeRecord(root, "run-a", validRecord("run-a", 1000))
        writeRecord(root, "run-b", JSON.stringify({ broken: true }))
        writeRecord(root, "run-c", validRecord("run-c", 3000))
        writeRecord(root, "run-d", "!!!corrupt!!!")

        const recs = await listRunRecords(root)
        // Only the two valid records survive; sorted newest-first by finishedAt.
        expect(recs).toHaveLength(2)
        expect(recs[0].runId).toBe("run-c") // finishedAt 3000 > 1000
        expect(recs[1].runId).toBe("run-a")
    })
})

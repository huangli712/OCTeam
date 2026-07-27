/**
 * C-2 regression: events.ts appendJsonl, capture.ts readFile, and runs.ts
 * readdir/readFile/rm must all reject when the target path or an ancestor
 * is a symlink that escapes the team directory. Without the trustedRoot
 * parameter / assertNoSymlinkTraversal guard, a symlinked runs/ or
 * runs/<runId>/ can redirect observability events and read/delete operations
 * to an attacker-controlled location outside the team root.
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { recordEvent } from "../src/orchestration/records/events.js"
import { captureMemberOutput } from "../src/orchestration/records/capture.js"
import { listRunRecords, pruneRuns, readRunEvents, readRunRecord } from "../src/orchestration/records/runs.js"
import { runEventsPath, runMemberOutputPath, runsDir } from "../src/state/paths.js"
import { waitUntil } from "../src/core/utils.js"
import { cleanupTmpRoots, makeCtx, makeTeam, tmpRoot } from "./helpers.js"
import type { ActiveTask, SdkMessage } from "../src/core/types.js"
import { initLogger, __test__ as logTest } from "../src/core/log.js"

afterAll(cleanupTmpRoots)

describe("records symlink traversal (C-2)", () => {
    test("recordEvent rejects when runs/ is a symlink to outside team dir", async () => {
        const dir = tmpRoot("c2-events")
        const outside = tmpRoot("c2-events-outside")
        // <dir>/runs -> outside
        symlinkSync(outside, runsDir(dir))
        const task = { type: "parallel", runId: "r1", startedAt: 0, responses: {}, stages: [], currentStageIndex: 0 } as unknown as ActiveTask
        const team = makeTeam({ directory: dir, activeTask: task })
        // recordEvent is fire-and-forget; the rejected promise only surfaces
        // through the warn logger. The key assertion: no event file is created
        // in the outside redirect target.
        recordEvent(team, { timestamp: 1, kind: "dispatched", member: "alice" })
        // Yield long enough for the async append to attempt and fail.
        await new Promise(r => setTimeout(r, 100))
        expect(existsSync(path.join(outside, "r1", "events.jsonl"))).toBe(false)
    })

    test("readRunEvents rejects when events file is a symlink", async () => {
        const dir = tmpRoot("c2-read-events")
        const outside = tmpRoot("c2-read-events-outside")
        mkdirSync(path.join(dir, "runs", "r1"), { recursive: true })
        const outsideFile = path.join(outside, "evil.jsonl")
        writeFileSync(outsideFile, JSON.stringify({ timestamp: 1, kind: "dispatched" }) + "\n")
        // <dir>/runs/r1/events.jsonl -> outside/evil.jsonl
        symlinkSync(outsideFile, runEventsPath(dir, "r1"))
        await expect(readRunEvents(dir, "r1")).rejects.toThrow(/symlink/i)
    })

    test("readRunRecord rejects when record.json is a symlink", async () => {
        const dir = tmpRoot("c2-read-record")
        const outside = tmpRoot("c2-read-record-outside")
        mkdirSync(path.join(dir, "runs", "r1"), { recursive: true })
        const outsideFile = path.join(outside, "evil.json")
        writeFileSync(outsideFile, JSON.stringify({ runId: "r1", teamName: "t", status: "completed", reason: "done", startedAt: 0, finishedAt: 1, steps: [] }))
        symlinkSync(outsideFile, path.join(dir, "runs", "r1", "record.json"))
        await expect(readRunRecord(dir, "r1")).rejects.toThrow(/symlink/i)
    })

    test("listRunRecords rejects when runs/ is a symlink", async () => {
        const dir = tmpRoot("c2-list")
        const outside = tmpRoot("c2-list-outside")
        mkdirSync(outside, { recursive: true })
        // Pre-create one fake run dir on the outside so readdir succeeds.
        mkdirSync(path.join(outside, "r1"), { recursive: true })
        symlinkSync(outside, runsDir(dir))
        await expect(listRunRecords(dir)).rejects.toThrow(/symlink/i)
    })

    test("pruneRuns rejects when runs/ is a symlink (no destructive ops reach outside)", async () => {
        const dir = tmpRoot("c2-prune")
        const outside = tmpRoot("c2-prune-outside")
        // Pre-populate outside with what looks like runs to confirm pruneRuns
        // refuses BEFORE any rm fires.
        mkdirSync(path.join(outside, "victim"), { recursive: true })
        writeFileSync(path.join(outside, "victim", "marker.txt"), "preserve me")
        symlinkSync(outside, runsDir(dir))
        await expect(pruneRuns(dir, 0)).rejects.toThrow(/symlink/i)
        // Crucially the outside directory tree must be untouched.
        expect(existsSync(path.join(outside, "victim", "marker.txt"))).toBe(true)
    })

    test("captureMemberOutput rejects when member output path is a symlink", async () => {
        const dir = tmpRoot("c2-capture")
        const outside = tmpRoot("c2-capture-outside")
        const task = { type: "parallel", runId: "r1", startedAt: 0, responses: {}, stages: [], currentStageIndex: 0 } as unknown as ActiveTask
        const team = makeTeam({ directory: dir, activeTask: task, members: [{ name: "alice", status: "idle", initialized: true, turnCount: 0 }] })
        // Pre-create runs/r1 dir, then symlink the alice.md target.
        mkdirSync(path.join(dir, "runs", "r1"), { recursive: true })
        const outsideFile = path.join(outside, "leak.md")
        writeFileSync(outsideFile, "leaked-before")
        symlinkSync(outsideFile, runMemberOutputPath(dir, "r1", "alice"))

        const messages: SdkMessage[] = [
            { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
            { info: { role: "assistant" }, parts: [{ type: "text", text: "hello world this is a real turn output" }] },
        ] as unknown as SdkMessage[]

        await expect(captureMemberOutput(team, team.members[0]!, messages)).rejects.toThrow(/symlink/i)
        // Output file outside must be untouched.
        const { readFileSync } = await import("node:fs")
        expect(readFileSync(outsideFile, "utf8")).toBe("leaked-before")
    })

    test("happy path: still writes when no symlinks are present", async () => {
        const dir = tmpRoot("c2-clean")
        const task = { type: "parallel", runId: "rh", startedAt: 0, responses: {}, stages: [], currentStageIndex: 0 } as unknown as ActiveTask
        const team = makeTeam({ directory: dir, activeTask: task })
        recordEvent(team, { timestamp: 1, kind: "dispatched", member: "alice" })
        await waitUntil(
            () => existsSync(runEventsPath(dir, "rh")),
            { timeoutMs: 2000, pollMs: 10 },
        )
        const events = await readRunEvents(dir, "rh")
        expect(events).toHaveLength(1)
        expect(events[0].kind).toBe("dispatched")
    })
})

// Suppress the warn log from the recordEvent test so it does not pollute output.
initLogger(makeCtx({ overrides: { client: { app: { log: async () => ({ data: {} }) } } } }))
void logTest

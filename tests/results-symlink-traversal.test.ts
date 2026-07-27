/**
 * C-4 regression: team_result_get and team_results read member output files
 * via fs.readFile, which follows symlinks. A member with FS write access
 * could replace runs/<runId>/<member>.md with a symlink to an arbitrary file
 * and have its contents returned through the tool. The fix wraps each read
 * with assertNoSymlinkTraversal(teamDir, target) so any symlink in the target
 * chain is rejected.
 */
import fs from "node:fs/promises"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import type { RunRecord } from "../src/core/types.js"
import { teamResultGetTool, teamResultsTool } from "../src/tools/query/results.js"
import { runDir, runMemberOutputPath, runRecordPath, teamDir } from "../src/state/paths.js"
import { initTeamState, invalidateTeam } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeToolContext, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)
const trackedSessions: string[] = []
const trackedDirs: string[] = []
afterEach(() => {
    for (const sid of trackedSessions.splice(0)) unindexSession(sid)
    for (const dir of trackedDirs.splice(0)) invalidateTeam(dir)
})

async function setupTeam(root: string, sid: string, memberSid: string) {
    const state = makeState("alpha", sid, [makeMember("alice", memberSid)], Date.now())
    const team = await initTeamState(root, state, sid)
    await rebuildSessionIndex(root, `${root}__user_unused`)
    return team
}

async function writeRunRecord(teamDirectory: string, runId: string, memberOutputs: Record<string, { bytes: number; file: string }>): Promise<void> {
    const dir = runDir(teamDirectory, runId)
    await fs.mkdir(dir, { recursive: true })
    const record: RunRecord = {
        version: 1,
        runId,
        teamRunId: `run-alpha-${runId}`,
        teamName: "alpha",
        type: "parallel",
        mode: "isolated",
        status: "completed",
        reason: "completed",
        startedAt: 1,
        finishedAt: 2,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        memberOutputs,
    } as unknown as RunRecord
    await fs.writeFile(runRecordPath(teamDirectory, runId), JSON.stringify(record, null, 2), "utf8")
}

describe("team_result_get symlink traversal (C-4)", () => {
    test("rejects when member output is a symlink to outside team dir", async () => {
        const root = tmpRoot("c4-get")
        const sid = "ses_c4_get"
        const memberSid = "ses_c4_get_alice"
        const team = await setupTeam(root, sid, memberSid)
        trackedDirs.push(team.directory); trackedSessions.push(sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)

        const outside = tmpRoot("c4-get-outside")
        const outsideFile = path.join(outside, "secret.md")
        writeFileSync(outsideFile, "TOP SECRET")

        const target = runMemberOutputPath(tdir, "r1", "alice")
        mkdirSync(path.dirname(target), { recursive: true })
        symlinkSync(outsideFile, target)
        await writeRunRecord(tdir, "r1", { alice: { bytes: 100, file: "alice.md" } })

        const result = await teamResultGetTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "r1", member: "alice" },
            makeToolContext(memberSid),
        )
        expect(result).not.toContain("TOP SECRET")
        expect(result).toMatch(/error|symlink/i)
    })

    test("happy path: real member output file is returned", async () => {
        const root = tmpRoot("c4-clean")
        const sid = "ses_c4_clean"
        const memberSid = "ses_c4_clean_alice"
        const team = await setupTeam(root, sid, memberSid)
        trackedDirs.push(team.directory); trackedSessions.push(sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)

        const target = runMemberOutputPath(tdir, "r2", "alice")
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, "hello world")
        await writeRunRecord(tdir, "r2", { alice: { bytes: 11, file: "alice.md" } })

        const result = await teamResultGetTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "r2", member: "alice" },
            makeToolContext(memberSid),
        )
        expect(result).toContain("hello world")
    })
})

describe("team_results symlink traversal (C-4)", () => {
    test("rejects symlinked member outputs in batch preview", async () => {
        const root = tmpRoot("c4-batch")
        const sid = "ses_c4_batch"
        const memberSid = "ses_c4_batch_alice"
        const team = await setupTeam(root, sid, memberSid)
        trackedDirs.push(team.directory); trackedSessions.push(sid, memberSid)
        const tdir = teamDir(root, "alpha", sid)

        const outside = tmpRoot("c4-batch-outside")
        const outsideFile = path.join(outside, "secret.md")
        writeFileSync(outsideFile, "BATCH SECRET")
        const target = runMemberOutputPath(tdir, "r3", "alice")
        mkdirSync(path.dirname(target), { recursive: true })
        symlinkSync(outsideFile, target)
        await writeRunRecord(tdir, "r3", { alice: { bytes: 100, file: "alice.md" } })

        const result = await teamResultsTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(memberSid),
        )
        expect(result).not.toContain("BATCH SECRET")
    })
})

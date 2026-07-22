import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import fs from "node:fs/promises"

import type { TeamSpec } from "../src/core/types.js"
import { teamRunDirTool } from "../src/tools/query/rundir.js"
import { initTeamState, writeTeamSpec } from "../src/state/store.js"
import { teamDir, runDir, runMemberOutputPath } from "../src/state/paths.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { persistRun } from "../src/orchestration/records/runs.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeTask, makeTeam, makeToolContext, tmpRoot } from './helpers.js';

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})
afterAll(cleanupTmpRoots)

async function setupTeam(
    root: string,
    sid: string,
    opts: { members?: ReturnType<typeof makeMember>[]; activatedAt?: number } = {},
): Promise<void> {
    const members = opts.members ?? [makeMember("alice")]
    await initTeamState(root, makeState("alpha", sid, members, opts.activatedAt), sid)
    const spec: TeamSpec = {
        version: 1,
        name: "alpha",
        createdAt: Date.now(),
        members: members.map(m => ({
            name: m.name,
            role: "coder",
            prompt: "write code",
            agent: "build",
            model: m.model,
        })),
    }
    await writeTeamSpec(root, spec, sid)
    await rebuildSessionIndex(root, `${root}__unused`)
}

/** Stage a fake run: create runs/<runId>/ + a member .md + persist record.json. */
async function stageRun(teamDirectory: string, runId: string): Promise<void> {
    await fs.mkdir(runDir(teamDirectory, runId), { recursive: true })
    await fs.writeFile(runMemberOutputPath(teamDirectory, runId, "alice"), "output")
    const team = makeTeam({
        directory: teamDirectory,
        activeTask: makeTask({ runId, type: "parallel", mode: "isolated" }),
    })
    await persistRun(team, "parallel_isolated_complete")
}

describe("team_run_dir tool", () => {
    test("caller not a member → error", async () => {
        const root = tmpRoot("rundir-404")
        const result = await teamRunDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "nonexistent" },
            makeToolContext("ses_x"),
        )
        expect(result).toContain("Error")
        expect(result).toContain("not a member")
    })

    test("no runs yet → informative message", async () => {
        const root = tmpRoot("rundir-empty")
        const sid = "ses_rundir_empty"
        tracked.push(sid)
        await setupTeam(root, sid, { activatedAt: Date.now() })
        const result = await teamRunDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(result).toContain("No run records")
    })

    test("latest run (omit run_id) → returns absolute path with runId", async () => {
        const root = tmpRoot("rundir-latest")
        const sid = "ses_rundir_latest"
        tracked.push(sid)
        await setupTeam(root, sid, { activatedAt: Date.now() })
        const teamDirectory = teamDir(root, "alpha", sid)
        await stageRun(teamDirectory, "run-A")

        const result = await teamRunDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(result).toContain("run_id: run-A")
        expect(result).toContain("run_dir:")
        // Path must be the resolved absolute run directory.
        const expectedAbs = runDir(teamDirectory, "run-A")
        expect(result).toContain(expectedAbs)
    })

    test("specific run_id → returns that run's path", async () => {
        const root = tmpRoot("rundir-specific")
        const sid = "ses_rundir_specific"
        tracked.push(sid)
        await setupTeam(root, sid, { activatedAt: Date.now() })
        const teamDirectory = teamDir(root, "alpha", sid)
        await stageRun(teamDirectory, "run-first")
        await stageRun(teamDirectory, "run-second")

        // Explicit run_id for the older run (not the latest).
        const result = await teamRunDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "run-first" },
            makeToolContext(sid),
        )
        expect(result).toContain("run_id: run-first")
        expect(result).toContain(runDir(teamDirectory, "run-first"))
    })

    test("nonexistent run_id → error", async () => {
        const root = tmpRoot("rundir-missing")
        const sid = "ses_rundir_missing"
        tracked.push(sid)
        await setupTeam(root, sid, { activatedAt: Date.now() })

        const result = await teamRunDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "never-existed" },
            makeToolContext(sid),
        )
        expect(result).toContain("Error")
        expect(result).toContain("not found")
    })

    test("unsafe run_id (path traversal) → rejected", async () => {
        const root = tmpRoot("rundir-traversal")
        const sid = "ses_rundir_traversal"
        tracked.push(sid)
        await setupTeam(root, sid, { activatedAt: Date.now() })

        const result = await teamRunDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", run_id: "../../../etc/passwd" },
            makeToolContext(sid),
        )
        expect(result).toContain("Error")
        expect(result).toContain("invalid run_id")
    })
})

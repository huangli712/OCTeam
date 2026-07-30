import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"

import type { TeamSpec } from "../src/core/types.js"
import { teamMetricsTool } from "../src/tools/query/metrics.js"
import { teamProgressTool } from "../src/tools/query/progress.js"
import { teamQueryTool } from "../src/tools/query/inspect.js"
import { teamResultsTool } from "../src/tools/query/results.js"
import { teamRootDirTool } from "../src/tools/query/rootdir.js"
import { teamRunDirTool } from "../src/tools/query/rundir.js"
import { runsDir } from "../src/state/paths.js"
import { initTeamState, writeTeamSpec } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import {
    cleanupTmpRoots,
    makeCtx,
    makeMember,
    makeState,
    makeToolContext,
    tmpRoot,
} from "./helpers.js"

const trackedSessions: string[] = []

afterEach(() => {
    for (const sessionId of trackedSessions.splice(0)) unindexSession(sessionId)
})
afterAll(cleanupTmpRoots)

async function setupTeam(root: string, sessionId: string): Promise<string> {
    const member = makeMember("alice")
    const team = await initTeamState(root, makeState("alpha", sessionId, [member], Date.now()), sessionId)
    const spec: TeamSpec = {
        version: 1,
        name: "alpha",
        createdAt: Date.now(),
        members: [{ name: "alice", role: "coder", prompt: "work", agent: "build" }],
    }
    await writeTeamSpec(root, spec, sessionId)
    await rebuildSessionIndex(root, `${root}__user_unused`)
    trackedSessions.push(sessionId)
    return team.directory
}

async function replaceRunsDirectoryWithFile(teamDirectory: string): Promise<void> {
    await fs.writeFile(runsDir(teamDirectory), "not a directory")
}

describe("query tools expose non-ENOENT storage errors", () => {
    test("team_results reports an unreadable runs directory", async () => {
        const root = tmpRoot("query-io-results")
        const sessionId = "ses_query_io_results"
        const teamDirectory = await setupTeam(root, sessionId)
        await replaceRunsDirectoryWithFile(teamDirectory)

        const result = await teamResultsTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sessionId),
        )

        expect(result).toContain("Error")
    })

    test("team_metrics reports an unreadable runs directory", async () => {
        const root = tmpRoot("query-io-metrics")
        const sessionId = "ses_query_io_metrics"
        const teamDirectory = await setupTeam(root, sessionId)
        await replaceRunsDirectoryWithFile(teamDirectory)

        const result = await teamMetricsTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sessionId),
        )

        expect(result).toContain("Error")
    })

    test("team_progress reports an unreadable runs directory", async () => {
        const root = tmpRoot("query-io-progress")
        const sessionId = "ses_query_io_progress"
        const teamDirectory = await setupTeam(root, sessionId)
        await replaceRunsDirectoryWithFile(teamDirectory)

        const result = await teamProgressTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sessionId),
        )

        expect(result).toContain("Error")
    })

    test("team_run_dir reports an unreadable runs directory", async () => {
        const root = tmpRoot("query-io-rundir")
        const sessionId = "ses_query_io_rundir"
        const teamDirectory = await setupTeam(root, sessionId)
        await replaceRunsDirectoryWithFile(teamDirectory)

        const result = await teamRunDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sessionId),
        )

        expect(result).toContain("Error")
    })

    test("team_query reports a non-ENOENT config read failure", async () => {
        const root = tmpRoot("query-io-inspect")
        const sessionId = "ses_query_io_inspect"
        const teamDirectory = await setupTeam(root, sessionId)
        await fs.rm(teamDirectory, { recursive: true })
        await fs.writeFile(teamDirectory, "not a directory")

        const result = await teamQueryTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha", member_name: "alice" },
            makeToolContext(sessionId),
        )

        expect(result).toContain("Error")
    })

    test("team_root_dir reports a non-ENOENT directory read failure", async () => {
        const root = tmpRoot("query-io-rootdir")
        const sessionId = "ses_query_io_rootdir"
        const teamDirectory = await setupTeam(root, sessionId)
        await fs.rm(teamDirectory, { recursive: true })
        await fs.writeFile(teamDirectory, "not a directory")

        const result = await teamRootDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sessionId),
        )

        expect(result).toContain("Error")
    })
})

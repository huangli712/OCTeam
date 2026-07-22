/**
 * Coverage tests for teamRootDirTool (src/tools/query/rootdir.ts).
 *
 * Mirrors the structure of rundir.test.ts. The critical difference from
 * team_run_dir -- this tool must work whether or not the team is busy and
 * whether or not any run has ever been persisted -- is asserted explicitly
 * in the "busy team" and "team just created" cases.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"

import type { TeamSpec } from "../src/core/types.js"
import { teamRootDirTool } from "../src/tools/query/rootdir.js"
import { teamRunDirTool } from "../src/tools/query/rundir.js"
import { initTeamState, writeTeamSpec } from "../src/state/store.js"
import { teamDir } from "../src/state/paths.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeTask, makeToolContext, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)
const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

async function setupTeam(
    root: string,
    sid: string | undefined,
    opts: {
        name?: string
        members?: ReturnType<typeof makeMember>[]
        activatedAt?: number
        /** master sessionID stored in state.leadSessionId (defaults to sid, or a fixed value for user scope). */
        masterSid?: string
    } = {},
): Promise<void> {
    const name = opts.name ?? "alpha"
    const members = opts.members ?? [makeMember("alice")]
    // user scope: third arg undefined (path computed as <root>/teams/<name>)
    // project scope: third arg = sid (path computed as <root>/<sid>/teams/<name>)
    // state.leadSessionId is always a string (used for in-memory master index);
    // the third arg is what selects flat vs segmented placement.
    const masterSid = opts.masterSid ?? sid ?? "ses_user_master_unused"
    await initTeamState(root, makeState(name, masterSid, members, opts.activatedAt), sid)
    const spec: TeamSpec = {
        version: 1,
        name,
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
    // rebuildSessionIndex(projectRoot, userRoot): when sid is undefined we want
    // this team to be found in the USER scope, so root goes second.
    if (sid === undefined) {
        await rebuildSessionIndex(`${root}__unused`, root)
    } else {
        await rebuildSessionIndex(root, `${root}__unused`)
    }
}

describe("team_root_dir tool", () => {
    test("caller not a member -> error", async () => {
        const root = tmpRoot("rootdir-404")
        const result = await teamRootDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "nonexistent" },
            makeToolContext("ses_x"),
        )
        expect(result).toContain("Error")
        expect(result).toContain("not a member")
    })

    test("team just created (no runs) -> returns root path with config.json + state.json entries", async () => {
        const root = tmpRoot("rootdir-fresh")
        const sid = "ses_rootdir_fresh"
        tracked.push(sid)
        await setupTeam(root, sid, { activatedAt: Date.now() })

        const result = await teamRootDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        const expectedAbs = teamDir(root, "alpha", sid)
        expect(result).toContain(`team_root_dir: ${expectedAbs}`)
        expect(result).toContain("entries:")
        expect(result).toContain("config.json")
        expect(result).toContain("state.json")
    })

    test("project scope (with leadSessionId) -> path includes <root>/<sid>/teams/<name>", async () => {
        const root = tmpRoot("rootdir-project")
        const sid = "ses_rootdir_project"
        tracked.push(sid)
        await setupTeam(root, sid, { name: "beta", activatedAt: Date.now() })

        const result = await teamRootDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "beta" },
            makeToolContext(sid),
        )
        expect(result).toContain(teamDir(root, "beta", sid))
        expect(result).toContain(`/${sid}/teams/beta`)
    })

    test("user scope (no leadSessionId) -> path is <root>/teams/<name>", async () => {
        const root = tmpRoot("rootdir-user")
        const masterSid = "ses_user_master"
        tracked.push(masterSid)
        await setupTeam(root, undefined, { name: "gamma", activatedAt: Date.now(), masterSid })

        const result = await teamRootDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "gamma" },
            makeToolContext(masterSid),
        )
        expect(result).toContain(teamDir(root, "gamma", undefined))
        // user scope never embeds a session segment: the masterSid must NOT
        // appear as a path component before "teams".
        expect(result).not.toContain(`/${masterSid}/teams/`)
    })

    test("with runs/ subdirectory -> entries contains runs", async () => {
        const root = tmpRoot("rootdir-with-runs")
        const sid = "ses_rootdir_runs"
        tracked.push(sid)
        await setupTeam(root, sid, { activatedAt: Date.now() })
        const dir = teamDir(root, "alpha", sid)
        await fs.mkdir(`${dir}/runs/some-run-id`, { recursive: true })

        const result = await teamRootDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        // entries is comma-separated; match runs as a whole token
        expect(result).toMatch(/\bentries:.*\bruns\b/)
    })

    test("busy team (activeTask, not yet persisted) -> still returns root dir (vs team_run_dir fails)", async () => {
        const root = tmpRoot("rootdir-busy")
        const sid = "ses_rootdir_busy"
        tracked.push(sid)
        // Construct a busy team whose activeTask exists but no record.json
        // has been written yet -- this is exactly the gap team_root_dir fills.
        const members = [makeMember("alice")]
        const base = makeState("delta", sid, members, Date.now())
        const state = {
            ...base,
            status: "busy" as const,
            activeTask: makeTask({ runId: "run-in-flight", type: "parallel", mode: "isolated" }),
        }
        await initTeamState(root, state, sid)
        const spec: TeamSpec = {
            version: 1,
            name: "delta",
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

        const rootResult = await teamRootDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "delta" },
            makeToolContext(sid),
        )
        expect(rootResult).toContain(`team_root_dir: ${teamDir(root, "delta", sid)}`)

        // Contrast: team_run_dir cannot locate the in-flight run.
        const runResult = await teamRunDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "delta" },
            makeToolContext(sid),
        )
        expect(runResult).toContain("No run records")
    })

    test("multiple teams under same root -> returns the requested team's dir, not a sibling's", async () => {
        const root = tmpRoot("rootdir-multi")
        const sid = "ses_rootdir_multi"
        tracked.push(sid)
        await setupTeam(root, sid, { name: "team-one", activatedAt: Date.now() })
        await setupTeam(root, sid, { name: "team-two", activatedAt: Date.now() })

        const r1 = await teamRootDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "team-one" },
            makeToolContext(sid),
        )
        const r2 = await teamRootDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "team-two" },
            makeToolContext(sid),
        )
        expect(r1).toContain(`/teams/team-one`)
        expect(r1).not.toContain(`/teams/team-two`)
        expect(r2).toContain(`/teams/team-two`)
        expect(r2).not.toContain(`/teams/team-one`)
    })

    test("master inactive (not activated) -> still works (requireActive: false)", async () => {
        const root = tmpRoot("rootdir-inactive")
        const sid = "ses_rootdir_inactive"
        tracked.push(sid)
        // activatedAt: 0 -> not activated; resolveCallerInTeam must still admit us
        await setupTeam(root, sid, { activatedAt: 0 })

        const result = await teamRootDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(result).toContain(`team_root_dir: ${teamDir(root, "alpha", sid)}`)
    })

    test("directory deleted from disk (ENOENT) -> surfaces warning, still returns resolved path", async () => {
        const root = tmpRoot("rootdir-deleted")
        const sid = "ses_rootdir_deleted"
        tracked.push(sid)
        await setupTeam(root, sid, { activatedAt: Date.now() })
        const dir = teamDir(root, "alpha", sid)
        await fs.rm(dir, { recursive: true, force: true })

        const result = await teamRootDirTool(makeCtx({ storageRoot: root })).execute(
            { team_id: "alpha" },
            makeToolContext(sid),
        )
        expect(result).toContain(`team_root_dir: ${dir}`)
        expect(result).toContain("warning: directory does not exist on disk")
        // entries line must NOT be present when the directory is gone
        expect(result).not.toContain("entries:")
    })
})

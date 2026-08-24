/**
 * Regression tests for team_activate's sibling-scan residue handling.
 *
 * Root cause (r1 incident): team_delete's teardown raced a member session's
 * late write into the just-deleted team directory, recreating a bare shell
 * (no state.json / config.json / master.sentinel, but the leftover
 * <name>.deleted marker next to it). The sibling scan treated the unreadable
 * shell as a fail-closed condition and refused every subsequent
 * team_activate in the session until the shell was removed by hand.
 *
 * Fix: when a sibling's state.json fails to load with ENOENT, fingerprint the
 * directory (deletion marker present as a regular file + all three identity
 * files absent) and skip it for the active-team check. Everything else still
 * fails closed, including a cached Team served with _stateUnreadable.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import type { MemberState, TeamState } from "../src/core/types.js"
import { teamActivateTool } from "../src/tools/lifecycle/activate.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { unindexSession } from "../src/state/resolve.js"
import { deletedMarkerPath, teamDir } from "../src/state/paths.js"
import { cleanupTmpRoots, makeCtx, makeState, makeToolContext, tmpRoot } from "./helpers.js"

const TEAM = "target-team"

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})
afterAll(cleanupTmpRoots)

async function setupTeam(root: string, masterSid: string, members: MemberState[] = []): Promise<TeamState> {
    const state = makeState(TEAM, masterSid, members)
    await initTeamState(root, state, masterSid)
    return state
}

/** Create a bare-shell sibling directory containing only stray junk files. */
async function makeSiblingDir(root: string, masterSid: string, name: string): Promise<string> {
    const dir = teamDir(root, name, masterSid)
    await fs.mkdir(path.join(dir, ".omo"), { recursive: true })
    await fs.writeFile(path.join(dir, ".omo", "run-continuation"), "{}\n", "utf8")
    return dir
}

/** Write the <name>.deleted deletion marker next to the sibling directory. */
async function makeMarker(root: string, masterSid: string, name: string): Promise<string> {
    const marker = deletedMarkerPath(teamDir(root, name, masterSid))
    await fs.writeFile(marker, "run-old-generation\n", "utf8")
    return marker
}

async function activate(root: string, teamId: string, masterSid: string): Promise<string> {
    return await teamActivateTool(makeCtx({ storageRoot: root, promptAsync: async () => ({}) })).execute(
        { team_id: teamId },
        makeToolContext(masterSid),
    )
}

describe("teamActivateTool sibling residue handling", () => {
    test("tombstoned bare shell (marker + no identity files) is ignored; activation succeeds", async () => {
        const root = tmpRoot("act-residue-ok")
        const masterSid = "ses_res_master_1"
        tracked.push(masterSid)
        await setupTeam(root, masterSid)
        await makeSiblingDir(root, masterSid, "deleted-shell")
        await makeMarker(root, masterSid, "deleted-shell")

        const result = await activate(root, TEAM, masterSid)
        expect(result).toContain("activated")
    })

    test("no deletion marker next to the unreadable sibling → refuses (fail-closed)", async () => {
        const root = tmpRoot("act-residue-nomarker")
        const masterSid = "ses_res_master_2"
        tracked.push(masterSid)
        await setupTeam(root, masterSid)
        await makeSiblingDir(root, masterSid, "orphan-shell")

        const result = await activate(root, TEAM, masterSid)
        expect(result).toContain("cannot verify sibling team states")
    })

    test("deletion marker is a directory → refuses (marker must be a regular file)", async () => {
        const root = tmpRoot("act-residue-dir-marker")
        const masterSid = "ses_res_master_3"
        tracked.push(masterSid)
        await setupTeam(root, masterSid)
        await makeSiblingDir(root, masterSid, "dir-marker-shell")
        await fs.mkdir(deletedMarkerPath(teamDir(root, "dir-marker-shell", masterSid)), { recursive: true })

        const result = await activate(root, TEAM, masterSid)
        expect(result).toContain("cannot verify sibling team states")
    })

    test("deletion marker is a symlink → refuses (lstat must see a regular file)", async () => {
        const root = tmpRoot("act-residue-symlink-marker")
        const masterSid = "ses_res_master_4"
        tracked.push(masterSid)
        await setupTeam(root, masterSid)
        await makeSiblingDir(root, masterSid, "symlink-marker-shell")
        // Dangling symlink: lstat still succeeds and reports a symlink, so
        // the isFile() check must reject it.
        await fs.symlink(
            "/nonexistent-marker-target",
            deletedMarkerPath(teamDir(root, "symlink-marker-shell", masterSid)),
        )

        const result = await activate(root, TEAM, masterSid)
        expect(result).toContain("cannot verify sibling team states")
    })

    test("identity file present (config.json) alongside marker → refuses", async () => {
        const root = tmpRoot("act-residue-config")
        const masterSid = "ses_res_master_5"
        tracked.push(masterSid)
        await setupTeam(root, masterSid)
        const dir = await makeSiblingDir(root, masterSid, "partial-shell")
        await makeMarker(root, masterSid, "partial-shell")
        await fs.writeFile(path.join(dir, "config.json"), "{\"version\":1}\n", "utf8")

        const result = await activate(root, TEAM, masterSid)
        expect(result).toContain("cannot verify sibling team states")
    })

    test("state.json exists but invalid + marker → refuses (fingerprint sees the existing file)", async () => {
        const root = tmpRoot("act-residue-invalid-state")
        const masterSid = "ses_res_master_6"
        tracked.push(masterSid)
        await setupTeam(root, masterSid)
        const dir = await makeSiblingDir(root, masterSid, "invalid-state-shell")
        await makeMarker(root, masterSid, "invalid-state-shell")
        // loadTeamState synthesizes ENOENT for an invalid state.json; the
        // fingerprint must still observe the existing file and refuse.
        await fs.writeFile(path.join(dir, "state.json"), "{ not valid json", "utf8")

        const result = await activate(root, TEAM, masterSid)
        expect(result).toContain("cannot verify sibling team states")
    })

    test("cached sibling whose state.json became unreadable → refuses (flagged cache, no bypass)", async () => {
        const root = tmpRoot("act-residue-flagged-cache")
        const masterSid = "ses_res_master_7"
        tracked.push(masterSid)
        await setupTeam(root, masterSid)
        await initTeamState(root, makeState("beta", masterSid, []), masterSid)

        // Warm the registry cache, then corrupt state.json on disk and reset
        // the 1s cache throttle so the scan takes the flagged-cache path
        // (loadTeamState returns the cached Team with _stateUnreadable=true
        // instead of throwing).
        const beta = await loadTeamState(root, "beta", masterSid)
        await fs.writeFile(path.join(beta.directory, "state.json"), "{ not valid json", "utf8")
        beta._lastCacheCheck = 0

        const result = await activate(root, TEAM, masterSid)
        expect(result).toContain("cannot verify sibling team states")
    })

    test("same-name recreation window: ignored while empty, loads once state.json exists", async () => {
        const root = tmpRoot("act-residue-recreate")
        const masterSid = "ses_res_master_8"
        tracked.push(masterSid)
        await setupTeam(root, masterSid)

        // Window shape: directory claimed, stale marker from the previous
        // generation still present, identity files not yet written.
        await makeSiblingDir(root, masterSid, "beta")
        await makeMarker(root, masterSid, "beta")
        expect(await activate(root, TEAM, masterSid)).toContain("activated")

        // Once the new generation writes state.json, beta loads normally and
        // participates in the sibling check instead of being skipped.
        await initTeamState(root, makeState("beta", masterSid, []), masterSid)
        const beta = await loadTeamState(root, "beta", masterSid)
        expect(beta.teamName).toBe("beta")
        const result = await activate(root, "beta", masterSid)
        // alpha is still the active team; the refusal proves the scan verified
        // beta through the normal load path rather than failing on it.
        expect(result).toContain("currently active")
    })
})

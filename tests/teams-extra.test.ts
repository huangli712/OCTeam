/**
 * Coverage-gap tests for src/tui/teams.ts — loadTeams branches that
 * tui-teams.test.ts (which only tests countMailbox) doesn't reach:
 *   - teamsDir ENOENT → empty array (line 71)
 *   - team without config.json → members load with undefined roles (line 88 catch)
 *   - activeTask present → summary.active renders type/round/maxRounds (lines 113-117)
 *   - lastMode but no activeTask → summary.active renders from lastMode (lines 120-122)
 */
import fs from "node:fs/promises"
import path from "node:path"

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import { loadTeams, type TeamSummary } from "../src/tui/teams.js"
import { statePath, teamDir } from "../src/state/paths.js"
import { cleanupTmpRoots, makeMember, makeState, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

const originalCwd = process.cwd()

afterEach(() => {
    process.chdir(originalCwd)
})

/** Write a team state.json directly to the .octeam directory structure. */
async function writeTeamState(
    storageRoot: string,
    sessionId: string,
    state: ReturnType<typeof makeState>,
): Promise<string> {
    const dir = teamDir(storageRoot, state.teamName, sessionId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(statePath(dir), JSON.stringify(state, null, 2), "utf8")
    return dir
}

async function loadOk(directory: string, sessionId: string): Promise<TeamSummary[]> {
    const result = await loadTeams(directory, sessionId)
    expect(result.status).toBe("ok")
    return result.status === "ok" ? result.data : []
}

describe("loadTeams", () => {
    test("no teams directory → returns empty array", async () => {
        const root = tmpRoot("teams-empty")
        process.chdir(root)
        const result = await loadTeams(root, "ses_nonexistent")
        expect(result).toEqual({ status: "ok", data: [] })
    })

    test("team without config.json → members load with undefined roles", async () => {
        const root = tmpRoot("teams-noconfig")
        process.chdir(root)
        const sid = "ses_teams_noconfig"
        // loadTeams reads from <cwd>/.octeam; write state there.
        const octeamRoot = path.join(root, ".octeam")
        await writeTeamState(octeamRoot, sid, makeState("alpha", sid, [makeMember("alice")]))

        const result = await loadOk(root, sid)
        expect(result).toHaveLength(1)
        expect(result[0]!.name).toBe("alpha")
        expect(result[0]!.members).toHaveLength(1)
        expect(result[0]!.members[0]!.name).toBe("alice")
        // role is undefined because config.json was absent (line 88 catch).
        expect(result[0]!.members[0]!.role).toBeUndefined()
    })

    test("team with activeTask → summary.active includes type/round/maxRounds", async () => {
        const root = tmpRoot("teams-active")
        process.chdir(root)
        const sid = "ses_teams_active"
        const state = makeState("alpha", sid, [makeMember("alice")], Date.now())
        // Add an active parallel task with round info.
        ;(state as Record<string, unknown>).activeTask = {
            type: "consensus",
            mode: "isolated",
            currentRound: 2,
            maxRounds: 5,
            tokensByMember: {},
        }
        const octeamRoot = path.join(root, ".octeam")
        await writeTeamState(octeamRoot, sid, state)

        const result = await loadOk(root, sid)
        expect(result).toHaveLength(1)
        expect(result[0]!.active).toBeDefined()
        expect(result[0]!.active!.type).toBe("consensus")
        expect(result[0]!.active!.round).toBe(2)
        expect(result[0]!.active!.maxRounds).toBe(5)
    })

    test("team with lastMode but no activeTask → summary.active from lastMode", async () => {
        const root = tmpRoot("teams-lastmode")
        process.chdir(root)
        const sid = "ses_teams_lastmode"
        const state = makeState("alpha", sid, [makeMember("alice")], Date.now())
        // Add lastMode but NO activeTask.
        ;(state as Record<string, unknown>).lastMode = {
            type: "pipeline",
            mode: "isolated",
        }
        const octeamRoot = path.join(root, ".octeam")
        await writeTeamState(octeamRoot, sid, state)

        const result = await loadOk(root, sid)
        expect(result).toHaveLength(1)
        expect(result[0]!.active).toBeDefined()
        expect(result[0]!.active!.type).toBe("pipeline")
        expect(result[0]!.active!.mode).toBe("isolated")
        // round/maxRounds should be undefined (not in lastMode).
        expect(result[0]!.active!.round).toBeUndefined()
    })
})

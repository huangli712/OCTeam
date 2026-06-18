import { describe, expect, test } from "bun:test"

import { teamDir } from "../src/state/paths.js"
import { initTeamState, invalidateTeam, loadTeamState } from "../src/state/store.js"
import { makeState, tmpRoot } from "./helpers.js"

describe("teamRegistry keyed by resolved teamDir", () => {
    test("same teamName under two lead sessions → distinct registry entries", async () => {
        const root = tmpRoot("registry")
        const teamA = await initTeamState(root, makeState("aaa", "ses_x"), "ses_x")
        const teamB = await initTeamState(root, makeState("aaa", "ses_y"), "ses_y")

        // Distinct resolved directories (cross-session collision avoided).
        expect(teamA.directory).toBe(teamDir(root, "aaa", "ses_x"))
        expect(teamB.directory).toBe(teamDir(root, "aaa", "ses_y"))
        expect(teamA.directory).not.toBe(teamB.directory)

        // Distinct singleton mutexes — serialization does not bleed across sessions.
        expect(teamA.mutex).not.toBe(teamB.mutex)
    })

    test("invalidateTeam(dirA) evicts only A; B keeps its mutex", async () => {
        const root = tmpRoot("registry-inv")
        const teamA = await initTeamState(root, makeState("aaa", "ses_x"), "ses_x")
        const teamB = await initTeamState(root, makeState("aaa", "ses_y"), "ses_y")

        invalidateTeam(teamA.directory)

        // B untouched: reload returns the SAME singleton mutex (still registered).
        const reloadedB = await loadTeamState(root, "aaa", "ses_y")
        expect(reloadedB.mutex).toBe(teamB.mutex)

        // A evicted: reload rebuilds a FRESH mutex.
        const reloadedA = await loadTeamState(root, "aaa", "ses_x")
        expect(reloadedA.mutex).not.toBe(teamA.mutex)
    })
})

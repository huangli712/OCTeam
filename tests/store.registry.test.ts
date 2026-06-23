import { describe, expect, test } from "bun:test"

import { teamDir } from "../src/state/paths.js"
import { activeTeams, initTeamState, invalidateTeam, loadTeamState } from "../src/state/store.js"
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

describe("multi-team coexistence under one session", () => {
    test("two teams under one session → distinct registry entries + independent mutexes", async () => {
        const root = tmpRoot("registry-coexist")
        const a = await initTeamState(root, makeState("aaa", "ses_x"), "ses_x")
        const b = await initTeamState(root, makeState("bbb", "ses_x"), "ses_x")

        expect(a.directory).toBe(teamDir(root, "aaa", "ses_x"))
        expect(b.directory).toBe(teamDir(root, "bbb", "ses_x"))
        expect(a.directory).not.toBe(b.directory)
        expect(a.mutex).not.toBe(b.mutex)
    })

    test("activeTeams() filters by activeTask, orthogonal to activatedAt", async () => {
        const root = tmpRoot("registry-active")
        // "aaa" is the available team (activatedAt) but has NO activeTask.
        const a = await initTeamState(root, makeState("aaa", "ses_x", [], Date.now()), "ses_x")
        await initTeamState(root, makeState("bbb", "ses_x"), "ses_x")

        // No team has an activeTask → activeTeams() is empty regardless of activatedAt.
        expect(activeTeams().some(t => t.directory === a.directory)).toBe(false)
    })
})

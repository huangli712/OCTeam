import { afterAll, describe, expect, spyOn, test } from "bun:test"

import { initTeamState, loadTeamState, saveTeamState } from "../src/state/store.js"
import { cleanupTmpRoots, makeMember, makeState, tmpRoot } from "./helpers.js"

afterAll(cleanupTmpRoots)

describe("stale load apply fence", () => {
    test("stale load apply must not roll initialized back after a concurrent save", async () => {
        const root = tmpRoot("stale-load-apply")
        const leadSessionId = "ses_stale_load_apply"
        const alice = makeMember("alice")
        alice.initialized = false
        await initTeamState(root, makeState("alpha", leadSessionId, [alice]), leadSessionId)

        const team = await loadTeamState(root, "alpha", leadSessionId)
        const liveAlice = team.members.find(member => member.name === "alice")
        if (liveAlice === undefined) {
            throw new TypeError("Expected alice in the loaded team")
        }

        team._lastCacheCheck = 0
        team._diskMtime = 0

        const mutexGate = Promise.withResolvers<void>()
        const mutexHeld = Promise.withResolvers<void>()
        const mutexHold = team.mutex.runExclusive(async () => {
            mutexHeld.resolve()
            await mutexGate.promise
        })
        await mutexHeld.promise

        const originalRunExclusive = team.mutex.runExclusive.bind(team.mutex)
        const staleApplyQueued = Promise.withResolvers<void>()
        const runExclusiveSpy = spyOn(team.mutex, "runExclusive")
        function observeRunExclusive<T>(fn: () => Promise<T>): Promise<T> {
            staleApplyQueued.resolve()
            return originalRunExclusive(fn)
        }
        runExclusiveSpy.mockImplementation(observeRunExclusive)

        try {
            const staleLoad = loadTeamState(root, "alpha", leadSessionId)
            await staleApplyQueued.promise

            liveAlice.initialized = true
            await saveTeamState(team)

            mutexGate.resolve()
            await mutexHold
            await staleLoad

            expect(liveAlice.initialized).toBe(true)
        } finally {
            runExclusiveSpy.mockRestore()
            mutexGate.resolve()
            await mutexHold
        }
    })
})

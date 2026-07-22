import { afterAll, describe, expect, test } from 'bun:test';

import { initTeamState, listAllTeams } from "../src/state/store.js"
import { cleanupTmpRoots, makeState, tmpRoot } from './helpers.js';

afterAll(cleanupTmpRoots)

type Entry = { leadSessionId?: string; teamName: string }

function sortEntries(entries: Entry[]): Entry[] {
    return [...entries].sort((a, b) =>
        `${a.leadSessionId ?? ""}/${a.teamName}`.localeCompare(`${b.leadSessionId ?? ""}/${b.teamName}`),
    )
}

describe("listAllTeams", () => {
    test("segmented=true recurses <root>/<sid>/teams/<name>", async () => {
        const root = tmpRoot("listall-seg")
        await initTeamState(root, makeState("alpha", "ses_1"), "ses_1")
        await initTeamState(root, makeState("beta", "ses_1"), "ses_1")
        await initTeamState(root, makeState("gamma", "ses_2"), "ses_2")

        const got = sortEntries(await listAllTeams(root, true))
        expect(got).toEqual([
            { leadSessionId: "ses_1", teamName: "alpha" },
            { leadSessionId: "ses_1", teamName: "beta" },
            { leadSessionId: "ses_2", teamName: "gamma" },
        ])
    })

    test("segmented=false reads flat <root>/teams/<name> (no leadSessionId)", async () => {
        const root = tmpRoot("listall-flat")
        await initTeamState(root, makeState("solo", "ses_z"), undefined)

        const got = await listAllTeams(root, false)
        expect(got).toEqual([{ teamName: "solo" }])
    })

    test("missing root → []", async () => {
        const root = tmpRoot("listall-empty")
        expect(await listAllTeams(root, true)).toEqual([])
        expect(await listAllTeams(root, false)).toEqual([])
    })
})

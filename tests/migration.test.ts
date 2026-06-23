import { afterEach, describe, expect, test } from "bun:test"

import type { PluginContext } from "../src/core/context.js"
import { reconcileActivation } from "../src/hooks.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, resolveMasterTeams, resolveTeamMember, unindexSession } from "../src/core/utils.js"
import { makeState, tmpRoot } from "./helpers.js"

/**
 * reconcileActivation only reads ctx.{projectStorageRoot,userStorageRoot}. The
 * fixtures here use the PROJECT scope (segmented) so leadSessionId is honored.
 * Real startup order: rebuildSessionIndex (builds the master index + restores the
 * active pointer from activatedAt) THEN reconcileActivation. The tests mirror it.
 */
function ctxFor(root: string): PluginContext {
    return {
        projectStorageRoot: root,
        userStorageRoot: `${root}__user_unused`,
    } as unknown as PluginContext
}

const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

async function startup(root: string): Promise<void> {
    await rebuildSessionIndex(root, `${root}__user_unused`)
    await reconcileActivation(ctxFor(root))
}

describe("reconcileActivation migration / invariant", () => {
    test("single legacy team (no activatedAt) → backfilled active", async () => {
        const root = tmpRoot("recon-single")
        const sid = "ses_a"
        tracked.push(sid)
        await initTeamState(root, makeState("solo", sid), sid)

        await startup(root)

        const t = await loadTeamState(root, "solo", sid)
        expect(t.activatedAt).toBeDefined()
        // in-memory pointer now resolves the team
        expect((await resolveTeamMember(root, sid))?.teamName).toBe("solo")
    })

    test("two legacy teams, none active → both stay inactive", async () => {
        const root = tmpRoot("recon-multi-none")
        const sid = "ses_b"
        tracked.push(sid)
        await initTeamState(root, makeState("aaa", sid), sid)
        await initTeamState(root, makeState("bbb", sid), sid)

        await startup(root)

        expect((await loadTeamState(root, "aaa", sid)).activatedAt).toBeUndefined()
        expect((await loadTeamState(root, "bbb", sid)).activatedAt).toBeUndefined()
        // no active team → master resolves to null
        expect(await resolveTeamMember(root, sid)).toBeNull()
    })

    test("two teams both active (crash residue) → only the later retained", async () => {
        const root = tmpRoot("recon-multi-both")
        const sid = "ses_c"
        tracked.push(sid)
        const early = 1000
        const late = 2000
        await initTeamState(root, makeState("aaa", sid, [], early), sid)
        await initTeamState(root, makeState("bbb", sid, [], late), sid)

        await startup(root)

        expect((await loadTeamState(root, "aaa", sid)).activatedAt).toBeUndefined()
        expect((await loadTeamState(root, "bbb", sid)).activatedAt).toBe(late)
        expect((await resolveTeamMember(root, sid))?.teamName).toBe("bbb")
    })

    test("one active + one legacy-inactive → unchanged", async () => {
        const root = tmpRoot("recon-mixed")
        const sid = "ses_d"
        tracked.push(sid)
        const at = 5000
        await initTeamState(root, makeState("aaa", sid, [], at), sid)
        await initTeamState(root, makeState("bbb", sid), sid) // legacy inactive

        await startup(root)

        expect((await loadTeamState(root, "aaa", sid)).activatedAt).toBe(at)
        expect((await loadTeamState(root, "bbb", sid)).activatedAt).toBeUndefined()
        expect((await resolveTeamMember(root, sid))?.teamName).toBe("aaa")
    })

    test("identical activatedAt tiebreak is deterministic (lower directory wins)", async () => {
        const root = tmpRoot("recon-tie")
        const sid = "ses_e"
        tracked.push(sid)
        const same = 7000
        const a = await initTeamState(root, makeState("aaa", sid, [], same), sid)
        const b = await initTeamState(root, makeState("bbb", sid, [], same), sid)

        await startup(root)

        // tiebreak keeps the lexicographically-smaller directory
        const keepDir = a.directory < b.directory ? a.directory : b.directory
        const teams = resolveMasterTeams(sid)
        // exactly one remains active on disk
        const aActive = (await loadTeamState(root, "aaa", sid)).activatedAt !== undefined
        const bActive = (await loadTeamState(root, "bbb", sid)).activatedAt !== undefined
        expect(aActive !== bActive).toBe(true) // exactly one
        const resolved = await resolveTeamMember(root, sid)
        expect(resolved?.directory).toBe(keepDir)
        expect(teams.length).toBe(2)
    })
})

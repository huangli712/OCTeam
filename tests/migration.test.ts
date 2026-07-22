import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import type { PluginContext } from "../src/core/context.js"
import { reconcileActivation } from "../src/orchestration/lifecycle/reconcile.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, resolveTeamMember, unindexSession } from "../src/state/resolve.js"
import { cleanupTmpRoots, makeState, tmpRoot } from './helpers.js';

/**
 * reconcileActivation enforces "never auto-activate on restart": it clears
 * every team's persisted activatedAt so all teams are inactive after an
 * OpenCode restart, regardless of prior state. rebuildSessionIndex builds the
 * master index but does NOT restore the active pointer. The tests mirror the
 * real startup order: rebuildSessionIndex THEN reconcileActivation.
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
afterAll(cleanupTmpRoots)

async function startup(root: string): Promise<void> {
    await rebuildSessionIndex(root, `${root}__user_unused`)
    await reconcileActivation(ctxFor(root))
}

describe("reconcileActivation restart invariant: never auto-activate", () => {
    test("single team with activatedAt → cleared on restart", async () => {
        const root = tmpRoot("recon-single-active")
        const sid = "ses_a"
        tracked.push(sid)
        await initTeamState(root, makeState("solo", sid, [], 1000), sid)

        await startup(root)

        expect((await loadTeamState(root, "solo", sid)).activatedAt).toBeUndefined()
        // no active team → master resolves to null
        expect(await resolveTeamMember(root, sid)).toBeNull()
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
        expect(await resolveTeamMember(root, sid)).toBeNull()
    })

    test("two teams both active (crash residue) → ALL cleared on restart", async () => {
        const root = tmpRoot("recon-multi-both")
        const sid = "ses_c"
        tracked.push(sid)
        await initTeamState(root, makeState("aaa", sid, [], 1000), sid)
        await initTeamState(root, makeState("bbb", sid, [], 2000), sid)

        await startup(root)

        expect((await loadTeamState(root, "aaa", sid)).activatedAt).toBeUndefined()
        expect((await loadTeamState(root, "bbb", sid)).activatedAt).toBeUndefined()
        expect(await resolveTeamMember(root, sid)).toBeNull()
    })

    test("one active + one inactive → ALL cleared on restart", async () => {
        const root = tmpRoot("recon-mixed")
        const sid = "ses_d"
        tracked.push(sid)
        await initTeamState(root, makeState("aaa", sid, [], 5000), sid)
        await initTeamState(root, makeState("bbb", sid), sid)

        await startup(root)

        expect((await loadTeamState(root, "aaa", sid)).activatedAt).toBeUndefined()
        expect((await loadTeamState(root, "bbb", sid)).activatedAt).toBeUndefined()
        expect(await resolveTeamMember(root, sid)).toBeNull()
    })

    test("identical activatedAt → ALL cleared (no tiebreak)", async () => {
        const root = tmpRoot("recon-tie")
        const sid = "ses_e"
        tracked.push(sid)
        const same = 7000
        await initTeamState(root, makeState("aaa", sid, [], same), sid)
        await initTeamState(root, makeState("bbb", sid, [], same), sid)

        await startup(root)

        expect((await loadTeamState(root, "aaa", sid)).activatedAt).toBeUndefined()
        expect((await loadTeamState(root, "bbb", sid)).activatedAt).toBeUndefined()
        expect(await resolveTeamMember(root, sid)).toBeNull()
    })
})

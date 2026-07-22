/**
 * Resume-dispatch regression tests for team_resume Phase 3: consensus mode.
 * Split from resume-dispatch-branches.test.ts; drives resumeDispatch directly.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import type { ActiveTask } from "../src/core/types.js";
import {
    initTeamState,
    loadTeamState,
    saveTeamState,
} from "../src/state/store.js";
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js";
import { resumeDispatch } from "../src/orchestration/lifecycle/resume.js";
import { cleanupTmpRoots, makeCtx, makeMember, makeState, makeTask, tmpRoot } from './helpers.js';


const tracked: string[] = [];
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid);
});
afterAll(cleanupTmpRoots)

/** Commit a task as the active task on a freshly-loaded failed team, indexed. */
async function setup(
    root: string,
    sid: string,
    task: ActiveTask,
    members: ReturnType<typeof makeMember>[],
): Promise<ReturnType<typeof loadTeamState>> {
    const state = makeState("alpha", sid, members, Date.now());
    await initTeamState(root, state, sid);
    const team = await loadTeamState(root, "alpha", sid);
    await team.mutex.runExclusive(async () => {
        team.activeTask = task;
        await saveTeamState(team);
    });
    await rebuildSessionIndex(root, `${root}__unused`);
    return team;
}

describe("resumeDispatch: consensus re-dispatch loop", () => {
    test("round < maxRounds + a member lacks a response → that member is re-dispatched", async () => {
        const root = tmpRoot("rdb-consensus-redispatch");
        const sid = "ses_rdb_consensus";
        tracked.push(sid);
        // currentRound (0) < maxRounds (2); alice answered, bob did not →
        // resume must re-dispatch ONLY bob with the consensus round prompt.
        const task = makeTask({
            type: "consensus",
            topic: "ship or wait",
            currentRound: 0,
            maxRounds: 2,
            responses: { alice: "agree" },
        });
        const alice = makeMember("alice", "ses_alice");
        const bob = makeMember("bob", "ses_bob");
        const team = await setup(root, sid, task, [alice, bob]);

        const dispatched: { id: string; text: string }[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push({ id: req.path.id, text: (req.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "") });
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // Only bob re-dispatched (alice already responded), carrying the consensus prompt.
        expect(dispatched.map((d) => d.id)).toEqual(["ses_bob"]);
        expect(dispatched[0].text).toContain("Consensus Round");
        expect(dispatched[0].text).toContain("ship or wait");
        // Run stays live (still collecting this round).
        expect(team.activeTask).toBeDefined();
    });
});

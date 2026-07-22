/**
 * Resume-dispatch regression tests for team_resume Phase 3: reduce mode.
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

describe("resumeDispatch: reduce sub-stage where reducer ALREADY responded", () => {
    test("reducer has a response → handleReduceIdle runs (NOT a re-dispatch)", async () => {
        const root = tmpRoot("rdb-reduce-responded");
        const sid = "ses_rdb_reduce";
        tracked.push(sid);
        // reduceStage set, reducer bob HAS produced output → the resume path must
        // re-drive handleReduceIdle to capture+continue, not re-dispatch bob.
        const task = makeTask({
            type: "parallel",
            reducePolicy: "merge",
            reducerMember: "bob",
            reduceStage: true,
            responses: { alice: "a", dave: "d", bob: "MERGED RESULT" },
        });
        const alice = makeMember("alice", "ses_alice");
        const bob = makeMember("bob", "ses_bob");
        const dave = makeMember("dave", "ses_dave");
        const team = await setup(root, sid, task, [alice, bob, dave]);

        const dispatched: string[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push(req.path.id);
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // handleReduceIdle captured the reducer's result and delivered to leader;
        // bob was NOT re-dispatched. The leader (sid) receives the summary.
        expect(dispatched).not.toContain("ses_bob");
        expect(team.activeTask).toBeUndefined();
        expect(team.status).toBe("idle");
    });
});

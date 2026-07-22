/**
 * Resume-dispatch regression tests for team_resume Phase 3: pipeline and loop modes.
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

describe("resumeDispatch: pipeline/loop all-complete crash edge", () => {
    test("currentStageIndex >= stages.length → delivers + clears (no dispatch)", async () => {
        const root = tmpRoot("rdb-pipeline-allcomplete");
        const sid = "ses_rdb_pipe_done";
        tracked.push(sid);
        // Crash happened AFTER the last stage completed but BEFORE delivery:
        // currentStageIndex (2) == stages.length (2).
        const task = makeTask({
            type: "pipeline",
            stages: [
                { member: "alice", task: "s1", completed: true },
                { member: "bob", task: "s2", completed: true },
            ],
            currentStageIndex: 2,
            responses: { alice: "A", bob: "B" },
        });
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ]);

        const dispatched: string[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push(req.path.id);
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // No member re-dispatched; only the leader receives the completion summary.
        expect(dispatched).toEqual([sid]);
        expect(team.status).toBe("idle");
        expect(team.activeTask).toBeUndefined();
    });

    test("loop mid-stage resume → advanceToStage dispatches the current stage member", async () => {
        const root = tmpRoot("rdb-loop-midstage");
        const sid = "ses_rdb_loop_mid";
        tracked.push(sid);
        // Loop crashed at stage index 1 (bob's stage) within the round.
        const task = makeTask({
            type: "loop",
            stages: [
                { member: "alice", task: "code", completed: true },
                { member: "bob", task: "review", completed: false },
            ],
            currentStageIndex: 1,
            currentRound: 1,
            maxRounds: 3,
            deciderMember: "bob",
            responses: { alice: "ALICE_LOOP_OUTPUT" },
        });
        const team = await setup(root, sid, task, [
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ]);

        const dispatched: { id: string; text: string }[] = [];
        const ctx = makeCtx({ storageRoot: root, promptAsync: async (req) => {
            dispatched.push({ id: req.path.id, text: (req.body.parts[0].text as string).replace(/\n<!-- OMO_INTERNAL_INITIATOR -->$/, "") });
        } });

        await team.mutex.runExclusive(async () => {
            await resumeDispatch(ctx, team, team.activeTask!);
        });

        // Only bob (current stage) is re-dispatched, with upstream context injected.
        expect(dispatched.map((d) => d.id)).toEqual(["ses_bob"]);
        expect(dispatched[0].text).toContain("review");
        expect(dispatched[0].text).toContain("ALICE_LOOP_OUTPUT");
        expect(team.activeTask).toBeDefined();
    });
});

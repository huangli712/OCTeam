/**
 * A3: on_malformed gate policy tests.
 *
 * parse_failure (verifier output that cannot be parsed as a <verdict>) now
 * routes through on_malformed instead of on_invalid, with fallback to
 * on_invalid when on_malformed is unset. Tests cover:
 *   - fail (default + explicit)
 *   - retry_verifier (with malformedAttempts counter + exhaustion)
 *   - skip (marks gate skipped, advances)
 *   - fallback to on_invalid when on_malformed is unset
 */
import { describe, expect, test } from "bun:test";

import { processIdle } from "../src/orchestration/idle.js";
import type { Team } from "../src/state/store.js"
import type {
    ActiveTask,
    MemberState,
    WorkflowStep,
    WorkflowTask,
} from "../src/core/types.js";
import { makeCtx, makeTeam, makeWorkflowTask, type DispatchCall } from "./helpers.js";


function sessionIdFor(team: Team, name: string): string {
    const member = team.members.find((c) => c.name === name);
    if (member?.sessionId === undefined) throw new Error(`Missing fixture session: ${name}`);
    return member.sessionId;
}

const MALFORMED_OUTPUT = "I cannot decide, no verdict tag";

describe("workflow on_malformed gate policy", () => {
    test("parse_failure with no on_malformed and no on_invalid -> fails the run (default fail)", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true, output: "alice output" },
                { kind: "gate", verifier: "bob", criteria: "passes tests", onFail: "fail", completed: false },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: MALFORMED_OUTPUT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(team.status).toBe("failed");
        const leaderCall = calls.find((c) => c.sessionId === "ses_lead");
        expect(leaderCall).toBeDefined();
        expect(leaderCall!.text).toContain("workflow_invalid");
    });

    test("parse_failure with on_malformed='fail' -> fails the run", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true, output: "alice output" },
                { kind: "gate", verifier: "bob", criteria: "passes tests", onFail: "fail", onMalformed: "fail", completed: false },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: MALFORMED_OUTPUT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(team.status).toBe("failed");
        const leaderCall = calls.find((c) => c.sessionId === "ses_lead");
        expect(leaderCall).toBeDefined();
        expect(leaderCall!.text).toContain("workflow_invalid");
    });

    test("parse_failure with on_malformed='retry_verifier' re-dispatches verifier and increments malformedAttempts", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true, output: "alice output" },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "passes tests",
                    onFail: "fail",
                    onMalformed: "retry_verifier",
                    maxMalformedRetries: 2,
                    malformedAttempts: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: MALFORMED_OUTPUT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(task.steps![1].malformedAttempts).toBe(1);
        expect(task.responses.bob).toBeUndefined();
        // verifier should be re-dispatched
        const redispatch = calls.find((c) => c.sessionId === "ses_bob");
        expect(redispatch).toBeDefined();
        expect(redispatch!.text).toContain("malformed attempt 1/2");
    });

    test("parse_failure with on_malformed='retry_verifier' exhausts max_malformed_retries -> fails the run", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true, output: "alice output" },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "passes tests",
                    onFail: "fail",
                    onMalformed: "retry_verifier",
                    maxMalformedRetries: 1,
                    malformedAttempts: 1,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: MALFORMED_OUTPUT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        // malformedAttempts was 1, incremented to 2, exceeds maxMalformedRetries=1
        expect(task.steps![1].malformedAttempts).toBe(2);
        expect(team.status).toBe("failed");
        const leaderCall = calls.find((c) => c.sessionId === "ses_lead");
        expect(leaderCall).toBeDefined();
        expect(leaderCall!.text).toContain("workflow_invalid");
    });

    test("parse_failure with on_malformed='skip' marks gate skipped and advances", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true, output: "alice output" },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "passes tests",
                    onFail: "fail",
                    onMalformed: "skip",
                    completed: false,
                },
                { kind: "task", member: "carol", task: "next step", completed: false },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: MALFORMED_OUTPUT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        expect(task.steps![1].completed).toBe(true);
        expect(task.steps![1].skipped).toBe(true);
        // workflow should have advanced to step 3 (carol)
        const carolDispatch = calls.find((c) => c.sessionId === "ses_carol");
        expect(carolDispatch).toBeDefined();
    });

    test("parse_failure with on_malformed unset and on_invalid='retry_verifier' falls back to on_invalid", async () => {
        const calls: DispatchCall[] = [];
        const task = makeWorkflowTask({
            steps: [
                { kind: "task", member: "alice", task: "do work", completed: true, output: "alice output" },
                {
                    kind: "gate",
                    verifier: "bob",
                    criteria: "passes tests",
                    onFail: "fail",
                    onInvalid: "retry_verifier",
                    maxInvalidRetries: 2,
                    invalidAttempts: 0,
                    completed: false,
                },
            ],
            currentStageIndex: 1,
            responses: { alice: "alice output" },
        });
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        });
        const ctx = makeCtx({ outputs: { ses_bob: MALFORMED_OUTPUT }, calls: calls });

        await processIdle(ctx, team, team.members[1], "ses_bob");

        // Falls back to on_invalid='retry_verifier', uses invalidAttempts counter
        expect(task.steps![1].invalidAttempts).toBe(1);
        expect(task.steps![1].malformedAttempts).toBeUndefined();
        const redispatch = calls.find((c) => c.sessionId === "ses_bob");
        expect(redispatch).toBeDefined();
    });
});

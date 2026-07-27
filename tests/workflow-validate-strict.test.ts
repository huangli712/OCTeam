/**
 * C-8: validateWorkflowArgs must reject malformed nested control fields in
 * workflow_file steps. Pre-fix gaps:
 *   1. gate.loop with no/non-integer max_iterations, or out-of-range.
 *   2. task/gate max_*_retries with non-integer or >5 (resource exhaustion).
 *   3. fanout required_branches: null (TypeError on .length).
 *   4. gate on_pass_goto/on_fail_goto/on_invalid_goto pointing at a fanout
 *      marker or join marker (silent -1 at runtime, sequential fallthrough).
 */
import { describe, expect, test } from "bun:test"

import { validateWorkflowArgs } from "../src/tools/workflow/validate.js"
import { cleanupTmpRoots, makeMember, makeState, tmpRoot } from "./helpers.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { rebuildSessionIndex } from "../src/state/resolve.js"
import { teamDir } from "../src/state/paths.js"
import type { WorkflowToolArgs } from "../src/core/types.js"
import { afterAll } from "bun:test"

afterAll(cleanupTmpRoots)

async function makeTeam() {
    const root = tmpRoot("c8-validate")
    const sid = "ses_c8"
    const state = makeState("alpha", sid, [
        makeMember("alice", "ses_c8_alice"),
        makeMember("bob", "ses_c8_bob"),
        makeMember("carol", "ses_c8_carol"),
    ])
    await initTeamState(root, state, sid)
    await rebuildSessionIndex(root, `${root}__user_unused`)
    return loadTeamState(root, "alpha", sid)
}

function buildArgs(steps: unknown[]): WorkflowToolArgs {
    return {
        team_id: "alpha",
        steps: steps as WorkflowToolArgs["steps"],
    }
}

describe("C-8: gate.loop strict validation", () => {
    test("rejects loop with no max_iterations", async () => {
        const team = await makeTeam()
        const args = buildArgs([
            { kind: "task", id: "t1", member: "alice", task: "do" },
            {
                kind: "gate", id: "g1", verifier: "bob", criteria: "ok",
                target_step: 1, on_fail: "fail",
                on_fail_goto: "t1",
                loop: {},
            },
        ])
        expect(validateWorkflowArgs(args, team)).toMatch(/loop.*max_iterations|loop.max_iterations/i)
    })

    test("rejects loop.max_iterations that is not an integer", async () => {
        const team = await makeTeam()
        const args = buildArgs([
            { kind: "task", id: "t1", member: "alice", task: "do" },
            {
                kind: "gate", id: "g1", verifier: "bob", criteria: "ok",
                target_step: 1, on_fail: "fail",
                on_fail_goto: "t1",
                loop: { max_iterations: 2.5 },
            },
        ])
        expect(validateWorkflowArgs(args, team)).toMatch(/max_iterations.*integer/i)
    })

    test("rejects loop.max_iterations out of range (1..20)", async () => {
        const team = await makeTeam()
        const args = buildArgs([
            { kind: "task", id: "t1", member: "alice", task: "do" },
            {
                kind: "gate", id: "g1", verifier: "bob", criteria: "ok",
                target_step: 1, on_fail: "fail",
                on_fail_goto: "t1",
                loop: { max_iterations: 0 },
            },
        ])
        expect(validateWorkflowArgs(args, team)).toMatch(/max_iterations/i)
    })

    test("rejects loop.on_exhaust with unknown enum value", async () => {
        const team = await makeTeam()
        const args = buildArgs([
            { kind: "task", id: "t1", member: "alice", task: "do" },
            {
                kind: "gate", id: "g1", verifier: "bob", criteria: "ok",
                target_step: 1, on_fail: "fail",
                on_fail_goto: "t1",
                loop: { max_iterations: 5, on_exhaust: "explode" },
            },
        ])
        expect(validateWorkflowArgs(args, team)).toMatch(/on_exhaust/i)
    })

    test("accepts a well-formed loop", async () => {
        const team = await makeTeam()
        const args = buildArgs([
            { kind: "task", id: "t1", member: "alice", task: "do" },
            {
                kind: "gate", id: "g1", verifier: "bob", criteria: "ok",
                target_step: 1, on_fail: "fail",
                on_fail_goto: "t1",
                loop: { max_iterations: 3, on_exhaust: "continue" },
            },
        ])
        expect(validateWorkflowArgs(args, team)).toBeNull()
    })
})

describe("C-8: max_*_retries integer+range validation", () => {
    test("rejects task max_task_retries that is not an integer", async () => {
        const team = await makeTeam()
        const args = buildArgs([
            {
                kind: "task", id: "t1", member: "alice", task: "do",
                retry_on: { regex: "^fail" },
                max_task_retries: 1.5,
            },
        ])
        expect(validateWorkflowArgs(args, team)).toMatch(/max_task_retries.*integer/i)
    })

    test("rejects task max_task_retries out of range (>5)", async () => {
        const team = await makeTeam()
        const args = buildArgs([
            {
                kind: "task", id: "t1", member: "alice", task: "do",
                retry_on: { regex: "^fail" },
                max_task_retries: 1e9,
            },
        ])
        expect(validateWorkflowArgs(args, team)).toMatch(/max_task_retries/i)
    })

    test("rejects gate max_retries that is not an integer", async () => {
        const team = await makeTeam()
        const args = buildArgs([
            { kind: "task", id: "t1", member: "alice", task: "do" },
            {
                kind: "gate", id: "g1", verifier: "bob", criteria: "ok",
                target_step: 1, on_fail: "retry",
                max_retries: "three" as unknown as number,
            },
        ])
        expect(validateWorkflowArgs(args, team)).toMatch(/max_retries.*integer/i)
    })

    test("rejects gate max_invalid_retries out of range", async () => {
        const team = await makeTeam()
        const args = buildArgs([
            { kind: "task", id: "t1", member: "alice", task: "do" },
            {
                kind: "gate", id: "g1", verifier: "bob", criteria: "ok",
                target_step: 1, on_fail: "fail",
                on_invalid: "retry_verifier",
                max_invalid_retries: 999,
            },
        ])
        expect(validateWorkflowArgs(args, team)).toMatch(/max_invalid_retries/i)
    })

    test("rejects gate max_malformed_retries out of range", async () => {
        const team = await makeTeam()
        const args = buildArgs([
            { kind: "task", id: "t1", member: "alice", task: "do" },
            {
                kind: "gate", id: "g1", verifier: "bob", criteria: "ok",
                target_step: 1, on_fail: "fail",
                on_malformed: "retry_verifier",
                max_malformed_retries: -1,
            },
        ])
        expect(validateWorkflowArgs(args, team)).toMatch(/max_malformed_retries/i)
    })
})

describe("C-8: fanout required_branches null guard", () => {
    test("rejects required_branches: null without TypeError", async () => {
        const team = await makeTeam()
        const args = buildArgs([
            {
                kind: "fanout", id: "f1",
                branches: [{ id: "b1", steps: [{ kind: "task", id: "t1", member: "alice", task: "do" }] }],
                join_policy: "required_branches",
                required_branches: null as unknown as string[],
            },
            { kind: "join", id: "j1" },
        ])
        // Pre-fix this threw TypeError at .length. Post-fix must return a clean error.
        expect(() => validateWorkflowArgs(args, team)).not.toThrow()
        expect(validateWorkflowArgs(args, team)).toMatch(/required_branches/i)
    })
})

describe("C-8: goto target marker check", () => {
    test("rejects on_pass_goto pointing at a fanout marker", async () => {
        const team = await makeTeam()
        const args = buildArgs([
            {
                kind: "fanout", id: "f1",
                branches: [
                    {
                        id: "b1",
                        steps: [
                            { kind: "task", id: "t1", member: "alice", task: "do" },
                            {
                                kind: "gate", id: "g1", verifier: "bob", criteria: "ok",
                                target_step: 1, on_fail: "fail",
                                on_pass_goto: "f1",  // fanout marker id
                            },
                        ],
                    },
                ],
            },
            { kind: "join", id: "j1" },
        ])
        expect(validateWorkflowArgs(args, team)).toMatch(/on_pass_goto.*fanout|on_pass_goto.*marker|fanout marker/i)
    })
})

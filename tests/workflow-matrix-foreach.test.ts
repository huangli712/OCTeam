import { afterEach, describe, expect, test } from "bun:test"

import { processIdle } from "../src/orchestration/lifecycle/idle.js"
import { checkTermination } from "../src/orchestration/lifecycle/termination.js"
import { teamWorkflowTool } from "../src/tools/workflow/engine.js"
import { expandMatrixForeachFanout } from "../src/tools/workflow/engine.js"
import { makeCtx, makeMember, makeState, makeToolContext, tmpRoot, type DispatchCall } from "./helpers.js"
import { initTeamState, loadTeamState } from "../src/state/store.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import type { WorkflowToolStep } from "../src/tools/workflow/engine.js"



const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

async function setup(root: string, sid: string, members = [makeMember("alice"), makeMember("bob")]): Promise<void> {
    await initTeamState(root, makeState("alpha", sid, members, Date.now()), sid)
    await rebuildSessionIndex(root, `${root}__unused`)
}

describe("expandMatrixForeachFanout (unit)", () => {
    test("foreach expands one branch per value and substitutes ${as}", () => {
        const steps: WorkflowToolStep[] = [
            { kind: "fanout", foreach: ["api", "docs"], as: "area", steps: [{ kind: "task", member: "bob", task: "Build ${area}" }] },
            { kind: "join" },
        ]
        const expanded = expandMatrixForeachFanout(steps)
        const fanout = expanded[0]
        expect(fanout?.branches).toEqual([
            { id: "api", steps: [{ kind: "task", member: "bob", task: "Build api" }] },
            { id: "docs", steps: [{ kind: "task", member: "bob", task: "Build docs" }] },
        ])
    })

    test("matrix expands the cartesian product and substitutes every key", () => {
        const steps: WorkflowToolStep[] = [
            { kind: "fanout", matrix: { area: ["api", "qa"], tier: ["fast"] }, steps: [{ kind: "task", member: "bob", task: "${area} ${tier}" }] },
            { kind: "join" },
        ]
        const expanded = expandMatrixForeachFanout(steps)
        const ids = (expanded[0]?.branches ?? []).map(b => b.id).sort()
        expect(ids).toEqual(["api_fast", "qa_fast"])
    })

    test("a fanout without matrix/foreach is left unchanged", () => {
        const steps: WorkflowToolStep[] = [
            { kind: "fanout", branches: [{ id: "api", steps: [{ kind: "task", member: "bob", task: "Build" }] }] },
            { kind: "join" },
        ]
        expect(expandMatrixForeachFanout(steps)).toEqual(steps)
    })
})

describe("team_workflow matrix/foreach startup validation", () => {
    test("foreach fanout dry_run renders expanded branches", async () => {
        const root = tmpRoot("wf-foreach-dry")
        const sid = "ses_wf_foreach_dry"
        tracked.push(sid)
        await setup(root, sid, [makeMember("alice"), makeMember("api"), makeMember("docs")])
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    { kind: "fanout", foreach: ["api", "docs"], as: "area", steps: [{ kind: "task", member: "${area}", task: "Build ${area}" }] },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("2. [fanout] branches: api, docs -> join step 5")
        expect(result).toContain("Build api")
        expect(result).toContain("Build docs")
    })

    test("fanout with both matrix and foreach -> rejected", async () => {
        const root = tmpRoot("wf-matrix-foreach-both")
        const sid = "ses_wf_matrix_foreach_both"
        tracked.push(sid)
        await setup(root, sid, [makeMember("alice"), makeMember("bob")])
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    { kind: "fanout", matrix: { area: ["api"] }, foreach: ["x"], steps: [{ kind: "task", member: "bob", task: "Build ${area}" }] },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 must not set both matrix and foreach")
    })

    test("fanout with matrix and explicit branches -> rejected", async () => {
        const root = tmpRoot("wf-matrix-branches")
        const sid = "ses_wf_matrix_branches"
        tracked.push(sid)
        await setup(root, sid, [makeMember("alice"), makeMember("bob")])
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    { kind: "fanout", matrix: { area: ["api"] }, branches: [{ id: "x", steps: [{ kind: "task", member: "bob", task: "x" }] }] },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 must not set both matrix/foreach and branches")
    })

    test("fanout with matrix but no template steps -> rejected", async () => {
        const root = tmpRoot("wf-matrix-no-template")
        const sid = "ses_wf_matrix_no_template"
        tracked.push(sid)
        await setup(root, sid, [makeMember("alice"), makeMember("bob")])
        const result = await teamWorkflowTool(makeCtx({ storageRoot: root })).execute(
            {
                team_id: "alpha",
                dry_run: true,
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    { kind: "fanout", matrix: { area: ["api"] } },
                    { kind: "join" },
                ],
            },
            makeToolContext(sid),
        )

        expect(result).toContain("Error: fanout step 2 with matrix/foreach requires template `steps`")
    })
})

describe("team_workflow matrix/foreach end-to-end execution", () => {
    test("foreach fanout with required_branches joins after the required branch survives", async () => {
        // Given: a foreach fanout where api is required and docs is optional.
        const root = tmpRoot("wf-foreach-required-runtime")
        const masterSid = "ses_wf_foreach_required_master"
        const aliceSid = "ses_wf_foreach_required_alice"
        const apiSid = "ses_wf_foreach_required_api"
        const docsSid = "ses_wf_foreach_required_docs"
        const daveSid = "ses_wf_foreach_required_dave"
        tracked.push(masterSid, aliceSid, apiSid, docsSid, daveSid)
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ storageRoot: root, outputs: {
            [aliceSid]: "plan output",
            [apiSid]: "api branch output",
            [daveSid]: "downstream output",
        }, calls })
        await setup(root, masterSid, [
            makeMember("alice", aliceSid),
            makeMember("api", apiSid),
            makeMember("docs", docsSid),
            makeMember("dave", daveSid),
        ])

        const result = await teamWorkflowTool(ctx).execute(
            {
                team_id: "alpha",
                steps: [
                    { kind: "task", member: "alice", task: "Plan" },
                    {
                        kind: "fanout",
                        foreach: ["api", "docs"],
                        as: "area",
                        join_policy: "required_branches",
                        required_branches: ["api"],
                        steps: [{ kind: "task", member: "${area}", task: "Build ${area}" }],
                    },
                    { kind: "join" },
                    { kind: "task", member: "dave", task: "Integrate" },
                ],
            },
            makeToolContext(masterSid),
        )
        const team = await loadTeamState(root, "alpha", masterSid)
        const alice = team.members.find(member => member.name === "alice")
        const api = team.members.find(member => member.name === "api")
        const docs = team.members.find(member => member.name === "docs")
        if (alice === undefined || api === undefined || docs === undefined) throw new Error("Missing workflow member")

        // When: the optional docs branch errors, then the required api branch succeeds.
        expect(result).toContain("team_workflow started")
        await processIdle(ctx, team, alice, aliceSid)
        docs.status = "errored"
        docs.error = "docs branch failed"
        await checkTermination(ctx, team)
        await processIdle(ctx, team, api, apiSid)

        // Then: required_branches allows the join to complete and dispatches the downstream step.
        if (team.activeTask?.type !== "workflow") throw new Error("Expected live workflow task")
        const joinStep = team.activeTask.steps?.[4]
        expect(team.status).not.toBe("failed")
        expect(joinStep?.completed).toBe(true)
        expect(joinStep?.join?.erroredBranchIds).toEqual(["docs"])
        expect(joinStep?.join?.survivorBranchIds).toEqual(["api"])
        expect(calls.some(call => call.sessionId === daveSid && call.text.includes("Integrate"))).toBe(true)
    })
})

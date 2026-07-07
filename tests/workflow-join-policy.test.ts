import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask, MemberState, WorkflowStep, WorkflowTask } from "../src/core/types.js"
import { checkTermination } from "../src/orchestration/termination.js"
import { processIdle } from "../src/orchestration/handlers.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { Team } from "../src/state/store.js"

type DispatchCall = { readonly sessionId: string; readonly text: string }

function makeCtx(outputs: Record<string, string> = {}, calls: DispatchCall[] = []): PluginContext {
    return {
        storageRoot: mkdtempSync(join(tmpdir(), "octeam-wf-joinpol-root-")),
        scope: "project",
        directory: "/app",
        client: {
            session: {
                messages: async ({ path }: { path: { id: string } }) => {
                    const text = outputs[path.id] ?? ""
                    return {
                        data: [
                            { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
                            ...(text ? [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }] : []),
                        ],
                    }
                },
                promptAsync: async (args: { readonly path: { readonly id: string }; readonly body: { readonly parts: readonly [{ readonly text: string }] } }) => {
                    calls.push({ sessionId: args.path.id, text: args.body.parts[0].text })
                    return { data: {} }
                },
            },
        },
    } as unknown as PluginContext
}

function makeWorkflowTask(steps: WorkflowStep[], activeStepIndices: number[]): WorkflowTask {
    return {
        type: "workflow",
        startedAt: Date.now(),
        wallClockTimeoutMs: Number.MAX_SAFE_INTEGER,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: activeStepIndices[0] ?? 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        signoffPolicy: "none",
        steps,
        activeStepIndices,
    } as WorkflowTask
}

function makeTeam(activeTask: ActiveTask, members: Array<Partial<MemberState> & Pick<MemberState, "name">>): Team {
    return {
        version: 1,
        teamRunId: "joinpol-run",
        teamName: "joinpol-team",
        status: "busy",
        leadSessionId: "ses_lead",
        members: members.map(m => ({
            name: m.name, sessionId: m.sessionId, status: m.status ?? "idle",
            initialized: m.initialized ?? true, turnCount: m.turnCount ?? 0,
            isMaster: m.isMaster, error: m.error,
        })),
        bounds: {
            maxMembers: 8, maxParallelMembers: 4, maxMessagesPerRun: 100, maxWallClockMinutes: 30,
            maxMemberTurns: 50, maxTasks: 200, messagePayloadMaxBytes: 32768, messageUnreadMaxBytes: 1048576,
        },
        createdAt: Date.now(),
        activeTask,
        mutex: new AsyncMutex(),
        directory: mkdtempSync(join(tmpdir(), "octeam-wf-joinpol-")),
    } as unknown as Team
}

function member(team: Team, name: string): MemberState {
    const found = team.members.find(c => c.name === name)
    if (found === undefined) throw new Error(`Missing ${name}`)
    return found
}

function sid(team: Team, name: string): string {
    const s = member(team, name).sessionId
    if (s === undefined) throw new Error(`Missing session ${name}`)
    return s
}

describe("workflow join policy runtime semantics", () => {
    test("join_policy='required_branches' joins when a required branch survives and an optional branch errors", async () => {
        // Given: fanout with required_branches=["api"]; qa is optional.
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask(
            [
                { kind: "fanout", completed: true, fanout: { branchIds: ["api", "qa"], branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }], joinIndex: 3, maxErrored: 0, joinPolicy: "required_branches", requiredBranchIds: ["api"] } },
                { kind: "task", member: "alice", task: "api", completed: false, branch: { fanoutIndex: 0, branchId: "api", branchIndex: 0, joinIndex: 3 } },
                { kind: "task", member: "bob", task: "qa", completed: false, branch: { fanoutIndex: 0, branchId: "qa", branchIndex: 1, joinIndex: 3 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2], maxErrored: 0, joinPolicy: "required_branches", requiredBranchIds: ["api"] } },
                { kind: "task", member: "carol", task: "ship", completed: false },
            ],
            [1, 2],
        )
        const team = makeTeam(task, [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
            { name: "carol", sessionId: "ses_carol" },
        ])
        const ctx = makeCtx({ ses_alice: "api output", ses_carol: "downstream" }, calls)

        // When: qa branch errors (optional), api branch succeeds.
        const qaMember = member(team, "bob")
        qaMember.status = "errored"
        qaMember.error = "qa outage"
        await checkTermination(ctx, team) // marks qa branch errored
        await processIdle(ctx, team, member(team, "alice"), "ses_alice")

        // Then: join completes (api is required and survived), downstream dispatched.
        expect(task.steps?.[3]?.completed).toBe(true)
        expect(task.activeStepIndices).toEqual([4])
        expect(calls.some(c => c.sessionId === "ses_carol")).toBe(true)
    })

    test("join_policy='required_branches' fails fast when a required branch errors", async () => {
        // Given: required_branches=["api"]; api errors.
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask(
            [
                { kind: "fanout", completed: true, fanout: { branchIds: ["api", "qa"], branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }], joinIndex: 3, maxErrored: 0, joinPolicy: "required_branches", requiredBranchIds: ["api"] } },
                { kind: "task", member: "alice", task: "api", completed: false, branch: { fanoutIndex: 0, branchId: "api", branchIndex: 0, joinIndex: 3 } },
                { kind: "task", member: "bob", task: "qa", completed: false, branch: { fanoutIndex: 0, branchId: "qa", branchIndex: 1, joinIndex: 3 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2], maxErrored: 0, joinPolicy: "required_branches", requiredBranchIds: ["api"] } },
            ],
            [1, 2],
        )
        const team = makeTeam(task, [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
        ])
        const ctx = makeCtx({}, calls)

        // When: api (required) errors.
        const apiMember = member(team, "alice")
        apiMember.status = "errored"
        apiMember.error = "api outage"
        await checkTermination(ctx, team)

        // Then: workflow fails immediately.
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
    })

    test("join_policy='quorum' joins once the quorum threshold of branches survives", async () => {
        // Given: 3 branches, quorum 0.5 => need 2 survivors.
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask(
            [
                { kind: "fanout", completed: true, fanout: { branchIds: ["a", "b", "c"], branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }, { startIndex: 3, endIndex: 3 }], joinIndex: 4, maxErrored: 0, joinPolicy: "quorum", quorum: 0.5 } },
                { kind: "task", member: "alice", task: "a", completed: false, branch: { fanoutIndex: 0, branchId: "a", branchIndex: 0, joinIndex: 4 } },
                { kind: "task", member: "bob", task: "b", completed: false, branch: { fanoutIndex: 0, branchId: "b", branchIndex: 1, joinIndex: 4 } },
                { kind: "task", member: "carol", task: "c", completed: false, branch: { fanoutIndex: 0, branchId: "c", branchIndex: 2, joinIndex: 4 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2, 3], maxErrored: 0, joinPolicy: "quorum", quorum: 0.5 } },
            ],
            [1, 2, 3],
        )
        const team = makeTeam(task, [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
            { name: "carol", sessionId: "ses_carol" },
        ])
        const ctx = makeCtx({ ses_alice: "a out", ses_bob: "b out" }, calls)

        // When: 2 of 3 branches survive (c errors), meeting quorum.
        const cMember = member(team, "carol")
        cMember.status = "errored"
        cMember.error = "c outage"
        await checkTermination(ctx, team) // marks c errored
        await processIdle(ctx, team, member(team, "alice"), "ses_alice")
        await processIdle(ctx, team, member(team, "bob"), "ses_bob")

        // Then: join completes (2 survivors >= ceil(0.5 * 3) = 2).
        expect(task.steps?.[4]?.completed).toBe(true)
    })

    test("join_policy='quorum' fails when survivors drop below the threshold", async () => {
        // Given: 3 branches, quorum 0.5 => need 2 survivors.
        const calls: DispatchCall[] = []
        const task = makeWorkflowTask(
            [
                { kind: "fanout", completed: true, fanout: { branchIds: ["a", "b", "c"], branchRanges: [{ startIndex: 1, endIndex: 1 }, { startIndex: 2, endIndex: 2 }, { startIndex: 3, endIndex: 3 }], joinIndex: 4, maxErrored: 0, joinPolicy: "quorum", quorum: 0.5 } },
                { kind: "task", member: "alice", task: "a", completed: false, branch: { fanoutIndex: 0, branchId: "a", branchIndex: 0, joinIndex: 4 } },
                { kind: "task", member: "bob", task: "b", completed: false, branch: { fanoutIndex: 0, branchId: "b", branchIndex: 1, joinIndex: 4 } },
                { kind: "task", member: "carol", task: "c", completed: false, branch: { fanoutIndex: 0, branchId: "c", branchIndex: 2, joinIndex: 4 } },
                { kind: "join", completed: false, join: { fanoutIndex: 0, branchTailIndices: [1, 2, 3], maxErrored: 0, joinPolicy: "quorum", quorum: 0.5 } },
            ],
            [1, 2, 3],
        )
        const team = makeTeam(task, [
            { name: "alice", sessionId: "ses_alice" },
            { name: "bob", sessionId: "ses_bob" },
            { name: "carol", sessionId: "ses_carol" },
        ])
        const ctx = makeCtx({}, calls)

        // When: 2 of 3 error, leaving only 1 survivor (< threshold).
        member(team, "bob").status = "errored"
        member(team, "carol").status = "errored"
        await checkTermination(ctx, team)

        // Then: workflow fails (impossible to reach quorum).
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
    })
})

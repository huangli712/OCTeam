import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PluginContext } from "../src/core/context.js"
import type { ActiveTask, MemberState, WorkflowStep, WorkflowTask } from "../src/core/types.js"
import { checkWorkflowInvariants } from "../src/orchestration/workflow-invariants.js"
import { getActiveWorkflowStepActors } from "../src/orchestration/workflow-dag.js"
import { processIdle } from "../src/orchestration/handlers.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { Team } from "../src/state/store.js"

const PASS_VERDICT = '<verdict>{"result":"PASS","rationale":"ok","diff":""}</verdict>'

type DispatchCall = { readonly sessionId: string; readonly text: string }

type GeneratedWorkflow = {
    readonly name: string
    readonly task: WorkflowTask
    readonly members: readonly MemberState[]
    readonly outputs: Record<string, string>
}

function sessionId(name: string, seed: number): string {
    return `ses_${name}_${seed}`
}

function makeCtx(outputs: Record<string, string>, calls: DispatchCall[]): PluginContext {
    return {
        storageRoot: mkdtempSync(join(tmpdir(), "octeam-wf-model-root-")),
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

function makeMember(name: string, seed: number): MemberState {
    return {
        name,
        sessionId: sessionId(name, seed),
        status: "idle",
        initialized: true,
        turnCount: 0,
    }
}

function makeWorkflowTask(seed: number, steps: WorkflowStep[], activeStepIndices?: number[]): WorkflowTask {
    return {
        type: "workflow",
        startedAt: Date.now(),
        wallClockTimeoutMs: Number.MAX_SAFE_INTEGER,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: `workflow-model-${seed}`,
        signoffPolicy: "none",
        steps,
        ...(activeStepIndices === undefined ? {} : { activeStepIndices }),
    }
}

function makeTeam(task: ActiveTask, members: readonly MemberState[]): Team {
    return {
        version: 1,
        teamRunId: "workflow-model-run",
        teamName: "workflow-model-team",
        status: "busy",
        leadSessionId: "ses_lead",
        members: [...members],
        bounds: {
            maxMembers: 8,
            maxParallelMembers: 4,
            maxMessagesPerRun: 100,
            maxWallClockMinutes: 30,
            maxMemberTurns: 50,
            maxTasks: 200,
            messagePayloadMaxBytes: 32768,
            messageUnreadMaxBytes: 1048576,
        },
        createdAt: Date.now(),
        activeTask: task,
        mutex: new AsyncMutex(),
        directory: mkdtempSync(join(tmpdir(), "octeam-wf-model-")),
    } as unknown as Team
}

function assertWorkflowInvariant(task: WorkflowTask, label: string): void {
    const result = checkWorkflowInvariants(task)
    if (!result.ok) throw new Error(`${label}: ${result.violations.join("; ")}`)
}

function linearWorkflow(seed: number): GeneratedWorkflow {
    const length = 2 + (seed % 3)
    const memberNames = ["alice", "bob", "carol", "dave"].slice(0, length)
    const steps = memberNames.map((name, index): WorkflowStep => ({
        kind: "task",
        member: name,
        task: `linear task ${index + 1}`,
        completed: false,
    }))
    const members = memberNames.map(name => makeMember(name, seed))
    const outputs = Object.fromEntries(memberNames.map(name => [sessionId(name, seed), `${name} output ${seed}`]))
    return { name: `linear-${seed}`, task: makeWorkflowTask(seed, steps), members, outputs }
}

function gateWorkflow(seed: number): GeneratedWorkflow {
    const steps: WorkflowStep[] = [
        { kind: "task", member: "alice", task: "produce", completed: false },
        { kind: "gate", verifier: "bob", criteria: "verify", targetStepIndex: 0, onFail: "fail", attempts: 0, onInvalid: "fail", invalidAttempts: 0, completed: false },
        { kind: "task", member: "carol", task: "ship", completed: false },
    ]
    const members = ["alice", "bob", "carol"].map(name => makeMember(name, seed))
    const outputs = {
        [sessionId("alice", seed)]: `producer output ${seed}`,
        [sessionId("bob", seed)]: PASS_VERDICT,
        [sessionId("carol", seed)]: `ship output ${seed}`,
    }
    return { name: `gate-${seed}`, task: makeWorkflowTask(seed, steps), members, outputs }
}

function fanoutWorkflow(seed: number): GeneratedWorkflow {
    const steps: WorkflowStep[] = [
        { kind: "task", member: "alice", task: "prepare", completed: false },
        { kind: "fanout", completed: false, fanout: { branchIds: ["api", "tests"], branchRanges: [{ startIndex: 2, endIndex: 2 }, { startIndex: 3, endIndex: 3 }], joinIndex: 4, maxErrored: 0 } },
        { kind: "task", member: "bob", task: "api", completed: false, branch: { fanoutIndex: 1, branchId: "api", branchIndex: 0, joinIndex: 4 } },
        { kind: "task", member: "carol", task: "tests", completed: false, branch: { fanoutIndex: 1, branchId: "tests", branchIndex: 1, joinIndex: 4 } },
        { kind: "join", completed: false, join: { fanoutIndex: 1, branchTailIndices: [2, 3], maxErrored: 0 } },
        { kind: "task", member: "dave", task: "integrate", completed: false },
    ]
    const members = ["alice", "bob", "carol", "dave"].map(name => makeMember(name, seed))
    const outputs = Object.fromEntries(members.map(member => [member.sessionId ?? "", `${member.name} output ${seed}`]))
    return { name: `fanout-${seed}`, task: makeWorkflowTask(seed, steps, [0]), members, outputs }
}

function generateWorkflow(seed: number): GeneratedWorkflow {
    switch (seed % 3) {
        case 0:
            return linearWorkflow(seed)
        case 1:
            return gateWorkflow(seed)
        case 2:
            return fanoutWorkflow(seed)
        default:
            return linearWorkflow(seed)
    }
}

function findMember(team: Team, name: string): MemberState {
    const member = team.members.find(candidate => candidate.name === name)
    if (member === undefined) throw new Error(`Missing model member ${name}`)
    return member
}

async function driveWorkflowModel(seed: number): Promise<void> {
    const generated = generateWorkflow(seed)
    const calls: DispatchCall[] = []
    const ctx = makeCtx(generated.outputs, calls)
    const team = makeTeam(generated.task, generated.members)

    for (let turn = 0; turn < 20 && team.activeTask?.type === "workflow"; turn += 1) {
        assertWorkflowInvariant(team.activeTask, `${generated.name}: before turn ${turn}`)
        const actors = getActiveWorkflowStepActors(team.activeTask)
        if (actors.length === 0) throw new Error(`${generated.name}: no active actors at turn ${turn}`)
        for (const actor of actors) {
            if (team.activeTask?.type !== "workflow") break
            const activeActors = getActiveWorkflowStepActors(team.activeTask)
            if (!activeActors.includes(actor)) continue
            const actorMember = findMember(team, actor)
            const actorSession = actorMember.sessionId
            if (actorSession === undefined) throw new Error(`${generated.name}: missing session for ${actor}`)
            await processIdle(ctx, team, actorMember, actorSession)
            if (team.activeTask?.type === "workflow") assertWorkflowInvariant(team.activeTask, `${generated.name}: after ${actor} turn ${turn}`)
        }
    }

    expect(team.status).toBe("idle")
    expect(team.activeTask).toBeUndefined()
}

describe("workflow seeded model transitions", () => {
    test("generated workflows preserve invariants until completion", async () => {
        for (let seed = 1; seed <= 12; seed += 1) {
            await driveWorkflowModel(seed)
        }
    })
})

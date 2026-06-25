import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
    getExpectedMember,
    handleRouteIdle,
    parseRouteDecision,
} from "../src/orchestration/handlers.js"
import { readRunEvents } from "../src/orchestration/runs.js"
import type { ActiveTask, MemberState } from "../src/core/types.js"
import type { Team } from "../src/state/store.js"
import { AsyncMutex } from "../src/state/locks.js"
import type { PluginContext } from "../src/core/context.js"

// --- fixtures ---

/** A recorded promptAsync call: which session got which text. */
type DispatchCall = { sessionId: string; text: string }

/**
 * Stub PluginContext: only ctx.client.session.promptAsync is exercised (by
 * dispatchToMember and deliverSummaryToLeader). Each call is recorded into
 * `calls` so tests can assert routing targets and leader delivery.
 */
function makeCtx(calls: DispatchCall[] = []): PluginContext {
    return {
        client: {
            session: {
                promptAsync: async (args: any) => {
                    calls.push({
                        sessionId: args.path.id,
                        text: args.body.parts[0].text,
                    })
                    return { data: {} }
                },
            },
        },
    } as unknown as PluginContext
}

/** Minimal valid route ActiveTask with sensible defaults. */
function makeRouteTask(opts: Partial<ActiveTask> = {}): ActiveTask {
    return {
        type: "route",
        startedAt: 0,
        wallClockTimeoutMs: 300000,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        stages: [],
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        runId: crypto.randomUUID(),
        routerMember: "router",
        routeStage: false,
        signoffPolicy: "none",
        task: "route-input",
        ...opts,
    } as ActiveTask
}

/** Minimal busy Team wrapper with a real tmp directory for file IO. */
function makeTeam(opts: {
    activeTask?: ActiveTask
    members?: Array<Partial<MemberState> & Pick<MemberState, "name">>
}): Team {
    const members: MemberState[] = (opts.members ?? []).map(m => ({
        name: m.name,
        status: m.status ?? "idle",
        initialized: m.initialized ?? true,
        turnCount: m.turnCount ?? 0,
        sessionId: m.sessionId,
        agent: m.agent,
        isMaster: m.isMaster,
    }))
    return {
        version: 1,
        teamRunId: "test-run",
        teamName: "test-team",
        status: "busy",
        leadSessionId: "ses_lead",
        members,
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
        createdAt: 0,
        activeTask: opts.activeTask,
        mutex: new AsyncMutex(),
        directory: mkdtempSync(join(tmpdir(), "octeam-route-")),
    } as unknown as Team
}

// --- parseRouteDecision (pure function) ---

describe("parseRouteDecision", () => {
    test("parses a single branch selection", () => {
        const text = '<route>{"branch": "support", "rationale": "billing issue"}</route>'
        const result = parseRouteDecision(text)
        expect(result).toEqual({ targets: ["support"], rationale: "billing issue" })
    })

    test("parses multiple branch selection via branches", () => {
        const text = '<route>{"branches": ["sales", "support"], "rationale": "cross-team"}</route>'
        const result = parseRouteDecision(text)
        expect(result.targets).toEqual(["sales", "support"])
        expect(result.rationale).toBe("cross-team")
    })

    test("accepts target alias (singular)", () => {
        const text = '<route>{"target": "sales", "rationale": "r"}</route>'
        expect(parseRouteDecision(text).targets).toEqual(["sales"])
    })

    test("accepts targets alias (plural)", () => {
        const text = '<route>{"targets": ["a", "b"], "rationale": "r"}</route>'
        expect(parseRouteDecision(text).targets).toEqual(["a", "b"])
    })

    test("parses bilingual <路由> tag", () => {
        const text = '<路由>{"branch": "support", "rationale": "中文理由"}</路由>'
        const result = parseRouteDecision(text)
        expect(result).toEqual({ targets: ["support"], rationale: "中文理由" })
    })

    test("returns parseFailed when no tag is present", () => {
        const result = parseRouteDecision("just regular output, no routing tag")
        expect(result.parseFailed).toBe(true)
        expect(result.targets).toEqual([])
    })

    test("returns parseFailed for malformed JSON inside tag", () => {
        expect(parseRouteDecision("<route>not valid json</route>").parseFailed).toBe(true)
    })

    test("returns parseFailed when branch value is empty string", () => {
        expect(parseRouteDecision('<route>{"branch": ""}</route>').parseFailed).toBe(true)
    })

    test("returns parseFailed when branches array is empty", () => {
        expect(parseRouteDecision('<route>{"branches": []}</route>').parseFailed).toBe(true)
    })

    test("returns parseFailed when branches array is absent", () => {
        expect(parseRouteDecision('<route>{"rationale": "no branch"}</route>').parseFailed).toBe(true)
    })

    test("filters out non-string branch values", () => {
        const text = '<route>{"branches": ["valid", 42, null, "also-valid"]}</route>'
        expect(parseRouteDecision(text).targets).toEqual(["valid", "also-valid"])
    })

    test("rationale defaults to empty string when absent", () => {
        const text = '<route>{"branch": "x"}</route>'
        expect(parseRouteDecision(text).rationale).toBe("")
    })

    test("rationale defaults to empty string when non-string", () => {
        const text = '<route>{"branch": "x", "rationale": 123}</route>'
        expect(parseRouteDecision(text).rationale).toBe("")
    })

    test("parses tag embedded in longer router output", () => {
        const text = `Analyzing the request...\nThe category is clearly support.\n\n<route>{"branch": "support", "rationale": "refund"}</route>\nDone.`
        const result = parseRouteDecision(text)
        expect(result).toEqual({ targets: ["support"], rationale: "refund" })
    })

    test("handles empty string input", () => {
        expect(parseRouteDecision("").parseFailed).toBe(true)
    })

    test("handles undefined-like input gracefully", () => {
        expect(parseRouteDecision(undefined as unknown as string).parseFailed).toBe(true)
    })
})

// --- getExpectedMember (route identity gate) ---

describe("getExpectedMember: route type", () => {
    test("router phase (routeStage falsy) returns the router member name", () => {
        const task = makeRouteTask({ routerMember: "router", routeStage: false })
        expect(getExpectedMember(task)).toBe("router")
    })

    test("router phase defaults routerMember to null when unset", () => {
        const task = makeRouteTask({ routerMember: undefined, routeStage: false })
        expect(getExpectedMember(task)).toBe(null)
    })

    test("target phase (routeStage true) returns null (any target may advance)", () => {
        const task = makeRouteTask({ routerMember: "router", routeStage: true })
        expect(getExpectedMember(task)).toBe(null)
    })

    test("signoff stage overrides route phase (any reviewer advances)", () => {
        const task = makeRouteTask({ routerMember: "router", routeStage: false, signoffStage: true })
        expect(getExpectedMember(task)).toBe(null)
    })
})

// --- handleRouteIdle Phase A (router decision -> target dispatch) ---

describe("handleRouteIdle Phase A: router decision resolution", () => {
    test("normal single-target route: dispatches to the selected branch member", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const branches = [
            { name: "sales", member: "alice" },
            { name: "support", member: "bob" },
        ]
        const task = makeRouteTask({
            routerMember: "router",
            routeBranches: branches,
            responses: {
                router: '<route>{"branch": "support", "rationale": "billing"}</route>',
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "router", sessionId: "ses_router" },
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await handleRouteIdle(ctx, team)

        // Transitioned to Phase B.
        expect(task.routeStage).toBe(true)
        expect(task.routeTargets).toEqual(["bob"])
        expect(task.routeDecisionRationale).toBe("billing")

        // Only the selected target was dispatched (not alice, not re-dispatch to router).
        const targetCalls = calls.filter(c => c.sessionId !== "ses_router")
        expect(targetCalls.map(c => c.sessionId)).toEqual(["ses_bob"])

        // The dispatched target flipped to running.
        const bob = team.members.find(m => m.name === "bob")!
        expect(bob.status).toBe("running")
        expect(bob.turnCount).toBe(1)

        // The non-selected member was NOT dispatched.
        const alice = team.members.find(m => m.name === "alice")!
        expect(alice.turnCount).toBe(0)
    })

    test("multi-target route: dispatches to all selected branch members", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const branches = [
            { name: "sales", member: "alice" },
            { name: "support", member: "bob" },
            { name: "legal", member: "carol" },
        ]
        const task = makeRouteTask({
            routerMember: "router",
            routeBranches: branches,
            responses: {
                router: '<route>{"branches": ["sales", "legal"], "rationale": "dual"}</route>',
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "router", sessionId: "ses_router" },
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
                { name: "carol", sessionId: "ses_carol" },
            ],
        })

        await handleRouteIdle(ctx, team)

        expect(task.routeStage).toBe(true)
        expect(task.routeTargets).toEqual(["alice", "carol"])

        const dispatched = calls
            .filter(c => c.sessionId !== "ses_router")
            .map(c => c.sessionId)
            .sort()
        expect(dispatched).toEqual(["ses_alice", "ses_carol"])
    })

    test("per-branch task overrides the routing input when present", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const branches = [
            { name: "support", member: "bob", task: "Handle the refund request." },
        ]
        const task = makeRouteTask({
            routerMember: "router",
            routeBranches: branches,
            task: "generic-route-input",
            responses: { router: '<route>{"branch": "support"}</route>' },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "router", sessionId: "ses_router" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await handleRouteIdle(ctx, team)

        const bobCall = calls.find(c => c.sessionId === "ses_bob")!
        expect(bobCall.text).toBe("Handle the refund request.")
    })

    test("falls back to routing input when branch has no per-branch task", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const branches = [{ name: "support", member: "bob" }]
        const task = makeRouteTask({
            routerMember: "router",
            routeBranches: branches,
            task: "the-routing-input",
            responses: { router: '<route>{"branch": "support"}</route>' },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "router", sessionId: "ses_router" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await handleRouteIdle(ctx, team)

        const bobCall = calls.find(c => c.sessionId === "ses_bob")!
        expect(bobCall.text).toBe("the-routing-input")
    })

    test("no-match: parse failure fails the run with decision_parse_failure", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeRouteTask({
            routerMember: "router",
            routeBranches: [{ name: "sales", member: "alice" }],
            // Router emitted no <route> tag.
            responses: { router: "I am not sure where this goes." },
        })
        const runId = task.runId!
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "router", sessionId: "ses_router" },
                { name: "alice", sessionId: "ses_alice" },
            ],
        })

        await handleRouteIdle(ctx, team)

        // Run failed and task cleared.
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()

        // No target dispatched; only the leader delivery happened.
        const targetDispatched = calls.some(c => c.sessionId === "ses_alice")
        expect(targetDispatched).toBe(false)

        // The terminated event carries the failure marker.
        await new Promise(r => setTimeout(r, 50))
        const events = await readRunEvents(team.directory, runId)
        const terminated = events.find(e => e.kind === "terminated")
        expect(terminated).toBeDefined()
        expect(terminated!.reason).toContain("decision_parse_failure")
    })

    test("no-match: valid parse but unknown branch name also fails the run", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeRouteTask({
            routerMember: "router",
            routeBranches: [{ name: "sales", member: "alice" }],
            // Router named a branch that does not exist.
            responses: { router: '<route>{"branch": "nonexistent"}</route>' },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "router", sessionId: "ses_router" },
                { name: "alice", sessionId: "ses_alice" },
            ],
        })

        await handleRouteIdle(ctx, team)

        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        expect(calls.some(c => c.sessionId === "ses_alice")).toBe(false)
    })

    test("no active task is a safe no-op", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const team = makeTeam({ members: [{ name: "router", sessionId: "s" }] })
        await expect(handleRouteIdle(ctx, team)).resolves.toBeUndefined()
        expect(calls).toHaveLength(0)
    })
})

// --- handleRouteIdle Phase B (target barrier -> delivery) ---

describe("handleRouteIdle Phase B: target barrier", () => {
    test("all targets idle: delivers summary and clears the task", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeRouteTask({
            routerMember: "router",
            routeStage: true,
            routeTargets: ["alice", "bob"],
            routeBranches: [
                { name: "a", member: "alice" },
                { name: "b", member: "bob" },
            ],
            responses: { router: '<route>{"branches":["a","b"]}</route>', alice: "A", bob: "B" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "router", sessionId: "ses_router" },
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                { name: "bob", sessionId: "ses_bob", status: "idle" },
            ],
        })

        await handleRouteIdle(ctx, team)

        // Barrier fired: summary delivered to leader, task cleared, team idle.
        expect(team.status).toBe("idle")
        expect(team.activeTask).toBeUndefined()
        expect(calls.some(c => c.sessionId === "ses_lead")).toBe(true)
    })

    test("not all targets idle: no delivery (barrier waits)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeRouteTask({
            routerMember: "router",
            routeStage: true,
            routeTargets: ["alice", "bob"],
            routeBranches: [
                { name: "a", member: "alice" },
                { name: "b", member: "bob" },
            ],
            responses: { alice: "A" },
        })
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "router", sessionId: "ses_router" },
                { name: "alice", sessionId: "ses_alice", status: "idle" },
                // bob still running -> barrier must not fire.
                { name: "bob", sessionId: "ses_bob", status: "running" },
            ],
        })

        await handleRouteIdle(ctx, team)

        // Barrier did not fire: task stays live, no leader delivery.
        expect(team.status).toBe("busy")
        expect(team.activeTask).toBeDefined()
        expect(calls.some(c => c.sessionId === "ses_lead")).toBe(false)
    })
})

// --- routed event observability ---

describe("routed event recording", () => {
    test("Phase A records a routed event naming the router and target members", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx(calls)
        const task = makeRouteTask({
            routerMember: "router",
            routeBranches: [
                { name: "sales", member: "alice" },
                { name: "support", member: "bob" },
            ],
            responses: {
                router: '<route>{"branches": ["sales", "support"], "rationale": "both"}</route>',
            },
        })
        const runId = task.runId!
        const team = makeTeam({
            activeTask: task,
            members: [
                { name: "router", sessionId: "ses_router" },
                { name: "alice", sessionId: "ses_alice" },
                { name: "bob", sessionId: "ses_bob" },
            ],
        })

        await handleRouteIdle(ctx, team)

        // recordEvent is fire-and-forget; give the async appends a tick to flush.
        await new Promise(r => setTimeout(r, 50))
        const events = await readRunEvents(team.directory, runId)

        const routed = events.find(e => e.kind === "routed")
        expect(routed).toBeDefined()
        expect(routed!.member).toBe("router")
        // detail encodes the resolved target members (order = branch declaration).
        expect(routed!.detail).toContain("alice")
        expect(routed!.detail).toContain("bob")
    })
})

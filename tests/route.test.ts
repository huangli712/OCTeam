import { afterEach, describe, expect, test } from "bun:test"


import type { ToolContext } from "@opencode-ai/plugin"

import { getExpectedMember } from "../src/orchestration/lifecycle/idle.js"
import { handleRouteIdle } from "../src/orchestration/modes/route.js"
import { parseRouteDecision } from "../src/orchestration/protocol/decisions.js"
import { readRunEvents } from "../src/orchestration/records/runs.js"

import { buildSummary } from "../src/orchestration/records/summary.js"
import { checkTermination } from "../src/orchestration/lifecycle/termination.js"
import { buildRouterPrompt, teamRouteTool } from "../src/tools/modes/router.js"
import { teamResumeTool } from "../src/tools/resume.js"
import type { ActiveTask, MemberState, RouteBranch, RouteTask } from "../src/core/types.js"
import { initTeamState, loadTeamState, saveTeamState, type Team } from "../src/state/store.js"

import type { PluginContext } from "../src/core/context.js"
import { rebuildSessionIndex, unindexSession } from "../src/state/resolve.js"
import { makeCtx, makeMember, makeState, makeTeam, tmpRoot, type DispatchCall, waitForEvent } from "./helpers.js"

// --- fixtures ---


/** Minimal valid route ActiveTask with sensible defaults. */
function makeRouteTask(opts: Partial<RouteTask> = {}): RouteTask {
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
    } as RouteTask
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
        const ctx = makeCtx({ calls })
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
        const ctx = makeCtx({ calls })
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
        const ctx = makeCtx({ calls })
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
        const ctx = makeCtx({ calls })
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
        const ctx = makeCtx({ calls })
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
        await waitForEvent(team.directory, runId, "terminated")
        const events = await readRunEvents(team.directory, runId)
        const terminated = events.find(e => e.kind === "terminated")
        expect(terminated).toBeDefined()
        expect(terminated!.reason).toContain("decision_parse_failure")
    })

    test("no-match: valid parse but unknown branch name also fails the run", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
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
        const ctx = makeCtx({ calls })
        const team = makeTeam({ members: [{ name: "router", sessionId: "s" }] })
        expect(handleRouteIdle(ctx, team)).resolves.toBeUndefined()
        expect(calls).toHaveLength(0)
    })
})

// --- handleRouteIdle Phase B (target barrier -> delivery) ---

describe("handleRouteIdle Phase B: target barrier", () => {
    test("all targets idle: delivers summary and clears the task", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
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
        const ctx = makeCtx({ calls })
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
        const ctx = makeCtx({ calls })
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

        // recordEvent is fire-and-forget; wait for the routed event to flush.
        await waitForEvent(team.directory, runId, "routed")
        const events = await readRunEvents(team.directory, runId)

        const routed = events.find(e => e.kind === "routed")
        expect(routed).toBeDefined()
        expect(routed!.member).toBe("router")
        // detail encodes the resolved target members (order = branch declaration).
        expect(routed!.detail).toContain("alice")
        expect(routed!.detail).toContain("bob")
    })
})


// =======================================================================
// Tool-level fixtures (disk-backed team state + master session indexing).
// teamRouteTool validation (LOW-1) and team_resume (LOW-4b) both flow
// through resolveCallerInTeam + loadTeamState, so they need real on-disk
// state and an indexed master session.
// =======================================================================

/** Track indexed master sessions so each test cleans up its index entry. */
const tracked: string[] = []
afterEach(() => {
    for (const sid of tracked.splice(0)) unindexSession(sid)
})

/** Minimal PluginContext exposing only storageRoot (teamRouteTool validation). */
function makeToolCtx(root: string): PluginContext {
    return { storageRoot: root, scope: "project" } as unknown as PluginContext
}

/** Create an active on-disk team and index its master session. */
async function setupRouteTeam(
    root: string,
    sid: string,
    members: MemberState[] = [makeMember("router"), makeMember("alice"), makeMember("bob")],
): Promise<void> {
    await initTeamState(root, makeState("alpha", sid, members, Date.now()), sid)
    await rebuildSessionIndex(root, `${root}__unused`)
}

// --- LOW-1: teamRouteTool input validation (5 error branches) ---

describe("teamRouteTool: input validation", () => {
    test('router = "master" is rejected before any team lookup', async () => {
        const root = tmpRoot("route-val-master")
        const sid = "ses_route_val_master"
        tracked.push(sid)
        await setupRouteTeam(root, sid)
        const result = await teamRouteTool(makeToolCtx(root)).execute(
            {
                team_id: "alpha",
                router: "master",
                input: "x",
                routes: [{ name: "a", member: "alice" }],
            },
            { sessionID: sid } as unknown as ToolContext,
        )
        expect(result).toBe('Error: router must be a member name, not "master"')
    })

    test("duplicate branch names are rejected", async () => {
        const root = tmpRoot("route-val-dupnames")
        const sid = "ses_route_val_dupnames"
        tracked.push(sid)
        await setupRouteTeam(root, sid)
        const result = await teamRouteTool(makeToolCtx(root)).execute(
            {
                team_id: "alpha",
                router: "router",
                input: "x",
                routes: [
                    { name: "dup", member: "alice" },
                    { name: "dup", member: "bob" },
                ],
            },
            { sessionID: sid } as unknown as ToolContext,
        )
        expect(result).toBe("Error: route branch names must be unique")
    })

    test("duplicate branch members are rejected", async () => {
        const root = tmpRoot("route-val-dupmembers")
        const sid = "ses_route_val_dupmembers"
        tracked.push(sid)
        await setupRouteTeam(root, sid)
        const result = await teamRouteTool(makeToolCtx(root)).execute(
            {
                team_id: "alpha",
                router: "router",
                input: "x",
                routes: [
                    { name: "a", member: "alice" },
                    { name: "b", member: "alice" },
                ],
            },
            { sessionID: sid } as unknown as ToolContext,
        )
        expect(result).toBe("Error: route branch members must be unique")
    })

    test("router that is also a branch target is rejected", async () => {
        const root = tmpRoot("route-val-selftarget")
        const sid = "ses_route_val_selftarget"
        tracked.push(sid)
        await setupRouteTeam(root, sid)
        const result = await teamRouteTool(makeToolCtx(root)).execute(
            {
                team_id: "alpha",
                router: "router",
                input: "x",
                routes: [{ name: "a", member: "router" }],
            },
            { sessionID: sid } as unknown as ToolContext,
        )
        expect(result).toBe("Error: router must not also be a branch target")
    })

    test("unknown branch member is rejected", async () => {
        const root = tmpRoot("route-val-unknown")
        const sid = "ses_route_val_unknown"
        tracked.push(sid)
        await setupRouteTeam(root, sid)
        const result = await teamRouteTool(makeToolCtx(root)).execute(
            {
                team_id: "alpha",
                router: "router",
                input: "x",
                routes: [{ name: "a", member: "ghost" }],
            },
            { sessionID: sid } as unknown as ToolContext,
        )
        expect(result).toBe('Error: unknown member "ghost" in router/routes')
    })
})

// --- LOW-2: buildRouterPrompt format ---

describe("buildRouterPrompt", () => {
    test("renders branch list, input, decision format, and i18n warning", () => {
        const branches: RouteBranch[] = [
            { name: "sales", member: "alice", description: "billing & pricing" },
            { name: "support", member: "bob" },
        ]
        const prompt = buildRouterPrompt("myteam", "I need a refund", branches)

        // Decision tag format instruction (single + multi branch).
        expect(prompt).toContain('<route>{"branch": "<name>", "rationale": "<why>"}</route>')
        expect(prompt).toContain('<route>{"branches": ["a","b"], "rationale": "..."}</route>')
        // Every branch is listed with its target member.
        expect(prompt).toContain("- sales (-> alice)")
        expect(prompt).toContain("- support (-> bob)")
        // Optional branch description is shown.
        expect(prompt).toContain("billing & pricing")
        // The routing input is embedded.
        expect(prompt).toContain("[Input]")
        expect(prompt).toContain("I need a refund")
        // The team name is referenced.
        expect(prompt).toContain("myteam")
        // The \"do NOT use translated tags\" guard is present.
        expect(prompt).toContain("do NOT use translated tags")
    })
})

// --- LOW-3: Phase B errored target -> checkTermination fail-fast ---

describe("checkTermination: route Phase B errored target", () => {
    test("an errored target fails the run (route tolerance is 0)", async () => {
        const calls: DispatchCall[] = []
        const ctx = makeCtx({ calls })
        const task = makeRouteTask({
            routeStage: true,
            // Fresh start time so the wall-clock branch cannot fire first; this
            // isolates the member-error path being asserted.
            startedAt: Date.now(),
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
                // One target reached a terminal error state.
                { name: "bob", sessionId: "ses_bob", status: "errored" },
            ],
        })

        await checkTermination(ctx, team)

        // route is NOT in termination's concurrent set, so tolerance is 0:
        // a single errored target fails fast BEFORE the Phase B barrier.
        expect(team.status).toBe("failed")
        expect(team.activeTask).toBeUndefined()
        // Failure went through the member-error path (reason in the summary head).
        const leaderCall = calls.find(c => c.sessionId === "ses_lead")!
        expect(leaderCall).toBeDefined()
        expect(leaderCall.text).toContain("member_error")
        expect(leaderCall.text).toContain("bob")
    })
})

// --- LOW-4: summary + resume route branches ---

/** Build a failed team carrying a route lastInterruptedTask, indexed for resume. */
async function setupFailedRoute(
    root: string,
    sid: string,
    task: ActiveTask,
    members: MemberState[],
): Promise<Team> {
    const state = makeState("alpha", sid, members, Date.now())
    state.status = "failed"
    await initTeamState(root, state, sid)
    const team = await loadTeamState(root, "alpha", sid)
    await team.mutex.runExclusive(async () => {
        team.lastInterruptedTask = task
        await saveTeamState(team)
    })
    await rebuildSessionIndex(root, `${root}__unused`)
    return team
}

/** PluginContext for resume: storageRoot + a capturing promptAsync. */
function makeResumeCtx(
    root: string,
    promptAsync: (req: { path: { id: string } }) => Promise<void>,
): PluginContext {
    return {
        storageRoot: root,
        scope: "project",
        directory: "/app",
        client: {
            session: {
                promptAsync,
                messages: async () => ({ data: [] }),
            },
        },
    } as unknown as PluginContext
}

describe("buildSummary: route case", () => {
    test("excludes router decision JSON, shows target outputs + rationale", async () => {
        const task = makeRouteTask({
            routeStage: true,
            routeTargets: ["alice", "bob"],
            routeDecisionRationale: "cross-team request",
            responses: {
                // Router's <route> decision must NOT leak into the summary.
                router: '<route>{"branches":["a","b"],"rationale":"cross-team request"}</route>',
                alice: "Sales answer",
                bob: "Support answer",
            },
        })
        const team = makeTeam({
            activeTask: task,
            members: [{ name: "router" }, { name: "alice" }, { name: "bob" }],
        })

        const summary = await buildSummary(team, task, "route_complete")

        // Head reflects mode + reason.
        expect(summary).toContain("mode=route reason=route_complete")
        // Only the resolved targets' outputs are shown.
        expect(summary).toContain("### alice")
        expect(summary).toContain("Sales answer")
        expect(summary).toContain("### bob")
        expect(summary).toContain("Support answer")
        // Router rationale is appended.
        expect(summary).toContain("Router rationale: cross-team request")
        // The router's raw <route> decision JSON is excluded as noise.
        expect(summary).not.toContain("<route>")
    })
})

describe("team_resume: route case", () => {
    test("Phase A with a captured router response re-runs handleRouteIdle", async () => {
        const root = tmpRoot("route-resume-a")
        const sid = "ses_route_resume_a"
        tracked.push(sid)
        const task = makeRouteTask({
            routerMember: "router",
            routeStage: false,
            routeBranches: [
                { name: "sales", member: "alice" },
                { name: "support", member: "bob" },
            ],
            // Router already decided before the crash.
            responses: { router: '<route>{"branch": "support", "rationale": "billing"}</route>' },
        })
        const team = await setupFailedRoute(root, sid, task, [
            makeMember("router", "ses_router"),
            makeMember("alice", "ses_alice"),
            makeMember("bob", "ses_bob"),
        ])
        const calls: string[] = []
        const ctx = makeResumeCtx(root, async req => {
            calls.push(req.path.id)
        })

        const res = await teamResumeTool(ctx).execute(
            { team_id: "alpha" },
            { sessionID: sid } as unknown as ToolContext,
        )

        expect(res).toContain("Resumed route")
        // handleRouteIdle Phase A parsed the decision and fanned out to the
        // selected target only (bob), not the router or the unselected branch.
        expect(calls).toEqual(["ses_bob"])
        // Transitioned to Phase B with the resolved target.
        const rtTask = team.activeTask as RouteTask | undefined
        expect(rtTask?.routeStage).toBe(true)
        expect(rtTask?.routeTargets).toEqual(["bob"])
    })
})
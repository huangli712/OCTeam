/**
 * Advanced workflow tools: team_delegate, team_route, team_arbitrate,
 * team_tollgate, team_recurse. These are the "multi-track" orchestrations
 * (routing, gating, recursive decomposition, task delegation). Extracted from
 * the original workflow.ts. Also exports buildRouterPrompt (used by tests).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { dispatchToMember } from "../orchestration/dispatch.js"
import { createTask, listAllTasks, updateTask } from "../state/tasks.js"
import type { GatedStage, RouteBranch } from "../core/types.js"
import { buildRecursePrompt } from "../orchestration/recurse.js"
import { advanceToGatedStage } from "../orchestration/tollgate.js"
import { buildDebatePrompt } from "../orchestration/route-arbitrate.js"
import {
    DEFAULT_ARBITRATE_ROUNDS,
    DEFAULT_RECURSE_DEPTH,
    DEFAULT_RECURSE_SUBTASKS,
    DEFAULT_TIMEOUT_MS,
    assertMember,
    baseTaskFields,
    signoffTaskFields,
    signoffSchemaFields,
    startOrchestration,
    validateSignoff,
} from "./workflow-shared.js"

// --- team_delegate ---

/**
 * Detect a cycle in the blocked_by dependency graph declared by a delegate
 * call. Nodes are task refs; an edge ref -> dep means the ref'd task is
 * blocked_by dep. Returns the offending cycle path (e.g. ["A","B","A"]) or null
 * when the graph is acyclic. Only ref-bearing tasks can be dependency targets,
 * so a ref-less task is a pure source that cannot close a cycle. Callers must
 * have already validated that every blocked_by entry is a declared ref.
 */
export function detectBlockedByCycle(
    tasks: { ref?: string; blocked_by?: string[] }[],
): string[] | null {
    // Adjacency keyed by ref: ref -> refs it is blocked_by. Every blocked_by
    // entry is a declared ref (caller-validated), hence always a key here.
    const adjacency = new Map<string, string[]>()
    for (const t of tasks) {
        if (t.ref) adjacency.set(t.ref, t.blocked_by ?? [])
    }
    const UNVISITED = 0
    const IN_PATH = 1
    const DONE = 2
    const state = new Map<string, number>()
    const path: string[] = []

    const walk = (node: string): string[] | null => {
        state.set(node, IN_PATH)
        path.push(node)
        for (const dep of adjacency.get(node) ?? []) {
            const s = state.get(dep) ?? UNVISITED
            if (s === IN_PATH) {
                // Back-edge: close the cycle from dep's first occurrence.
                return [...path.slice(path.indexOf(dep)), dep]
            }
            if (s === UNVISITED) {
                const cycle = walk(dep)
                if (cycle) return cycle
            }
        }
        path.pop()
        state.set(node, DONE)
        return null
    }

    for (const node of adjacency.keys()) {
        if ((state.get(node) ?? UNVISITED) === UNVISITED) {
            const cycle = walk(node)
            if (cycle) return cycle
        }
    }
    return null
}

export function teamDelegateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Delegate mode: publish tasks to a shared tasklist; idle members self-claim, execute, and report to master. Supports blockedBy dependencies via human-readable refs.",
        args: {
            team_id: tool.schema.string().min(1),
            tasks: tool.schema
                .array(
                    tool.schema.object({
                        ref: tool.schema.string().optional().describe("human-readable id for blockedBy references"),
                        subject: tool.schema.string().min(1).max(500),
                        description: tool.schema.string().min(1).max(8192),
                        blocked_by: tool.schema.array(tool.schema.string()).optional(),
                    }),
                )
                .min(1)
                .max(200),
            ...signoffSchemaFields,
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_errored_members: tool.schema.number().int().min(0).optional().describe("tolerate up to N terminally-errored members and still deliver survivors' work. Default 0 (any member error fails the run)."),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_delegate",
                // validate
                (team) => {
                    // Pre-validate blockedBy refs against declared refs (before
                    // activeTask is set) so an invalid ref cannot leave the
                    // team in a dirty state.
                    const declaredRefs = new Set(args.tasks.filter(t => t.ref).map(t => t.ref!))
                    for (const t of args.tasks) {
                        if (!t.blocked_by) continue
                        for (const dep of t.blocked_by) {
                            if (!declaredRefs.has(dep)) {
                                return `Error: unknown blockedBy ref "${dep}"`
                            }
                        }
                    }
                    // wf-006: reject blocked_by cycles. The ref-existence
                    // check above only proves each dependency target exists; a
                    // cycle (A blocked_by B, B blocked_by A) still passes it
                    // but leaves every task in the cycle permanently
                    // unclaimable until the wall-clock deadlock backstop
                    // fires. Catch it here with a precise error instead.
                    const cycle = detectBlockedByCycle(args.tasks)
                    if (cycle) {
                        return `Error: blocked_by cycle detected: ${cycle.join(" -> ")}`
                    }
                    const signoffErr = validateSignoff(args, team)
                    if (signoffErr) return signoffErr
                    return null
                },
                // buildTask: enforce the task cap BEFORE creating any task, then
                // create all tasks BEFORE committing activeTask/status (wf-002,
                // wf-003 — a mid-loop failure leaves the team idle rather than
                // wedged in "busy" with an unpersisted activeTask). Counting +
                // creating both run under the mutex so the count cannot be
                // raced by a concurrent create.
                async (team) => {
                    const liveTaskCount = (await listAllTasks(team.directory)).filter(
                        t => t.status !== "deleted",
                    ).length
                    if (liveTaskCount + args.tasks.length > team.bounds.maxTasks) {
                        return { error: `Error: team task limit reached (${team.bounds.maxTasks}). ${liveTaskCount} live task(s) exist; cannot add ${args.tasks.length} more.` }
                    }

                    // Create all tasks, building ref -> uuid and index -> uuid
                    // maps, then resolve blockedBy. The index map keys every
                    // task by its position so blocked_by is applied even to
                    // tasks without their own ref (a ref is only needed to be
                    // a dependency *target*, not to *have* dependencies).
                    const refToUuid = new Map<string, string>()
                    const indexToUuid = new Map<number, string>()
                    for (let i = 0; i < args.tasks.length; i++) {
                        const t = args.tasks[i]
                        const created = await createTask(team.directory, {
                            subject: t.subject,
                            description: t.description,
                        })
                        indexToUuid.set(i, created.id)
                        if (t.ref) refToUuid.set(t.ref, created.id)
                    }
                    for (let i = 0; i < args.tasks.length; i++) {
                        const t = args.tasks[i]
                        const uuid = indexToUuid.get(i)
                        if (!uuid) continue
                        const blockedBy = (t.blocked_by ?? [])
                            .map(r => refToUuid.get(r)!)
                        if (blockedBy.length > 0) {
                            await updateTask(team.directory, uuid, { blockedBy })
                        }
                    }

                    return {
                        type: "delegate",
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        stages: [],
                        maxErroredMembers: args.max_errored_members,
                        ...signoffTaskFields(args),
                    }
                },
                // dispatch: prompt every member to start pulling from the
                // tasklist.
                async (team) => {
                    for (const m of team.members.filter(x => !x.isMaster)) {
                        const text =
                            `[Team Orchestrator] You are on team "${team.teamName}" in delegate mode. ` +
                            `${args.tasks.length} task(s) published. Use team_task_list to view, team_task_update (status "claimed") to claim, ` +
                            `execute, then team_send_message to report results to master. Repeat until no tasks remain.`
                        await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory, team)
                    }
                },
                // successMessage
                () => `team_delegate started on "${args.team_id}" with ${args.tasks.length} task(s).`,
            )
        },
    })
}

// --- team_route ---

/**
 * Build the router member's dispatch prompt: the input to route, the available
 * branches, and the <route> decision format the router must emit.
 */
export function buildRouterPrompt(teamName: string, input: string, branches: RouteBranch[]): string {
    const list = branches
        .map(b => {
            const desc = b.description ? ` — ${b.description}` : ""
            return `- ${b.name} (-> ${b.member})${desc}`
        })
        .join("\n")
    return (
        `[Route task] You are the router for team "${teamName}". Analyze the input below and `
        + `select which branch(es) should handle it. Available branches:\n${list}\n\n`
        + `Emit your decision as:\n`
        + `<route>{"branch": "<name>", "rationale": "<why>"}</route>\n`
        + `For multiple branches: <route>{"branches": ["a","b"], "rationale": "..."}</route>\n`
        + `The tags must be the literal English <route> and </route> — do NOT use translated tags such as <路由>.\n\n`
        + `[Input]\n${input}`
    )
}

export function teamRouteTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Content-Based Routing: a router member inspects the input and decides which branch(es) handle it; "
            + "selected branches run in parallel and their outputs are summarized to the leader. No default route — "
            + "an unmatched input fails the run.",
        args: {
            team_id: tool.schema.string().min(1),
            router: tool.schema.string().min(1).describe("member name of the router (NOT \"master\", NOT a branch member)"),
            input: tool.schema.string().min(1).max(32768).describe("the content to be routed (dispatched to the router; if a branch has no per-branch task, the branch member receives this input)"),
            routes: tool.schema
                .array(
                    tool.schema.object({
                        name: tool.schema.string().min(1).describe("branch label the router selects by (unique)"),
                        member: tool.schema.string().min(1).describe("target member to dispatch to (unique across branches)"),
                        task: tool.schema.string().min(1).max(8192).optional().describe("per-branch task; if omitted, the branch member receives the routing `input`"),
                        description: tool.schema.string().max(1024).optional().describe("hint shown to the router"),
                    }),
                )
                .min(1),
            ...signoffSchemaFields,
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_route",
                // validate
                (team) => {
                    if (args.router === "master") {
                        return "Error: router must be a member name, not \"master\""
                    }
                    // Validate routes: unique names, unique members, members
                    // exist, and the router must not also be a branch target
                    // (it is the sole Phase-A advancer — routing to itself
                    // would deadlock).
                    const branchNames = args.routes.map(r => r.name)
                    if (new Set(branchNames).size !== branchNames.length) {
                        return "Error: route branch names must be unique"
                    }
                    const branchMembers = args.routes.map(r => r.member)
                    if (new Set(branchMembers).size !== branchMembers.length) {
                        return "Error: route branch members must be unique"
                    }
                    if (branchMembers.includes(args.router)) {
                        return "Error: router must not also be a branch target"
                    }
                    for (const name of [args.router, ...branchMembers]) {
                        if (!team.members.some(m => m.name === name)) {
                            return `Error: unknown member "${name}" in router/routes`
                        }
                    }
                    const signoffErr = validateSignoff(args, team)
                    if (signoffErr) return signoffErr
                    return null
                },
                // buildTask
                async (team) => {
                    const branches: RouteBranch[] = args.routes.map(r => ({
                        name: r.name,
                        member: r.member,
                        task: r.task,
                        description: r.description,
                    }))
                    return {
                        type: "route",
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        stages: [],
                        task: args.input,
                        routerMember: args.router,
                        routeBranches: branches,
                        routeStage: false,
                        ...signoffTaskFields(args),
                    }
                },
                // dispatch: ONLY the router; it decides the targets (Phase A).
                async (team, task) => {
                    if (task.type !== "route") return
                    const routerMember = team.members.find(m => m.name === args.router)!
                    const prompt = buildRouterPrompt(team.teamName, args.input, task.routeBranches ?? [])
                    await dispatchToMember(ctx, routerMember, prompt, routerMember.worktreePath ?? ctx.directory, team)
                },
                // successMessage
                () => `team_route started on "${args.team_id}" (router: ${args.router}, ${args.routes.length} route(s)).`,
            )
        },
    })
}

// --- team_arbitrate ---

export function teamArbitrateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Authoritative ruling: debaters argue a dispute over up to max_rounds rounds, then a single arbiter weighs all positions and issues a binding ruling. The arbiter must not be one of the debaters.",
        args: {
            team_id: tool.schema.string().min(1),
            task: tool.schema.string().min(1).max(8192).describe("the dispute / subject under arbitration"),
            arbiter: tool.schema.string().min(1).describe("member name of the arbiter (NOT \"master\", NOT a debater)"),
            debaters: tool.schema
                .array(tool.schema.string().min(1))
                .min(2)
                .describe("debater member names (at least 2, unique; none may be the arbiter)"),
            max_rounds: tool.schema.number().min(1).max(20).optional().describe("debate round limit before the ruling (default 1)"),
            ...signoffSchemaFields,
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_arbitrate",
                // validate
                (team) => {
                    if (args.arbiter === "master") {
                        return "Error: arbiter must be a member name, not \"master\""
                    }
                    if (new Set(args.debaters).size !== args.debaters.length) {
                        return "Error: debaters must have unique names"
                    }
                    if (args.debaters.includes(args.arbiter)) {
                        return "Error: arbiter must not also be a debater"
                    }
                    // Validate arbiter + debaters are real members.
                    for (const name of [args.arbiter, ...args.debaters]) {
                        if (!team.members.some(m => m.name === name)) {
                            return `Error: unknown member "${name}" in arbiter/debaters`
                        }
                    }
                    const signoffErr = validateSignoff(args, team)
                    if (signoffErr) return signoffErr
                    return null
                },
                // buildTask
                async (team) => ({
                    type: "arbitrate",
                    ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                    stages: [],
                    task: args.task,
                    arbiterMember: args.arbiter,
                    disputants: args.debaters,
                    arbitrationStage: false,
                    maxRounds: args.max_rounds ?? DEFAULT_ARBITRATE_ROUNDS,
                    currentRound: 1,
                    ...signoffTaskFields(args),
                }),
                // dispatch: ONLY the debaters (round 1); the arbiter waits for
                // the ruling phase.
                async (team, task) => {
                    for (const name of args.debaters) {
                        const m = team.members.find(x => x.name === name && !x.isMaster)
                        if (!m) continue
                        await dispatchToMember(ctx, m, buildDebatePrompt(task), m.worktreePath ?? ctx.directory, team)
                    }
                },
                // successMessage
                () => `team_arbitrate started on "${args.team_id}" (arbiter: ${args.arbiter}, ${args.debaters.length} debater(s)).`,
            )
        },
    })
}

// --- team_tollgate ---

export function teamTollgateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Verdict-gated pipeline: between each stage sits a three-valued verification gate. A downstream stage starts "
            + "only on a verifier's PASS verdict. FAIL returns the producer with a diff (up to max_gate_retries, then the "
            + "run fails). INVALID (verifier/reference cannot evaluate) isolates the stage and escalates the verifier side "
            + "— the producer is NOT penalized. Each gate's verifier must differ from its producer.",
        args: {
            team_id: tool.schema.string().min(1),
            stages: tool.schema
                .array(
                    tool.schema.object({
                        member: tool.schema.string().min(1).describe("the producer member name"),
                        task: tool.schema.string().min(1).max(8192).describe("the producer's task"),
                        verifier: tool.schema.string().min(1).describe("the verifier member name (must differ from member)"),
                        criteria: tool.schema.string().min(1).max(8192).describe("verification criteria (tolerance / conservation law / reference description)"),
                        reference: tool.schema.string().max(8192).optional().describe("golden reference location for a Compare-style numerical verdict"),
                    }),
                )
                .min(1),
            escalate_to: tool.schema
                .string()
                .optional()
                .describe("INVALID escalation target member. When unset, an INVALID verdict is escalated to the leader."),
            max_gate_retries: tool.schema
                .number()
                .int()
                .min(0)
                .optional()
                .describe("gate FAIL retry cap, DISTINCT from provider-retry max_retries. Default 0 (first FAIL fails)."),
            max_invalid_cycles: tool.schema
                .number()
                .int()
                .min(0)
                .optional()
                .describe("cap on INVALID/escalate ping-pong per gate. Default 3; beyond it the run fails with tollgate_invalid:exhausted instead of burning wall-clock/turn budget."),
            ...signoffSchemaFields,
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0. Distinct from max_gate_retries."),
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_tollgate",
                // validate
                (team) => {
                    // Each gate's verifier must differ from its producer (no
                    // self-verification).
                    for (const s of args.stages) {
                        if (s.verifier === s.member) {
                            return `Error: stage verifier "${s.verifier}" must not equal its producer "${s.member}"`
                        }
                    }
                    // Validate members: every stage's producer + verifier,
                    // plus the optional escalation target.
                    const namedMembers = new Set<string>()
                    for (const s of args.stages) {
                        namedMembers.add(s.member)
                        namedMembers.add(s.verifier)
                    }
                    if (args.escalate_to) namedMembers.add(args.escalate_to)
                    for (const name of namedMembers) {
                        if (!team.members.some(m => m.name === name)) {
                            return `Error: unknown member "${name}" in stages/escalate_to`
                        }
                    }
                    const signoffErr = validateSignoff(args, team)
                    if (signoffErr) return signoffErr
                    return null
                },
                // buildTask
                async (team) => {
                    const gatedStages: GatedStage[] = args.stages.map(s => ({
                        member: s.member,
                        task: s.task,
                        completed: false,
                        verifier: s.verifier,
                        criteria: s.criteria,
                        reference: s.reference,
                        attempts: 0,
                        invalidAttempts: 0,
                    }))
                    return {
                        type: "tollgate",
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        stages: [],
                        gatedStages,
                        tollgatePhase: "produce",
                        escalateTo: args.escalate_to,
                        maxGateRetries: args.max_gate_retries,
                        maxInvalidCycles: args.max_invalid_cycles,
                        ...signoffTaskFields(args),
                    }
                },
                // dispatch: ONLY the stage-0 producer; verification starts
                // when it idles.
                async (_team, task) => {
                    if (task.type !== "tollgate") return
                    // Guard against an empty stages array defensively — the zod
                    // schema enforces min(1), but the non-null assertion `!` is
                    // removed so a future schema regression cannot feed
                    // `undefined` into advanceToGatedStage.
                    const first = task.gatedStages?.[0]
                    if (!first) return
                    await advanceToGatedStage(ctx, _team, first)
                },
                // successMessage
                () => `team_tollgate started on "${args.team_id}" with ${args.stages.length} gate(s).`,
            )
        },
    })
}

// --- team_recurse ---

export function teamRecurseTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Hierarchical recursive decomposition: a root task is decomposed into subtasks (which may themselves decompose up to max_depth), sub-task results are aggregated back up, until the root is solved. Uses the shared task list and blockedBy DAG for layered aggregation.",
        args: {
            team_id: tool.schema.string().min(1),
            task: tool.schema.string().min(1).max(8192).describe("the root task / goal to recursively decompose and solve"),
            decomposer: tool.schema.string().min(1).describe("member name first dispatched with the root task (NOT \"master\"); decomposition is open to all members"),
            max_depth: tool.schema.number().int().min(1).max(8).optional().describe("recursion depth upper bound (default 3). Tasks at this depth cannot decompose further."),
            max_subtasks: tool.schema.number().int().min(1).max(20).optional().describe("per-decomposition subtask upper bound (default 5)"),
            ...signoffSchemaFields,
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
            max_errored_members: tool.schema.number().int().min(0).optional().describe("tolerate up to N terminally-errored members and still deliver survivors' work. Default 0 (any member error fails the run). Recurse uses a shared task pool like delegate, so failure isolation applies to independent subtask execution."),
        },
        async execute(args, context) {
            let rootTaskId = ""
            return startOrchestration(
                args.team_id, context, ctx, "team_recurse",
                // validate
                (team) => {
                    if (args.decomposer === "master") {
                        return "Error: decomposer must be a member name, not \"master\""
                    }
                    const decomposerErr = assertMember(team, args.decomposer, "decomposer")
                    if (decomposerErr) return decomposerErr
                    const signoffErr = validateSignoff(args, team)
                    if (signoffErr) return signoffErr
                    return null
                },
                // buildTask: seed the root task BEFORE committing activeTask
                // so a mid-create failure leaves the team idle.
                async (team) => {
                    const subject = args.task.length <= 480 ? args.task : args.task.slice(0, 477) + "..."
                    const root = await createTask(team.directory, {
                        subject,
                        description: args.task,
                        depth: 0,
                    })
                    rootTaskId = root.id
                    return {
                        type: "recurse",
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        stages: [],
                        task: args.task,
                        decomposerMember: args.decomposer,
                        maxDepth: args.max_depth ?? DEFAULT_RECURSE_DEPTH,
                        maxSubtasks: args.max_subtasks ?? DEFAULT_RECURSE_SUBTASKS,
                        rootTaskId: root.id,
                        maxErroredMembers: args.max_errored_members,
                        ...signoffTaskFields(args),
                    }
                },
                // dispatch: ONLY the decomposer with the recursive contract;
                // other members pull claimable tasks via the tail's re-prompt.
                async (team) => {
                    const decomposer = team.members.find(m => m.name === args.decomposer && !m.isMaster)
                    if (decomposer) {
                        await dispatchToMember(ctx, decomposer, buildRecursePrompt(), decomposer.worktreePath ?? ctx.directory, team)
                    }
                },
                // successMessage
                () => `team_recurse started on "${args.team_id}" (decomposer: ${args.decomposer}, root task: ${rootTaskId}).`,
            )
        },
    })
}

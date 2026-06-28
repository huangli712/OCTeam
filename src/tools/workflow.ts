/**
 * Workflow tools: team_parallel, team_consensus, team_pipeline, team_loop,
 * team_delegate, team_route, team_arbitrate, team_recurse, team_tollgate.
 *
 * ALL NINE share the same three-phase lock order via startOrchestration
 * (team_resume follows the same Phase 2 contract too — see resume.ts):
 *   1. Pre-checks UNDER team.mutex (reject if already orchestrating; validate)
 *   2. ensureMembersReady OUTSIDE the mutex (the role-setup barrier needs the
 *      event handler to flip member.initialized, which it does inside the
 *      mutex — holding it here would deadlock)
 *   3. Commit activeTask + dispatch the first stage UNDER the mutex
 *
 * Between phases 1 and 3 there is a brief window, but activeTask is not yet
 * written, so any early member idle is safely handled by processIdle Step 1.5
 * (barrier) / Step 6 (no active task → return).
 *
 * INVARIANT: never call ensureMembersReady inside team.mutex.runExclusive — it
 * will deadlock the role-setup barrier. This is enforced structurally by
 * startOrchestration; the per-tool callbacks (validate/buildTask/dispatch)
 * cannot violate it.
 */

import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { loadTeamState, saveTeamState, type Team } from "../state/store.js"
import { ensureMembersReady, advanceToStage, dispatchToMember } from "../orchestration/dispatch.js"
import { createTask, listAllTasks, updateTask } from "../state/tasks.js"
import { activationError } from "../core/utils.js"
import { resolveCallerInTeam } from "../state/resolve.js"
import type { ActiveTask, DecisionRecord, GatedStage, ReducePolicy, RouteBranch, SignoffPolicy, Stage } from "../core/types.js"
import { advanceToGatedStage, buildDebatePrompt, buildRecursePrompt } from "../orchestration/handlers.js"

const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_LOOP_TIMEOUT_MS = 900_000

// Named defaults for orchestration parameters (wf-011). Previously these were
// scattered as inline `?? N` literals across the Phase-3 commit blocks, which
// made the effective defaults hard to audit and easy to drift between tools.
const DEFAULT_CONSENSUS_ROUNDS = 3
const DEFAULT_ARBITRATE_ROUNDS = 1
const DEFAULT_RECURSE_DEPTH = 3
const DEFAULT_RECURSE_SUBTASKS = 5
const DEFAULT_SIGNOFF_POLICY: SignoffPolicy = "none"
const DEFAULT_REDUCE_POLICY: ReducePolicy = "summarize"

/**
 * Assert that `name` is a member of `team`. Returns a ready-to-return Error
 * string when the name does not match any member, or null when it is valid
 * (wf-008). `label` identifies the offending field in the message (e.g.
 * "signoff_decider", "decomposer"). The message format is kept identical to the
 * previous inline checks so existing error-string assertions still hold.
 */
function assertMember(team: Team, name: string, label: string): string | null {
    if (!team.members.some(m => m.name === name)) {
        return `Error: ${label} "${name}" is not a member of team "${team.teamName}"`
    }
    return null
}

/**
 * Effective wall-clock timeout: the requested timeout (or a mode default)
 * clamped to the team's hard cap bounds.maxWallClockMinutes. Without this
 * clamp a caller could pass timeout_ms far above the team's configured limit. A
 * non-positive cap (e.g. a hand-edited state.json) is treated as "no cap" rather
 * than collapsing the timeout to 0, which would abort every orchestration.
 */
function effectiveTimeoutMs(
    requestedMs: number | undefined,
    defaultMs: number,
    maxWallClockMinutes: number,
): number {
    const requested = requestedMs ?? defaultMs
    const cap = maxWallClockMinutes > 0 ? maxWallClockMinutes * 60_000 : Infinity
    return Math.min(requested, cap)
}

/**
 * Shared three-phase orchestration startup (wf-004). All nine workflow tools
 * follow the same spine — the per-tool boilerplate has been collapsed into
 * this helper. Phases:
 *   1. master-only auth (resolveCallerInTeam + isMaster), auth-first (wf-009)
 *   2. loadTeamState + activationError gate
 *   3. tool-specific validation (validate callback)
 *   4. Phase 1: busy pre-check under mutex
 *   5. Phase 2: ensureMembersReady OUTSIDE mutex (the role-setup barrier needs
 *      the event handler to flip member.initialized, which runs inside the
 *      mutex — holding it here would deadlock)
 *   6. Phase 3: commit activeTask + initial dispatch UNDER mutex
 *   7. success message
 *
 * Tool-specific concerns are supplied via callbacks:
 *   - validate(team): input checks needing team state (member existence,
 *     mode/task consistency, etc.). Return an error string to bail, or null.
 *   - buildTask(team): construct the type-specific ActiveTask. May perform
 *     pre-commit side effects (delegate creates tasks, recurse creates the
 *     root task). Return { error } to bail before any commit (delegate's
 *     task-cap check), or the ActiveTask to commit.
 *   - dispatch(team, task): initial member dispatch(es) after activeTask is
 *     committed and per-member flags reset.
 *   - successMessage(): success string (may close over variables set inside
 *     buildTask, e.g. recurse's rootTaskId).
 */
async function startOrchestration(
    teamId: string,
    context: ToolContext,
    ctx: PluginContext,
    toolName: string,
    validate: (team: Team) => string | null,
    buildTask: (team: Team) => Promise<ActiveTask | { error: string }>,
    dispatch: (team: Team, task: ActiveTask) => Promise<void>,
    successMessage: () => string,
): Promise<string> {
    // Step 1: master-only auth. Auth-first (wf-009): runs before any parameter
    // validation so a non-master caller never learns whether its arguments
    // were well-formed.
    const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, teamId)
    if (!caller?.isMaster) {
        return `Error: ${toolName} is master-only`
    }

    // Step 2: load + activation gate. The master may only orchestrate the
    // active team.
    const team = await loadTeamState(ctx.storageRoot, teamId, caller.leadSessionId)
    const gate = activationError(team.teamName, team.activatedAt)
    if (gate) return gate

    // Step 3: tool-specific validation.
    const validationError = validate(team)
    if (validationError) return validationError

    // Step 4: Phase 1 — busy pre-check under mutex.
    let busy = false
    await team.mutex.runExclusive(async () => {
        if (team.activeTask) busy = true
    })
    if (busy) return "Error: team already has an active orchestration"
    let raced = false
    let buildError: string | undefined

    // Step 5: Phase 2 — spawn + role-setup barrier (OUTSIDE mutex).
    await ensureMembersReady(ctx, team)

    // Step 6: Phase 3 — commit activeTask + initial dispatch (UNDER mutex).
    await team.mutex.runExclusive(async () => {
        if (team.activeTask) { raced = true; return } // Re-check inside mutex (prevents double-commit race)
        const built = await buildTask(team)
        if ("error" in built) {
            buildError = built.error
            return
        }
        team.status = "busy"
        team.activeTask = built
        await saveTeamState(team)
        // Reset per-member done/retry flags for the new run so a previous
        // run's acks don't bleed in. declaredDone only matters when
        // requireDoneAck is true, but cheap to always reset.
        for (const m of team.members) {
            m.declaredDone = false
            m.retryCount = 0
        }
        await dispatch(team, built)
    })
    if (raced) return "Error: team already has an active orchestration"
    if (buildError) return buildError

    // Step 7: success.
    return successMessage()
}

/**
 * Validate the signoff_policy 'decider' field: requires signoff_decider to be
 * present and name a real team member. Shared by the 7 tools that expose
 * signoff (all except consensus and loop). Returns an error string or null.
 */
function validateSignoff(
    args: { signoff_policy?: SignoffPolicy; signoff_decider?: string },
    team: Team,
): string | null {
    if (args.signoff_policy !== "decider") return null
    if (!args.signoff_decider) {
        return "Error: signoff_policy 'decider' requires signoff_decider (a member name)"
    }
    return assertMember(team, args.signoff_decider, "signoff_decider")
}

/**
 * The three signoff fields shared by every ActiveTask variant that supports
 * post-completion review. Consensus has its own built-in agreement gate, so it
 * hardcodes DEFAULT_SIGNOFF_POLICY and omits decider/quorum.
 */
function signoffTaskFields(
    args: { signoff_policy?: SignoffPolicy; signoff_decider?: string; signoff_quorum?: number },
): { signoffPolicy: SignoffPolicy; signoffDecider: string | undefined; signoffQuorum: number | undefined } {
    return {
        signoffPolicy: args.signoff_policy ?? DEFAULT_SIGNOFF_POLICY,
        signoffDecider: args.signoff_decider,
        signoffQuorum: args.signoff_quorum,
    }
}

/**
 * The common ActiveTask base fields shared by all 9 orchestration tools.
 * Tool-specific fields (type discriminant, stages, per-mode fields) are added
 * by the caller AFTER spreading this.
 */
function baseTaskFields(
    args: { timeout_ms?: number; token_budget?: number; max_retries?: number },
    team: Team,
    defaultTimeoutMs: number,
): {
    runId: string
    startedAt: number
    wallClockTimeoutMs: number
    tokenBudget: number | undefined
    tokensUsed: number
    tokensByMember: Record<string, number>
    messagesSent: number
    responses: Record<string, string>
    currentStageIndex: number
    decisionHistory: DecisionRecord[]
    decisionParseFailures: number
    maxRetries: number | undefined
} {
    return {
        runId: crypto.randomUUID(),
        startedAt: Date.now(),
        wallClockTimeoutMs: effectiveTimeoutMs(args.timeout_ms, defaultTimeoutMs, team.bounds.maxWallClockMinutes),
        tokenBudget: args.token_budget,
        tokensUsed: 0,
        tokensByMember: {},
        messagesSent: 0,
        responses: {},
        currentStageIndex: 0,
        decisionHistory: [],
        decisionParseFailures: 0,
        maxRetries: args.max_retries,
    }
}


// --- team_parallel ---

export function teamParallelTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Run a task across all members in parallel. Modes: isolated (same task, no comms), collaborative (per-member tasks, free comms). For multi-round debate to consensus, use team_consensus.",
        args: {
            team_id: tool.schema.string().min(1),
            mode: tool.schema.enum(["isolated", "collaborative"]),
            task: tool.schema.string().max(8192).optional().describe("isolated mode: the single task sent to all members"),
            tasks: tool.schema
                .record(tool.schema.string(), tool.schema.string().max(8192))
                .optional()
                .describe("collaborative mode: { memberName: task }"),
            reduce_policy: tool.schema
                .enum(["summarize", "select", "merge", "rubric"])
                .optional()
                .describe("how to combine member outputs (default: summarize)."),
            reduce_rubric: tool.schema
                .string()
                .max(8192)
                .optional()
                .describe("scoring rubric when reduce_policy='rubric'"),
            reducer_member: tool.schema
                .string()
                .optional()
                .describe("member that performs a real reduce when reduce_policy != summarize. If omitted, the reduce guidance is delivered to master (legacy behavior)."),
            signoff_policy: tool.schema
                .enum(["none", "decider", "peer-quorum"])
                .optional()
                .describe("post-completion review gate. 'none' (default): direct delivery. 'decider': named member reviews. 'peer-quorum': all members vote."),
            signoff_decider: tool.schema
                .string()
                .optional()
                .describe("member name to act as signoff decider (when signoff_policy='decider')"),
            signoff_quorum: tool.schema
                .number()
                .gt(0)
                .max(1)
                .optional()
                .describe("fraction of members needed for peer-quorum (default 0.5 = majority). Only when signoff_policy='peer-quorum'."),
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_errored_members: tool.schema.number().int().min(0).optional().describe("tolerate up to N terminally-errored members and still deliver survivors' work. Default 0 (any member error fails the run)."),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
            require_done_ack: tool.schema
                .boolean()
                .optional()
                .describe("when true, the all-idle barrier is replaced by an all-acked barrier. Members must call team_done() to signal completion; members that go idle without acking receive an automatic re-prompt. Prevents premature barrier when a member idles waiting for a dependency. Default false (backward compatible)."),
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_parallel",
                // validate
                (team) => {
                    if (args.mode === "isolated" && !args.task) {
                        return "Error: isolated mode requires `task`"
                    }
                    if (args.mode === "collaborative" && !args.tasks) {
                        return "Error: collaborative mode requires `tasks`"
                    }
                    // wf-010: every key in the collaborative `tasks` map must
                    // name a real non-master member. An unknown key is a typo
                    // whose task would never be dispatched, so reject it
                    // instead of silently ignoring it.
                    if (args.mode === "collaborative" && args.tasks) {
                        for (const name of Object.keys(args.tasks)) {
                            if (!team.members.some(m => m.name === name && !m.isMaster)) {
                                return `Error: unknown member "${name}" in tasks`
                            }
                        }
                    }
                    // wf-007: reduce_policy 'rubric' scores outputs against
                    // reduce_rubric, so the rubric text must be present.
                    if (args.reduce_policy === "rubric" && !args.reduce_rubric) {
                        return "Error: reduce_policy 'rubric' requires reduce_rubric (the scoring rubric)"
                    }
                    const signoffErr = validateSignoff(args, team)
                    if (signoffErr) return signoffErr
                    // Validate reducer_member is a real member.
                    if (args.reduce_policy && args.reduce_policy !== "summarize" && args.reducer_member) {
                        const err = assertMember(team, args.reducer_member, "reducer_member")
                        if (err) return err
                    }
                    return null
                },
                // buildTask
                async (team) => ({
                    type: "parallel",
                    ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                    mode: args.mode,
                    stages: [],
                    task: args.task,
                    tasks: args.tasks,
                    reducePolicy: args.reduce_policy ?? DEFAULT_REDUCE_POLICY,
                    reduceRubric: args.reduce_rubric,
                    reducerMember: args.reducer_member,
                    requireDoneAck: args.require_done_ack === true,
                    maxErroredMembers: args.max_errored_members,
                    ...signoffTaskFields(args),
                }),
                // dispatch
                async (team) => {
                    const participants = team.members.filter(m => !m.isMaster)
                    for (const m of participants) {
                        const text = args.mode === "isolated"
                            ? args.task!
                            : (args.tasks![m.name] ?? `No task assigned for ${m.name}.`)
                        await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory, team)
                    }
                },
                // successMessage
                () => `team_parallel (${args.mode}) started on "${args.team_id}".`,
            )
        },
    })
}

// --- team_consensus ---

export function teamConsensusTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Run a multi-round structured debate across all members until they reach consensus. Each round, members state positions and emit <consensus>{\"agreed\": true|false}</consensus>; the run ends when all agree, or fails when max_rounds is hit without consensus.",
        args: {
            team_id: tool.schema.string().min(1),
            topic: tool.schema.string().min(1).max(4096).describe("the debate topic"),
            max_rounds: tool.schema.number().min(1).max(20).optional().describe("round limit (default 3)"),
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_consensus",
                // validate
                (team) => {
                    // wf-016: a consensus needs at least two participants to be
                    // meaningful — a single member trivially "agrees" with
                    // itself.
                    const consensusParticipants = team.members.filter(m => !m.isMaster)
                    if (consensusParticipants.length < 2) {
                        return "Error: team_consensus requires at least 2 non-master members"
                    }
                    return null
                },
                // buildTask
                async (team) => ({
                    type: "consensus",
                    ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                    stages: [],
                    topic: args.topic,
                    // Needs a round cap; default to DEFAULT_CONSENSUS_ROUNDS
                    // when omitted, else `currentRound >= (maxRounds ?? 0)`
                    // aborts after round 1.
                    maxRounds: args.max_rounds ?? DEFAULT_CONSENSUS_ROUNDS,
                    currentRound: 1,
                    // wf-013: consensus intentionally has no signoff gate. The
                    // run itself is an allMembersAgree mechanism — it only
                    // succeeds when every participant emits agreed=true — so a
                    // separate post-completion signoff stage would be redundant.
                    // Unlike the 8 orchestration tools that expose
                    // signoff_policy, consensus uses its built-in consensus
                    // gate as the agreement check.
                    signoffPolicy: DEFAULT_SIGNOFF_POLICY,
                }),
                // dispatch: round 1 to every participant.
                async (team, task) => {
                    const participants = team.members.filter(m => !m.isMaster)
                    for (const m of participants) {
                        const text = `[Consensus topic] ${args.topic}\n\nRound ${task.currentRound}. State your position. End with <consensus>{"agreed": true|false}</consensus> (or the Chinese <共识>{"agreed": ...}</共识>).`
                        await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory, team)
                    }
                },
                // successMessage
                () => `team_consensus started on "${args.team_id}".`,
            )
        },
    })
}

// --- team_pipeline ---

export function teamPipelineTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Run a linear pipeline: stage N's output is prefixed onto stage N+1's task. Each stage runs on its named member, in order. The final output is summarized to the leader.",
        args: {
            team_id: tool.schema.string().min(1),
            stages: tool.schema
                .array(
                    tool.schema.object({
                        member: tool.schema.string().min(1),
                        task: tool.schema.string().min(1).max(8192),
                    }),
                )
                .min(1),
            signoff_policy: tool.schema
                .enum(["none", "decider", "peer-quorum"])
                .optional()
                .describe("post-completion review gate. 'none' (default): direct delivery. 'decider': named member reviews. 'peer-quorum': all members vote (Phase D)."),
            signoff_decider: tool.schema
                .string()
                .optional()
                .describe("member name to act as signoff decider (when signoff_policy='decider')"),
            signoff_quorum: tool.schema
                .number()
                .gt(0)
                .max(1)
                .optional()
                .describe("fraction of members needed for peer-quorum (default 0.5 = majority). Only when signoff_policy='peer-quorum'."),
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_pipeline",
                // validate
                (team) => {
                    const stageMembers = args.stages.map(s => s.member)
                    if (new Set(stageMembers).size !== stageMembers.length) {
                        return "Error: pipeline stages must have unique member names"
                    }
                    const signoffErr = validateSignoff(args, team)
                    if (signoffErr) return signoffErr
                    // Validate members exist.
                    for (const name of stageMembers) {
                        if (!team.members.some(m => m.name === name)) {
                            return `Error: unknown member "${name}" in stages`
                        }
                    }
                    return null
                },
                // buildTask
                async (team) => {
                    const stages: Stage[] = args.stages.map(s => ({
                        member: s.member,
                        task: s.task,
                        completed: false,
                    }))
                    return {
                        type: "pipeline",
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        stages,
                        ...signoffTaskFields(args),
                    }
                },
                // dispatch: stage 0.
                async (team, task) => {
                    const first = team.members.find(m => m.name === task.stages[0].member)!
                    await dispatchToMember(ctx, first, task.stages[0].task, first.worktreePath ?? ctx.directory, team)
                },
                // successMessage
                () => `team_pipeline started on "${args.team_id}" with ${args.stages.length} stage(s).`,
            )
        },
    })
}

// --- team_loop ---

export function teamLoopTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Run a corrective loop: code -> review -> decide -> repeat. The decider (a member, NOT master) emits a <decision>{...} block each round. Loops until done, max_rounds, no-issues, timeout, or 3 consecutive parse failures.",
        args: {
            team_id: tool.schema.string().min(1),
            stages: tool.schema
                .array(
                    tool.schema.object({
                        member: tool.schema.string().min(1),
                        task: tool.schema.string().min(1).max(8192),
                        action: tool.schema.enum(["modify", "read_only"]).optional(),
                    }),
                )
                .min(1),
            decider: tool.schema.string().min(1).describe("member name of the decider (NOT \"master\")"),
            max_rounds: tool.schema.number().min(1).max(50),
            initial_task: tool.schema.string().min(1).max(8192),
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_loop",
                // validate
                (team) => {
                    if (args.decider === "master") {
                        return "Error: decider must be a member name, not \"master\""
                    }
                    const deciderErr = assertMember(team, args.decider, "decider")
                    if (deciderErr) return deciderErr
                    const stageMembers = args.stages.map(s => s.member)
                    if (new Set(stageMembers).size !== stageMembers.length) {
                        return "Error: loop stages must have unique member names"
                    }
                    for (const name of stageMembers) {
                        if (!team.members.some(m => m.name === name)) {
                            return `Error: unknown member "${name}" in stages`
                        }
                    }
                    return null
                },
                // buildTask (append decider as a final read-only stage if not
                // already present).
                async (team) => {
                    const stages: Stage[] = args.stages.map(s => ({
                        member: s.member,
                        task: s.task,
                        action: s.action,
                        completed: false,
                    }))
                    if (!stages.some(s => s.member === args.decider)) {
                        stages.push({
                            member: args.decider,
                            task: 'Review all outputs, then emit a <decision> block with JSON body. The tags must be the literal English <decision> and </decision> — do NOT use translated tags such as <决策>. Required JSON fields: "decision" (string, literally "done" or "continue" — not boolean), "rationale" (string), "nextActions" (string[]). Example: <decision>{"decision":"done","rationale":"checks passed","nextActions":[]}</decision>',
                            action: "read_only",
                            completed: false,
                        })
                    }
                    return {
                        type: "loop",
                        ...baseTaskFields(args, team, DEFAULT_LOOP_TIMEOUT_MS),
                        stages,
                        deciderMember: args.decider,
                        currentRound: 1,
                        maxRounds: args.max_rounds,
                    }
                },
                // dispatch: first stage with the initial task.
                async (team, task) => {
                    const first = team.members.find(m => m.name === task.stages[0].member)!
                    await dispatchToMember(ctx, first, args.initial_task, first.worktreePath ?? ctx.directory, team)
                },
                // successMessage
                () => `team_loop started on "${args.team_id}" (decider: ${args.decider}, max ${args.max_rounds} rounds).`,
            )
        },
    })
}

// --- team_delegate ---

/**
 * Detect a cycle in the blocked_by dependency graph declared by a delegate
 * call. Nodes are task refs; an edge ref -> dep means the ref'd task is
 * blocked_by dep. Returns the offending cycle path (e.g. ["A","B","A"]) or null
 * when the graph is acyclic. Only ref-bearing tasks can be dependency targets,
 * so a ref-less task is a pure source that cannot close a cycle. Callers must
 * have already validated that every blocked_by entry is a declared ref.
 */
function detectBlockedByCycle(
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
            signoff_policy: tool.schema
                .enum(["none", "decider", "peer-quorum"])
                .optional()
                .describe("post-completion review gate. 'none' (default): direct delivery. 'decider': named member reviews. 'peer-quorum': all members vote (Phase D)."),
            signoff_decider: tool.schema
                .string()
                .optional()
                .describe("member name to act as signoff decider (when signoff_policy='decider')"),
            signoff_quorum: tool.schema
                .number()
                .gt(0)
                .max(1)
                .optional()
                .describe("fraction of members needed for peer-quorum (default 0.5 = majority). Only when signoff_policy='peer-quorum'."),
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
            signoff_policy: tool.schema
                .enum(["none", "decider", "peer-quorum"])
                .optional()
                .describe("post-completion review gate. 'none' (default): direct delivery. 'decider': named member reviews. 'peer-quorum': all members vote."),
            signoff_decider: tool.schema
                .string()
                .optional()
                .describe("member name to act as signoff decider (when signoff_policy='decider')"),
            signoff_quorum: tool.schema
                .number()
                .gt(0)
                .max(1)
                .optional()
                .describe("fraction of members needed for peer-quorum (default 0.5 = majority). Only when signoff_policy='peer-quorum'."),
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
            signoff_policy: tool.schema
                .enum(["none", "decider", "peer-quorum"])
                .optional()
                .describe("post-completion review gate. 'none' (default): direct delivery. 'decider': named member reviews. 'peer-quorum': all members vote."),
            signoff_decider: tool.schema
                .string()
                .optional()
                .describe("member name to act as signoff decider (when signoff_policy='decider')"),
            signoff_quorum: tool.schema
                .number()
                .gt(0)
                .max(1)
                .optional()
                .describe("fraction of members needed for peer-quorum (default 0.5 = majority). Only when signoff_policy='peer-quorum'."),
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
            signoff_policy: tool.schema
                .enum(["none", "decider", "peer-quorum"])
                .optional()
                .describe("post-completion review gate (runs after all gates PASS). 'none' (default): direct delivery. 'decider': named member reviews. 'peer-quorum': all members vote."),
            signoff_decider: tool.schema
                .string()
                .optional()
                .describe("member name to act as signoff decider (when signoff_policy='decider')"),
            signoff_quorum: tool.schema
                .number()
                .gt(0)
                .max(1)
                .optional()
                .describe("fraction of members needed for peer-quorum (default 0.5 = majority). Only when signoff_policy='peer-quorum'."),
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
                    await advanceToGatedStage(ctx, _team, task.gatedStages![0])
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
            signoff_policy: tool.schema
                .enum(["none", "decider", "peer-quorum"])
                .optional()
                .describe("post-completion review gate. 'none' (default): direct delivery. 'decider': named member reviews. 'peer-quorum': all members vote."),
            signoff_decider: tool.schema
                .string()
                .optional()
                .describe("member name to act as signoff decider (when signoff_policy='decider')"),
            signoff_quorum: tool.schema
                .number()
                .gt(0)
                .max(1)
                .optional()
                .describe("fraction of members needed for peer-quorum (default 0.5 = majority). Only when signoff_policy='peer-quorum'."),
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
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

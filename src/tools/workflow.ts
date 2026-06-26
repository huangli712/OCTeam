/**
 * Workflow tools: team_parallel, team_pipeline, team_loop, team_delegate
 * (parallel/consesnus/pipeline/loop/delegate).
 *
 * All four follow the SAME three-phase lock order:
 *   1. Pre-checks UNDER team.mutex (reject if already orchestrating; validate)
 *   2. ensureMembersReady OUTSIDE the mutex (the role-setup barrier needs the
 *      event handler to flip member.initialized, which it does inside the mutex
 *      — holding it here would deadlock)
 *   3. Commit activeTask + dispatch the first stage UNDER the mutex
 *
 * Between phases 1 and 3 there is a brief window, but activeTask is not yet
 * written, so any early member idle is safely handled by processIdle Step 1.5
 * (barrier) / Step 6 (no active task → return).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { loadTeamState, saveTeamState } from "../state/store.js"
import { ensureMembersReady, advanceToStage, dispatchToMember } from "../orchestration/dispatch.js"
import { createTask, updateTask } from "../state/tasks.js"
import { activationError, resolveCallerInTeam } from "../core/utils.js"
import type { ActiveTask, RouteBranch, Stage } from "../core/types.js"
import { buildDebatePrompt, buildRecursePrompt } from "../orchestration/handlers.js"

const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_LOOP_TIMEOUT_MS = 900_000

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


// --- team_parallel ---

export function teamParallelTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Run a task across all members in parallel. Modes: isolated (same task, no comms), collaborative (per-member tasks, free comms). For multi-round debate to consensus, use team_consensus.",
        args: {
            team_id: tool.schema.string().min(1),
            mode: tool.schema.enum(["isolated", "collaborative"]),
            task: tool.schema.string().optional().describe("isolated mode: the single task sent to all members"),
            tasks: tool.schema
                .record(tool.schema.string(), tool.schema.string())
                .optional()
                .describe("collaborative mode: { memberName: task }"),
            reduce_policy: tool.schema
                .enum(["summarize", "select", "merge", "rubric"])
                .optional()
                .describe("how to combine member outputs (default: summarize)."),
            reduce_rubric: tool.schema
                .string()
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
                .min(0)
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
            // Validate mode-specific fields.
            if (args.mode === "isolated" && !args.task) {
                return "Error: isolated mode requires `task`"
            }
            if (args.mode === "collaborative" && !args.tasks) {
                return "Error: collaborative mode requires `tasks`"
            }

            // Workflow tools are master-only: only the team's leader session may
            // start an orchestration.
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller?.isMaster) {
                return "Error: team_parallel is master-only"
            }

            const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)

            // Single-active interaction gate: the master may only orchestrate the
            // active team.
            const gate = activationError(team.teamName, team.activatedAt)
            if (gate) return gate

            // Validate signoff_decider is a real member (prevents a runtime stall
            // in the signoff phase when the named decider doesn't exist).
            if (args.signoff_policy === "decider") {
                if (!args.signoff_decider) {
                    return "Error: signoff_policy 'decider' requires signoff_decider (a member name)"
                }
                if (!team.members.some(m => m.name === args.signoff_decider)) {
                    return `Error: signoff_decider "${args.signoff_decider}" is not a member of team "${args.team_id}"`
                }
            }

            // Validate reducer_member is a real member (a real reduce stage is
            // dispatched to it; an unknown name would silently fall back to legacy
            // delivery, so reject it explicitly).
            if (args.reduce_policy && args.reduce_policy !== "summarize" && args.reducer_member
                && !team.members.some(m => m.name === args.reducer_member)) {
                return `Error: reducer_member "${args.reducer_member}" is not a member of team "${args.team_id}"`
            }

            // Phase 1: pre-check under mutex.
            let busy = false
            await team.mutex.runExclusive(async () => {
                if (team.activeTask) busy = true
            })
            if (busy) return "Error: team already has an active orchestration"
            let raced = false

            // Phase 2: spawn + role-setup barrier (OUTSIDE mutex).
            await ensureMembersReady(ctx, team)

            // Phase 3: commit activeTask + initial dispatch (UNDER mutex).
            await team.mutex.runExclusive(async () => {
                if (team.activeTask) { raced = true; return } // Re-check inside mutex (prevents double-commit race)
                team.status = "busy"
                team.activeTask = {
                    type: "parallel",
                    runId: crypto.randomUUID(),
                    mode: args.mode,
                    startedAt: Date.now(),
                    wallClockTimeoutMs: effectiveTimeoutMs(args.timeout_ms, DEFAULT_TIMEOUT_MS, team.bounds.maxWallClockMinutes),
                    tokenBudget: args.token_budget,
                    tokensUsed: 0,
                    tokensByMember: {},
                    messagesSent: 0,
                    responses: {},
                    stages: [],
                    currentStageIndex: 0,
                    decisionHistory: [],
                    decisionParseFailures: 0,
                    task: args.task,
                    tasks: args.tasks,
                    reducePolicy: args.reduce_policy ?? "summarize",
                    reduceRubric: args.reduce_rubric,
                    reducerMember: args.reducer_member,
                    signoffPolicy: args.signoff_policy ?? "none",
                    signoffDecider: args.signoff_decider,
                    signoffQuorum: args.signoff_quorum,
                    requireDoneAck: args.require_done_ack === true,
                    maxErroredMembers: args.max_errored_members,
                    maxRetries: args.max_retries,
                }
                // Reset per-member done flag for the new run so a previous run's
                // acks don't bleed in. Only relevant when requireDoneAck is true,
                // but cheap to always reset.
                for (const m of team.members) {
                    m.declaredDone = false
                    m.retryCount = 0
                }
                await saveTeamState(team)

                // Initial dispatch.
                const participants = team.members.filter(m => !m.isMaster)
                for (const m of participants) {
                    const text = args.mode === "isolated"
                        ? args.task!
                        : (args.tasks![m.name] ?? `No task assigned for ${m.name}.`)
                    await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory, team)
                }
            })
            if (raced) return "Error: team already has an active orchestration"
            return `team_parallel (${args.mode}) started on "${args.team_id}".`
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
            // Workflow tools are master-only: only the team's leader session may
            // start an orchestration.
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller?.isMaster) {
                return "Error: team_consensus is master-only"
            }

            const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)

            // Single-active interaction gate: the master may only orchestrate the
            // active team.
            const gate = activationError(team.teamName, team.activatedAt)
            if (gate) return gate

            // Phase 1: pre-check under mutex.
            let busy = false
            await team.mutex.runExclusive(async () => {
                if (team.activeTask) busy = true
            })
            if (busy) return "Error: team already has an active orchestration"
            let raced = false

            // Phase 2: spawn + role-setup barrier (OUTSIDE mutex).
            await ensureMembersReady(ctx, team)

            // Phase 3: commit activeTask + initial dispatch (UNDER mutex).
            await team.mutex.runExclusive(async () => {
                if (team.activeTask) { raced = true; return } // Re-check inside mutex (prevents double-commit race)
                team.status = "busy"
                team.activeTask = {
                    type: "consensus",
                    runId: crypto.randomUUID(),
                    startedAt: Date.now(),
                    wallClockTimeoutMs: effectiveTimeoutMs(args.timeout_ms, DEFAULT_TIMEOUT_MS, team.bounds.maxWallClockMinutes),
                    tokenBudget: args.token_budget,
                    tokensUsed: 0,
                    tokensByMember: {},
                    messagesSent: 0,
                    responses: {},
                    stages: [],
                    currentStageIndex: 0,
                    decisionHistory: [],
                    decisionParseFailures: 0,
                    topic: args.topic,
                    // Needs a round cap; default to 3 when omitted, else
                    // `currentRound >= (maxRounds ?? 0)` aborts after round 1.
                    maxRounds: args.max_rounds ?? 3,
                    currentRound: 1,
                    signoffPolicy: "none",
                    maxRetries: args.max_retries,
                }
                await saveTeamState(team)
                for (const m of team.members) {
                    m.declaredDone = false
                    m.retryCount = 0
                }

                // Initial dispatch: round 1 to every participant.
                const participants = team.members.filter(m => !m.isMaster)
                for (const m of participants) {
                    const text = `[Consensus topic] ${args.topic}\n\nRound ${team.activeTask.currentRound}. State your position. End with <consensus>{"agreed": true|false}</consensus> (or the Chinese <共识>{"agreed": ...}</共识>).`
                    await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory, team)
                }
            })
            if (raced) return "Error: team already has an active orchestration"
            return `team_consensus started on "${args.team_id}".`
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
                .min(0)
                .max(1)
                .optional()
                .describe("fraction of members needed for peer-quorum (default 0.5 = majority). Only when signoff_policy='peer-quorum'."),
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            const stageMembers = args.stages.map(s => s.member)
            if (new Set(stageMembers).size !== stageMembers.length) {
                return "Error: pipeline stages must have unique member names"
            }

            // Workflow tools are master-only.
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller?.isMaster) {
                return "Error: team_pipeline is master-only"
            }

            const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)

            // Single-active interaction gate: the master may only orchestrate the
            // active team.
            const gate = activationError(team.teamName, team.activatedAt)
            if (gate) return gate

            // Validate signoff_decider is a real member (prevents a runtime stall
            // in the signoff phase when the named decider doesn't exist).
            if (args.signoff_policy === "decider") {
                if (!args.signoff_decider) {
                    return "Error: signoff_policy 'decider' requires signoff_decider (a member name)"
                }
                if (!team.members.some(m => m.name === args.signoff_decider)) {
                    return `Error: signoff_decider "${args.signoff_decider}" is not a member of team "${args.team_id}"`
                }
            }

            // Validate members exist.
            for (const name of stageMembers) {
                if (!team.members.some(m => m.name === name)) {
                    return `Error: unknown member "${name}" in stages`
                }
            }

            let busy = false
            await team.mutex.runExclusive(async () => {
                if (team.activeTask) busy = true
            })
            if (busy) return "Error: team already has an active orchestration"
            let raced = false

            await ensureMembersReady(ctx, team)

            await team.mutex.runExclusive(async () => {
                if (team.activeTask) { raced = true; return } // Re-check inside mutex (prevents double-commit race)
                team.status = "busy"
                const stages: Stage[] = args.stages.map(s => ({
                    member: s.member,
                    task: s.task,
                    completed: false,
                }))
                team.activeTask = {
                    type: "pipeline",
                    runId: crypto.randomUUID(),
                    startedAt: Date.now(),
                    wallClockTimeoutMs: effectiveTimeoutMs(args.timeout_ms, 600_000, team.bounds.maxWallClockMinutes),
                    tokenBudget: args.token_budget,
                    tokensUsed: 0,
                    tokensByMember: {},
                    messagesSent: 0,
                    responses: {},
                    stages,
                    currentStageIndex: 0,
                    decisionHistory: [],
                    decisionParseFailures: 0,
                    signoffPolicy: args.signoff_policy ?? "none",
                    signoffDecider: args.signoff_decider,
                    signoffQuorum: args.signoff_quorum,
                    maxRetries: args.max_retries,
                }
                await saveTeamState(team)
                for (const m of team.members) {
                    m.declaredDone = false
                    m.retryCount = 0
                }
                // Dispatch stage 0.
                const first = team.members.find(m => m.name === stages[0].member)!
                await dispatchToMember(ctx, first, stages[0].task, first.worktreePath ?? ctx.directory, team)
            })
            if (raced) return "Error: team already has an active orchestration"
            return `team_pipeline started on "${args.team_id}" with ${args.stages.length} stage(s).`
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
            if (args.decider === "master") {
                return "Error: decider must be a member name, not \"master\""
            }
            // Workflow tools are master-only.
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller?.isMaster) {
                return "Error: team_loop is master-only"
            }

            const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)

            // Single-active interaction gate: the master may only orchestrate the
            // active team.
            const gate = activationError(team.teamName, team.activatedAt)
            if (gate) return gate

            if (!team.members.some(m => m.name === args.decider)) {
                return `Error: decider "${args.decider}" is not a member`
            }
            const stageMembers = args.stages.map(s => s.member)
            if (new Set(stageMembers).size !== stageMembers.length) {
                return "Error: loop stages must have unique member names"
            }
            for (const name of stageMembers) {
                if (!team.members.some(m => m.name === name)) {
                    return `Error: unknown member "${name}" in stages`
                }
            }

            let busy = false
            await team.mutex.runExclusive(async () => {
                if (team.activeTask) busy = true
            })
            if (busy) return "Error: team already has an active orchestration"
            let raced = false

            await ensureMembersReady(ctx, team)

            await team.mutex.runExclusive(async () => {
                if (team.activeTask) { raced = true; return } // Re-check inside mutex (prevents double-commit race)
                team.status = "busy"
                // Append decider as a final read-only stage if not already present.
                let stages: Stage[] = args.stages.map(s => ({
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
                team.activeTask = {
                    type: "loop",
                    runId: crypto.randomUUID(),
                    startedAt: Date.now(),
                    wallClockTimeoutMs: effectiveTimeoutMs(args.timeout_ms, DEFAULT_LOOP_TIMEOUT_MS, team.bounds.maxWallClockMinutes),
                    tokenBudget: args.token_budget,
                    tokensUsed: 0,
                    tokensByMember: {},
                    messagesSent: 0,
                    responses: {},
                    stages,
                    currentStageIndex: 0,
                    deciderMember: args.decider,
                    decisionHistory: [],
                    decisionParseFailures: 0,
                    currentRound: 1,
                    maxRounds: args.max_rounds,
                    maxRetries: args.max_retries,
                }
                await saveTeamState(team)
                for (const m of team.members) {
                    m.declaredDone = false
                    m.retryCount = 0
                }
                // Dispatch first stage with the initial task.
                const first = team.members.find(m => m.name === stages[0].member)!
                await dispatchToMember(ctx, first, args.initial_task, first.worktreePath ?? ctx.directory, team)
            })
            if (raced) return "Error: team already has an active orchestration"
            return `team_loop started on "${args.team_id}" (decider: ${args.decider}, max ${args.max_rounds} rounds).`
        },
    })
}

// --- team_delegate ---

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
                .min(0)
                .max(1)
                .optional()
                .describe("fraction of members needed for peer-quorum (default 0.5 = majority). Only when signoff_policy='peer-quorum'."),
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_errored_members: tool.schema.number().int().min(0).optional().describe("tolerate up to N terminally-errored members and still deliver survivors' work. Default 0 (any member error fails the run)."),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            // Workflow tools are master-only.
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller?.isMaster) {
                return "Error: team_delegate is master-only"
            }

            const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)

            // Single-active interaction gate: the master may only orchestrate the
            // active team.
            const gate = activationError(team.teamName, team.activatedAt)
            if (gate) return gate

            // Pre-validate blockedBy refs against declared refs (before activeTask
            // is set) so an invalid ref cannot leave the team in a dirty state.
            const declaredRefs = new Set(args.tasks.filter(t => t.ref).map(t => t.ref!))
            for (const t of args.tasks) {
                if (!t.blocked_by) continue
                for (const dep of t.blocked_by) {
                    if (!declaredRefs.has(dep)) {
                        return `Error: unknown blockedBy ref "${dep}"`
                    }
                }
            }

            // Validate signoff_decider is a real member.
            if (args.signoff_policy === "decider") {
                if (!args.signoff_decider) {
                    return "Error: signoff_policy 'decider' requires signoff_decider (a member name)"
                }
                if (!team.members.some(m => m.name === args.signoff_decider)) {
                    return `Error: signoff_decider "${args.signoff_decider}" is not a member of team "${args.team_id}"`
                }
            }

            let busy = false
            await team.mutex.runExclusive(async () => {
                if (team.activeTask) busy = true
            })
            if (busy) return "Error: team already has an active orchestration"
            let raced = false

            await ensureMembersReady(ctx, team)

            await team.mutex.runExclusive(async () => {
                if (team.activeTask) { raced = true; return } // Re-check inside mutex (prevents double-commit race)
                team.status = "busy"
                team.activeTask = {
                    type: "delegate",
                    runId: crypto.randomUUID(),
                    startedAt: Date.now(),
                    wallClockTimeoutMs: effectiveTimeoutMs(args.timeout_ms, DEFAULT_TIMEOUT_MS, team.bounds.maxWallClockMinutes),
                    tokenBudget: args.token_budget,
                    tokensUsed: 0,
                    tokensByMember: {},
                    messagesSent: 0,
                    responses: {},
                    stages: [],
                    currentStageIndex: 0,
                    decisionHistory: [],
                    decisionParseFailures: 0,
                    signoffPolicy: args.signoff_policy ?? "none",
                    signoffDecider: args.signoff_decider,
                    signoffQuorum: args.signoff_quorum,
                    maxErroredMembers: args.max_errored_members,
                    maxRetries: args.max_retries,
                }

                // Create all tasks, building ref -> uuid map, then resolve blockedBy.
                const refToUuid = new Map<string, string>()
                for (const t of args.tasks) {
                    const created = await createTask(team.directory, {
                        subject: t.subject,
                        description: t.description,
                    })
                    if (t.ref) refToUuid.set(t.ref, created.id)
                }
                for (const t of args.tasks) {
                    if (!t.ref) continue
                    const uuid = refToUuid.get(t.ref)
                    if (!uuid) continue
                    const blockedBy = (t.blocked_by ?? [])
                        .map(r => refToUuid.get(r)!)
                    if (blockedBy.length > 0) {
                        await updateTask(team.directory, uuid, { blockedBy })
                    }
                }

                await saveTeamState(team)
                for (const m of team.members) {
                    m.declaredDone = false
                    m.retryCount = 0
                }

                // Prompt every member to start pulling from the tasklist.
                for (const m of team.members.filter(x => !x.isMaster)) {
                    const text =
                        `[Team Orchestrator] You are on team "${team.teamName}" in delegate mode. ` +
                        `${args.tasks.length} task(s) published. Use team_task_list to view, team_task_update (status "claimed") to claim, ` +
                        `execute, then team_send_message to report results to master. Repeat until no tasks remain.`
                    await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory, team)
                }
            })
            if (raced) return "Error: team already has an active orchestration"
            return `team_delegate started on "${args.team_id}" with ${args.tasks.length} task(s).`
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
                .min(0)
                .max(1)
                .optional()
                .describe("fraction of members needed for peer-quorum (default 0.5 = majority). Only when signoff_policy='peer-quorum'."),
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            if (args.router === "master") {
                return "Error: router must be a member name, not \"master\""
            }

            // Workflow tools are master-only.
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller?.isMaster) {
                return "Error: team_route is master-only"
            }

            const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)

            // Single-active interaction gate.
            const gate = activationError(team.teamName, team.activatedAt)
            if (gate) return gate

            // Validate routes: unique names, unique members, members exist, and
            // the router must not also be a branch target (it is the sole Phase-A
            // advancer — routing to itself would deadlock).
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

            // Validate signoff_decider is a real member.
            if (args.signoff_policy === "decider") {
                if (!args.signoff_decider) {
                    return "Error: signoff_policy 'decider' requires signoff_decider (a member name)"
                }
                if (!team.members.some(m => m.name === args.signoff_decider)) {
                    return `Error: signoff_decider "${args.signoff_decider}" is not a member of team "${args.team_id}"`
                }
            }

            // Phase 1: pre-check under mutex.
            let busy = false
            await team.mutex.runExclusive(async () => {
                if (team.activeTask) busy = true
            })
            if (busy) return "Error: team already has an active orchestration"
            let raced = false

            // Phase 2: spawn + role-setup barrier (OUTSIDE mutex).
            await ensureMembersReady(ctx, team)

            // Phase 3: commit activeTask + dispatch ONLY the router (UNDER mutex).
            await team.mutex.runExclusive(async () => {
                if (team.activeTask) { raced = true; return }
                team.status = "busy"
                const branches: RouteBranch[] = args.routes.map(r => ({
                    name: r.name,
                    member: r.member,
                    task: r.task,
                    description: r.description,
                }))
                team.activeTask = {
                    type: "route",
                    runId: crypto.randomUUID(),
                    startedAt: Date.now(),
                    wallClockTimeoutMs: effectiveTimeoutMs(args.timeout_ms, DEFAULT_TIMEOUT_MS, team.bounds.maxWallClockMinutes),
                    tokenBudget: args.token_budget,
                    tokensUsed: 0,
                    tokensByMember: {},
                    messagesSent: 0,
                    responses: {},
                    stages: [],
                    currentStageIndex: 0,
                    decisionHistory: [],
                    decisionParseFailures: 0,
                    task: args.input,
                    routerMember: args.router,
                    routeBranches: branches,
                    routeStage: false,
                    signoffPolicy: args.signoff_policy ?? "none",
                    signoffDecider: args.signoff_decider,
                    signoffQuorum: args.signoff_quorum,
                    maxRetries: args.max_retries,
                }
                await saveTeamState(team)
                for (const m of team.members) {
                    m.declaredDone = false
                    m.retryCount = 0
                }
                // Dispatch ONLY the router; it decides the targets (Phase A).
                const routerMember = team.members.find(m => m.name === args.router)!
                const prompt = buildRouterPrompt(team.teamName, args.input, branches)
                await dispatchToMember(ctx, routerMember, prompt, routerMember.worktreePath ?? ctx.directory, team)
            })
            if (raced) return "Error: team already has an active orchestration"
            return `team_route started on "${args.team_id}" (router: ${args.router}, ${args.routes.length} route(s)).`
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
                .min(0)
                .max(1)
                .optional()
                .describe("fraction of members needed for peer-quorum (default 0.5 = majority). Only when signoff_policy='peer-quorum'."),
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            if (args.arbiter === "master") {
                return "Error: arbiter must be a member name, not \"master\""
            }
            if (new Set(args.debaters).size !== args.debaters.length) {
                return "Error: debaters must have unique names"
            }
            if (args.debaters.includes(args.arbiter)) {
                return "Error: arbiter must not also be a debater"
            }

            // Workflow tools are master-only.
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller?.isMaster) {
                return "Error: team_arbitrate is master-only"
            }

            const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)

            // Single-active interaction gate.
            const gate = activationError(team.teamName, team.activatedAt)
            if (gate) return gate

            // Validate arbiter + debaters are real members.
            for (const name of [args.arbiter, ...args.debaters]) {
                if (!team.members.some(m => m.name === name)) {
                    return `Error: unknown member "${name}" in arbiter/debaters`
                }
            }

            // Validate signoff_decider is a real member.
            if (args.signoff_policy === "decider") {
                if (!args.signoff_decider) {
                    return "Error: signoff_policy 'decider' requires signoff_decider (a member name)"
                }
                if (!team.members.some(m => m.name === args.signoff_decider)) {
                    return `Error: signoff_decider "${args.signoff_decider}" is not a member of team "${args.team_id}"`
                }
            }

            // Phase 1: pre-check under mutex.
            let busy = false
            await team.mutex.runExclusive(async () => {
                if (team.activeTask) busy = true
            })
            if (busy) return "Error: team already has an active orchestration"
            let raced = false

            // Phase 2: spawn + role-setup barrier (OUTSIDE mutex).
            await ensureMembersReady(ctx, team)

            // Phase 3: commit activeTask + dispatch the debaters (UNDER mutex).
            await team.mutex.runExclusive(async () => {
                if (team.activeTask) { raced = true; return }
                team.status = "busy"
                const activeTask: ActiveTask = {
                    type: "arbitrate",
                    runId: crypto.randomUUID(),
                    startedAt: Date.now(),
                    wallClockTimeoutMs: effectiveTimeoutMs(args.timeout_ms, DEFAULT_TIMEOUT_MS, team.bounds.maxWallClockMinutes),
                    tokenBudget: args.token_budget,
                    tokensUsed: 0,
                    tokensByMember: {},
                    messagesSent: 0,
                    responses: {},
                    stages: [],
                    currentStageIndex: 0,
                    decisionHistory: [],
                    decisionParseFailures: 0,
                    task: args.task,
                    arbiterMember: args.arbiter,
                    disputants: args.debaters,
                    arbitrationStage: false,
                    maxRounds: args.max_rounds ?? 1,
                    currentRound: 1,
                    signoffPolicy: args.signoff_policy ?? "none",
                    signoffDecider: args.signoff_decider,
                    signoffQuorum: args.signoff_quorum,
                    maxRetries: args.max_retries,
                }
                team.activeTask = activeTask
                await saveTeamState(team)
                for (const m of team.members) {
                    m.declaredDone = false
                    m.retryCount = 0
                }
                // Dispatch ONLY the debaters (round 1); the arbiter waits for
                // the ruling phase.
                for (const name of args.debaters) {
                    const m = team.members.find(x => x.name === name && !x.isMaster)
                    if (!m) continue
                    await dispatchToMember(ctx, m, buildDebatePrompt(activeTask), m.worktreePath ?? ctx.directory, team)
                }
            })
            if (raced) return "Error: team already has an active orchestration"
            return `team_arbitrate started on "${args.team_id}" (arbiter: ${args.arbiter}, ${args.debaters.length} debater(s)).`
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
                .min(0)
                .max(1)
                .optional()
                .describe("fraction of members needed for peer-quorum (default 0.5 = majority). Only when signoff_policy='peer-quorum'."),
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            if (args.decomposer === "master") {
                return "Error: decomposer must be a member name, not \"master\""
            }

            // Workflow tools are master-only.
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller?.isMaster) {
                return "Error: team_recurse is master-only"
            }

            const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)

            // Single-active interaction gate.
            const gate = activationError(team.teamName, team.activatedAt)
            if (gate) return gate

            if (!team.members.some(m => m.name === args.decomposer)) {
                return `Error: decomposer "${args.decomposer}" is not a member of team "${args.team_id}"`
            }

            // Validate signoff_decider is a real member.
            if (args.signoff_policy === "decider") {
                if (!args.signoff_decider) {
                    return "Error: signoff_policy 'decider' requires signoff_decider (a member name)"
                }
                if (!team.members.some(m => m.name === args.signoff_decider)) {
                    return `Error: signoff_decider "${args.signoff_decider}" is not a member of team "${args.team_id}"`
                }
            }

            // Phase 1: pre-check under mutex.
            let busy = false
            await team.mutex.runExclusive(async () => {
                if (team.activeTask) busy = true
            })
            if (busy) return "Error: team already has an active orchestration"
            let raced = false
            let rootTaskId = ""

            // Phase 2: spawn + role-setup barrier (OUTSIDE mutex).
            await ensureMembersReady(ctx, team)

            // Phase 3: commit activeTask + seed the root task + dispatch the
            // decomposer (UNDER mutex).
            await team.mutex.runExclusive(async () => {
                if (team.activeTask) { raced = true; return }
                team.status = "busy"
                const subject = args.task.length <= 480 ? args.task : args.task.slice(0, 477) + "..."
                const root = await createTask(team.directory, {
                    subject,
                    description: args.task,
                    depth: 0,
                })
                rootTaskId = root.id
                const activeTask: ActiveTask = {
                    type: "recurse",
                    runId: crypto.randomUUID(),
                    startedAt: Date.now(),
                    wallClockTimeoutMs: effectiveTimeoutMs(args.timeout_ms, DEFAULT_TIMEOUT_MS, team.bounds.maxWallClockMinutes),
                    tokenBudget: args.token_budget,
                    tokensUsed: 0,
                    tokensByMember: {},
                    messagesSent: 0,
                    responses: {},
                    stages: [],
                    currentStageIndex: 0,
                    decisionHistory: [],
                    decisionParseFailures: 0,
                    task: args.task,
                    decomposerMember: args.decomposer,
                    maxDepth: args.max_depth ?? 3,
                    maxSubtasks: args.max_subtasks ?? 5,
                    rootTaskId: root.id,
                    signoffPolicy: args.signoff_policy ?? "none",
                    signoffDecider: args.signoff_decider,
                    signoffQuorum: args.signoff_quorum,
                    maxRetries: args.max_retries,
                }
                team.activeTask = activeTask
                await saveTeamState(team)
                for (const m of team.members) {
                    m.declaredDone = false
                    m.retryCount = 0
                }
                // Dispatch ONLY the decomposer with the recursive contract;
                // other members pull claimable tasks via the tail's re-prompt.
                const decomposer = team.members.find(m => m.name === args.decomposer && !m.isMaster)
                if (decomposer) {
                    await dispatchToMember(ctx, decomposer, buildRecursePrompt(), decomposer.worktreePath ?? ctx.directory, team)
                }
            })
            if (raced) return "Error: team already has an active orchestration"
            return `team_recurse started on "${args.team_id}" (decomposer: ${args.decomposer}, root task: ${rootTaskId}).`
        },
    })
}

/**
 * Workflow tools: team_parallel, team_pipeline, team_loop, team_delegate
 * (design §4.2-§4.5).
 *
 * All four follow the SAME three-phase lock order (§4.1):
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

import type { PluginContext } from "../context.js"
import { loadTeamState, saveTeamState } from "../state/store.js"
import { ensureMembersReady, advanceToStage } from "../orchestration/dispatch.js"
import { createTask, updateTask } from "../tasks.js"
import { activationError, resolveCallerInTeam } from "../utils.js"
import type { MemberState, Stage } from "../types.js"

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_LOOP_TIMEOUT_MS = 900_000

/**
 * Effective wall-clock timeout: the requested timeout (or a mode default)
 * clamped to the team's hard cap bounds.maxWallClockMinutes (§8.1). Without this
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

/** Send a synthetic text prompt to a member; flip it to running. */
async function dispatchToMember(
    ctx: PluginContext,
    member: MemberState,
    text: string,
    directory: string,
): Promise<void> {
    if (!member.sessionId) return
    await ctx.client.session.promptAsync({
        path: { id: member.sessionId },
        body: {
            parts: [{ type: "text", text, synthetic: true }],
            agent: member.agent ?? "build",
        },
        query: { directory },
    })
    member.status = "running"
    member.turnCount++
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
                if (team.activeTask) { raced = true; return } // M7: re-check inside mutex
                team.status = "busy"
                team.activeTask = {
                    type: "parallel",
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
                    signoffPolicy: args.signoff_policy ?? "none",
                    signoffDecider: args.signoff_decider,
                    signoffQuorum: args.signoff_quorum,
                    requireDoneAck: args.require_done_ack === true,
                }
                // Reset per-member done flag for the new run so a previous run's
                // acks don't bleed in. Only relevant when requireDoneAck is true,
                // but cheap to always reset.
                for (const m of team.members) {
                    m.declaredDone = false
                }
                await saveTeamState(team)

                // Initial dispatch.
                const participants = team.members.filter(m => !m.isMaster)
                for (const m of participants) {
                    const text = args.mode === "isolated"
                        ? args.task!
                        : (args.tasks![m.name] ?? `No task assigned for ${m.name}.`)
                    await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory)
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
            topic: tool.schema.string().min(1).describe("the debate topic"),
            max_rounds: tool.schema.number().min(1).max(20).optional().describe("round limit (default 3)"),
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
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
                if (team.activeTask) { raced = true; return } // M7: re-check inside mutex
                team.status = "busy"
                team.activeTask = {
                    type: "consensus",
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
                    // M5: needs a round cap; default to 3 when omitted, else
                    // `currentRound >= (maxRounds ?? 0)` aborts after round 1.
                    maxRounds: args.max_rounds ?? 3,
                    currentRound: 1,
                    signoffPolicy: "none",
                }
                await saveTeamState(team)

                // Initial dispatch: round 1 to every participant.
                const participants = team.members.filter(m => !m.isMaster)
                for (const m of participants) {
                    const text = `[Consensus topic] ${args.topic}\n\nRound ${team.activeTask.currentRound}. State your position. End with <consensus>{"agreed": true|false}</consensus>.`
                    await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory)
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
                        task: tool.schema.string().min(1),
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
                if (team.activeTask) { raced = true; return } // M7: re-check inside mutex
                team.status = "busy"
                const stages: Stage[] = args.stages.map(s => ({
                    member: s.member,
                    task: s.task,
                    completed: false,
                }))
                team.activeTask = {
                    type: "pipeline",
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
                }
                await saveTeamState(team)
                // Dispatch stage 0.
                const first = team.members.find(m => m.name === stages[0].member)!
                await dispatchToMember(ctx, first, stages[0].task, first.worktreePath ?? ctx.directory)
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
                        task: tool.schema.string().min(1),
                        action: tool.schema.enum(["modify", "read_only"]).optional(),
                    }),
                )
                .min(1),
            decider: tool.schema.string().min(1).describe("member name of the decider (NOT \"master\")"),
            max_rounds: tool.schema.number().min(1).max(50),
            initial_task: tool.schema.string().min(1),
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
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
                if (team.activeTask) { raced = true; return } // M7: re-check inside mutex
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
                }
                await saveTeamState(team)
                // Dispatch first stage with the initial task.
                const first = team.members.find(m => m.name === stages[0].member)!
                await dispatchToMember(ctx, first, args.initial_task, first.worktreePath ?? ctx.directory)
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
                        subject: tool.schema.string().min(1),
                        description: tool.schema.string().min(1),
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

            let busy = false
            await team.mutex.runExclusive(async () => {
                if (team.activeTask) busy = true
            })
            if (busy) return "Error: team already has an active orchestration"
            let raced = false

            await ensureMembersReady(ctx, team)

            await team.mutex.runExclusive(async () => {
                if (team.activeTask) { raced = true; return } // M7: re-check inside mutex
                team.status = "busy"
                team.activeTask = {
                    type: "delegate",
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
                        .map(r => {
                            const dep = refToUuid.get(r)
                            if (!dep) throw new Error(`team_delegate: unknown blockedBy ref "${r}"`)
                            return dep
                        })
                    if (blockedBy.length > 0) {
                        await updateTask(team.directory, uuid, { blockedBy })
                    }
                }

                await saveTeamState(team)

                // Prompt every member to start pulling from the tasklist.
                for (const m of team.members.filter(x => !x.isMaster)) {
                    const text =
                        `[Team Orchestrator] You are on team "${team.teamName}" in delegate mode. ` +
                        `${args.tasks.length} task(s) published. Use team_task_list to view, team_task_update (status "claimed") to claim, ` +
                        `execute, then team_send_message to report results to master. Repeat until no tasks remain.`
                    await dispatchToMember(ctx, m, text, m.worktreePath ?? ctx.directory)
                }
            })
            if (raced) return "Error: team already has an active orchestration"
            return `team_delegate started on "${args.team_id}" with ${args.tasks.length} task(s).`
        },
    })
}

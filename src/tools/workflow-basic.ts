/**
 * Basic workflow tools: team_parallel, team_consensus, team_pipeline, team_loop.
 * These are the "single-track" orchestrations (no routing, no gating, no
 * recursive decomposition). Extracted from the original workflow.ts.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { dispatchToMember } from "../orchestration/dispatch.js"
import type { Stage } from "../core/types.js"
import {
    DEFAULT_LOOP_TIMEOUT_MS,
    DEFAULT_REDUCE_POLICY,
    DEFAULT_SIGNOFF_POLICY,
    DEFAULT_TIMEOUT_MS,
    assertMember,
    baseTaskFields,
    signoffTaskFields,
    signoffSchemaFields,
    startOrchestration,
    validateSignoff,
    DEFAULT_CONSENSUS_ROUNDS,
} from "./workflow-shared.js"

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
            ...signoffSchemaFields,
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
            ...signoffSchemaFields,
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

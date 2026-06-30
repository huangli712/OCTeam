/**
 * team_loop tool -- corrective loop: code -> review -> decide -> repeat.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import type { Stage } from "../core/types.js"
import { dispatchToMember } from "../orchestration/dispatch.js"
import {
    DEFAULT_LOOP_TIMEOUT_MS,
    assertMember,
    baseTaskFields,
    startOrchestration,
} from "./shared.js"

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

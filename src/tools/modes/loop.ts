/**
 * team_loop tool -- corrective loop: code -> review -> decide -> repeat.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import type { Stage } from "../../core/types.js"
import { dispatchToMember } from "../../orchestration/control/dispatch.js"
import {
    DEFAULT_LOOP_TIMEOUT_MS,
    baseTaskFields,
    humanApprovalTaskFields,
    startOrchestration,
} from "../../orchestration/lifecycle/startup.js"
import { commonOrchestrationFields, humanApprovalSchemaFields, parseThresholdFields } from "../schema.js"
import { assertMember } from "../support.js"
import { MASTER_NAME } from "../../state/naming.js"

/** Run a corrective loop with a decider that reviews and decides whether to continue. */
export function teamLoopTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Run a corrective loop: code -> review -> decide -> repeat. The decider "
            + "(a member, NOT master) emits a <decision>{...} block each round. "
            + "Loops until done, max_rounds, no-issues, timeout, or 3 consecutive parse failures.",
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
            max_rounds: tool.schema.number().int().min(1).max(50),
            initial_task: tool.schema.string().min(1).max(8192),
            ...commonOrchestrationFields,
            max_decision_parse_failures: parseThresholdFields.max_decision_parse_failures,
            ...humanApprovalSchemaFields,
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_loop",
                // validate
                (team) => {
                    if (args.decider === MASTER_NAME) {
                        return "Error: decider must be a member name, not \"master\""
                    }
                    const deciderErr = assertMember(team, args.decider, "decider")
                    if (deciderErr) return deciderErr
                    const stageMembers = args.stages.map(s => s.member)
                    if (new Set(stageMembers).size !== stageMembers.length) {
                        return "Error: loop stages must have unique member names"
                    }
                    for (const name of stageMembers) {
                        if (!team.members.some(m => m.name === name && !m.isMaster)) {
                            return `Error: unknown member "${name}" in stages`
                        }
                    }
                    // A user-provided decider stage must be the LAST stage and
                    // read-only — otherwise the decision would be emitted before
                    // all modify stages have run, or be overwritten by a later
                    // stage, breaking the loop contract.
                    const explicitDeciderStageIndex = stageMembers.indexOf(args.decider)
                    if (explicitDeciderStageIndex !== -1 && explicitDeciderStageIndex !== stageMembers.length - 1) {
                        return `Error: decider "${args.decider}" appears in stage ${explicitDeciderStageIndex + 1} but must be the LAST stage (decision must follow all modify stages)`
                    }
                    // M-12: decider stage MUST be read_only. An omitted action defaults
                    // to read_only (the common case); only an explicit action:"modify"
                    // is rejected. Pre-fix code allowed undefined to pass silently,
                    // but also allowed modify — now we default undefined to read_only
                    // and reject modify explicitly.
                    const deciderAction = args.stages[explicitDeciderStageIndex]?.action
                    if (deciderAction === "modify") {
                        return `Error: decider "${args.decider}" stage must be action "read_only" (it reviews, not modifies)`
                    }
                    return null
                },
                // buildTask (append decider as a final read-only stage if not
                // already present).
                async (team) => {
                const stages: Stage[] = args.stages.map(s => ({
                    member: s.member,
                    task: s.task,
                    // H41: default omitted action to read_only so the decider
                    // participates in read-only/no-issues judgment. Pre-fix
                    // code saved undefined, which excluded the decider from
                    // these checks.
                    action: s.action ?? "read_only",
                    completed: false,
                }))
                    if (!stages.some(s => s.member === args.decider)) {
                        stages.push({
                            member: args.decider,
                            task: 'Review all outputs, then emit a <decision> block with JSON body. '
                                + 'The tags must be the literal English <decision> and </decision> '
                                + "— do NOT use translated tags such as <决策>. Required JSON fields: "
                                + '"decision" (string, literally "done" or "continue" — not boolean), '
                                + '"rationale" (string), "nextActions" (string[]). Example: '
                                + '<decision>{"decision":"done","rationale":"checks passed",'
                                + '"nextActions":[]}</decision>',
                            action: "read_only",
                            completed: false,
                        })
                    }
                    return {
                        type: "loop",
                        ...baseTaskFields(args, team, DEFAULT_LOOP_TIMEOUT_MS),
                        stages,
                        ...humanApprovalTaskFields(args),
                        deciderMember: args.decider,
                        currentRound: 1,
                        maxRounds: args.max_rounds,
                        maxDecisionParseFailures: args.max_decision_parse_failures,
                    }
                },
                // dispatch: first stage with the initial task.
                async (team, task) => {
                    const member = task.stages[0]
                    if (!member) return
                    const first = team.members.find(m => m.name === member.member)
                    if (first) {
                        await dispatchToMember(ctx, first, args.initial_task, first.worktreePath ?? ctx.directory, team)
                    }
                },
                // successMessage
                () => `team_loop started on "${args.team_id}" `
                    + `(decider: ${args.decider}, max ${args.max_rounds} rounds).`,
            )
        },
    })
}

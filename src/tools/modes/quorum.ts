/**
 * team_quorum tool -- replicated k-of-n voting on a fixed-schema question.
 * Single-round orchestration: dispatch all participants -> wait-all barrier
 * -> tally -> deliver verdict. No signoff (quorum IS the verdict), no
 * human_approval (single-round, no pause point).
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { dispatchToMember } from "../../orchestration/control/dispatch.js"
import {
    DEFAULT_TIMEOUT_MS,
    baseTaskFields,
    startOrchestration,
} from "../../orchestration/lifecycle/startup.js"
import { commonOrchestrationFields } from "../schema.js"

/**
 * Replicated k-of-n voting on a fixed-schema question. N members independently
 * answer the same question; the option with strict majority
 * (k > valid_ballots/2) wins. Members do NOT debate (use team_consensus for
 * that). Both malformed ballots and runtime errors abstain (excluded from the
 * denominator). All members run to completion (no early-exit).
 */
export function teamQuorumTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Replicated k-of-n voting: N members independently answer the same "
            + "fixed-schema question; the option with strict majority "
            + "(k > valid_ballots/2) wins. Members do NOT debate (use team_consensus "
            + "for that). Both malformed ballots and runtime errors abstain "
            + "(excluded from the denominator). All members run to completion "
            + "(no early-exit). Use for binary/few-option verdicts like merge "
            + "decisions, release gates, content moderation, risk assessment — "
            + "NOT for free-text answers or multi-candidate scoring (use "
            + "team_consensus or team_arena instead).",
        args: {
            team_id: tool.schema.string().min(1),
            task: tool.schema
                .string()
                .min(1)
                .max(8192)
                .describe("the voting question; sent verbatim to all participants"),
            vote_key: tool.schema
                .string()
                .min(1)
                .describe(
                    "ballot field name, e.g. 'decision'. Members are instructed "
                    + 'to emit <vote>{"<vote_key>": "<value>"}</vote>.',
                ),
            vote_options: tool.schema
                .array(tool.schema.string())
                .optional()
                .describe(
                    "whitelist of legal values. If omitted, any non-empty "
                    + "string is accepted. Values outside the whitelist count "
                    + "as abstain (invalid ballot).",
                ),
            members: tool.schema
                .array(tool.schema.string())
                .optional()
                .describe(
                    "subset of members who ballot; default = all non-master "
                    + "members. Must have length >= 2.",
                ),
            max_errored_members: tool.schema
                .number()
                .int()
                .min(0)
                .optional()
                .describe(
                    "tolerate up to N runtime-errored members and still tally "
                    + "(default: N - 1 — only fails pre-tally when ALL members "
                    + "have errored). Invalid ballots always abstain regardless "
                    + "of this setting.",
                ),
            ...commonOrchestrationFields,
            // NOTE: no signoffSchemaFields — quorum is itself a verdict.
            // NOTE: no humanApprovalSchemaFields — single-round, no pause point.
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_quorum",
                // validate — inline loop matching arena.ts:119-123 pattern
                (team) => {
                    if (!args.task) return "Error: team_quorum requires `task`"
                    if (!args.vote_key) return "Error: team_quorum requires `vote_key`"
                    const participants = args.members
                        ?? team.members.filter(m => !m.isMaster).map(m => m.name)
                    if (participants.length < 2) {
                        return "Error: team_quorum requires at least 2 participants"
                    }
                    for (const name of participants) {
                        if (!team.members.some(m => m.name === name && !m.isMaster)) {
                            return `Error: unknown member "${name}" in members`
                        }
                    }
                    return null
                },
                // buildTask
                async (team) => {
                    const participants = args.members
                        ?? team.members.filter(m => !m.isMaster).map(m => m.name)
                    return {
                        type: "quorum" as const,
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        stages: [],                         // ActiveTaskBase requires this field
                        task: args.task,
                        voteKey: args.vote_key,
                        voteOptions: args.vote_options,
                        participants,                       // thread subset through
                        ballots: {},
                        erroredCount: 0,
                        // Default tolerance N-1: only fail pre-tally when all
                        // participants have errored. Lets invalid ballots and
                        // tolerated runtime errors abstain uniformly at tally time.
                        maxErroredMembers:
                            args.max_errored_members ?? (participants.length - 1),
                    }
                },
                // dispatch
                async (team) => {
                    const task = team.activeTask
                    if (!task || task.type !== "quorum") return
                    for (const name of task.participants) {
                        const m = team.members.find(mem => mem.name === name)
                        if (!m) continue
                        const optionsHint = task.voteOptions
                            ? ` (must be one of: ${task.voteOptions.join(", ")})`
                            : ""
                        const text = `[Quorum vote] ${task.task}\n\n`
                            + `Emit your ballot as: `
                            + `<vote>{"${task.voteKey}": "<value>"}</vote>\n`
                            + `The vote value${optionsHint} must be a single string.\n`
                            + `You may include a one-line rationale before the <vote> tag.\n`
                            + `Do NOT discuss with other members — vote independently.`
                        await dispatchToMember(
                            ctx, m, text,
                            m.worktreePath ?? ctx.directory, team,
                        )
                    }
                },
                // successMessage
                () => `team_quorum started on "${args.team_id}".`,
            )
        },
    })
}

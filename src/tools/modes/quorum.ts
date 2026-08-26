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
//
import { commonOrchestrationFields } from "../schema.js"

/**
 * Replicated k-of-n voting on a fixed-schema question. N members independently
 * answer the same question; the option with strict majority
 * (k > valid_ballots/2) wins. Members do NOT debate (use team_consensus for
 * that). Both malformed ballots and runtime errors abstain (excluded from the
 * denominator). All participants run to completion (no early-exit); with the
 * `members` subset argument, non-listed team members do not run.
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
                .max(64)
                .regex(/^[A-Za-z0-9_]+$/)
                .describe(
                    "ballot field name (alphanumeric + underscore, max 64 chars), e.g. 'decision'. "
                    + 'Members are instructed to emit <vote>{"<vote_key>": "<value>"}</vote>.',
                ),
            vote_options: tool.schema
                .array(tool.schema.string().min(1).max(256))
                .max(20)
                .optional()
                .describe(
                    "whitelist of legal values. If omitted, any non-empty "
                    + "string is accepted. Values outside the whitelist count "
                    + "as abstain (invalid ballot).",
                ),
            members: tool.schema
                .array(tool.schema.string().min(1).max(256))
                .max(50)
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
                // validate — participant checks inlined (arena uses assertMember in
                // its candidate loop; here membership is checked inline alongside
                // the duplicate-name guard)
                (team) => {
                    if (!args.task) return "Error: team_quorum requires `task`"
                    if (!args.vote_key) return "Error: team_quorum requires `vote_key`"
                    const participants = args.members
                        ?? team.members.filter(m => !m.isMaster).map(m => m.name)
                    if (participants.length < 2) {
                        return "Error: team_quorum requires at least 2 participants"
                    }
                    // Deduplicate participants: a repeated name would give one
                    // member's vote extra weight in the tally.
                    const seen = new Set<string>()
                    for (const name of participants) {
                        if (seen.has(name)) {
                            return `Error: duplicate participant "${name}" in members`
                        }
                        seen.add(name)
                        if (!team.members.some(m => m.name === name && !m.isMaster)) {
                            return `Error: unknown member "${name}" in members`
                        }
                    }
                    // vote_options whitelist, when provided, must be non-empty
                    // and contain only non-blank values (otherwise every
                    // ballot would abstain by definition).
                    if (args.vote_options !== undefined) {
                        if (args.vote_options.length === 0) {
                            return "Error: vote_options must not be empty (omit it to accept any non-empty string)"
                        }
                        for (const opt of args.vote_options) {
                            if (!opt.trim()) {
                                return "Error: vote_options must not contain blank values"
                            }
                        }
                    }
                    if (args.max_errored_members !== undefined && args.max_errored_members >= participants.length) {
                        return `Error: max_errored_members (${args.max_errored_members}) must be less `
                            + `than participant count (${participants.length})`
                    }
                    return null
                },
                // buildTask
                async (team) => {
                    const participants = args.members
                        ?? team.members.filter(m => !m.isMaster).map(m => m.name)
                    return {
                        type: "quorum",
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        stages: [],    // ActiveTaskBase requires this field
                        task: args.task,
                        voteKey: args.vote_key,
                        voteOptions: args.vote_options,
                        participants,  // thread subset through
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
                        const text = `[Quorum vote]\n` 
                            + `${task.task}\n\n`
                            + `Emit your ballot as: `
                            + `<vote>{"${task.voteKey}": "<value>", "rationale": "<reason>"}</vote>\n`
                            + `The vote value${optionsHint} must be a single string.\n`
                            + `Include an optional "rationale" key inside the vote JSON.\n`
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

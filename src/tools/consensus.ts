/**
 * team_consensus tool -- multi-round structured debate until agreement.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
import { dispatchToMember } from "../orchestration/dispatch.js"
import {
    DEFAULT_CONSENSUS_ROUNDS,
    DEFAULT_SIGNOFF_POLICY,
    DEFAULT_TIMEOUT_MS,
    baseTaskFields,
    humanApprovalSchemaFields,
    humanApprovalTaskFields,
    startOrchestration,
} from "../orchestration/start-orchestration.js"

/** Run a multi-round structured debate until all members reach consensus. */
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
            ...humanApprovalSchemaFields,
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_consensus",
                // validate
                (team) => {
                    // wf-016: a consensus needs at least two participants to be
                    // meaningful -- a single member trivially "agrees" with
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
                    // run itself is an allMembersAgree mechanism -- it only
                    // succeeds when every participant emits agreed=true -- so a
                    // separate post-completion signoff stage would be redundant.
                    signoffPolicy: DEFAULT_SIGNOFF_POLICY,
                    ...humanApprovalTaskFields(args),
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

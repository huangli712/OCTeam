/**
 * team_arbitrate tool -- authoritative ruling: debaters argue over up to
 * max_rounds, then a single arbiter issues a binding ruling.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { dispatchToMember } from "../../orchestration/control/dispatch.js"
import { buildDebatePrompt } from "../../orchestration/modes/arbitrate.js"
import {
    DEFAULT_ARBITRATE_ROUNDS,
    DEFAULT_TIMEOUT_MS,
    baseTaskFields,
    humanApprovalTaskFields,
    signoffTaskFields,
    startOrchestration,
} from "../../orchestration/lifecycle/startup.js"
import { commonOrchestrationFields, humanApprovalSchemaFields, signoffSchemaFields } from "../schema.js"
import { validateSignoff } from "../support.js"

/** Run a binding arbitration with structured debate between members and a ruling arbiter. */
export function teamArbitrateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Authoritative ruling: debaters argue a dispute over up to max_rounds rounds, "
            + "then a single arbiter weighs all positions and issues a binding ruling. "
            + "The arbiter must not be one of the debaters.",
        args: {
            team_id: tool.schema.string().min(1),
            task: tool.schema.string().min(1).max(8192).describe("the dispute / subject under arbitration"),
            arbiter: tool.schema.string().min(1).describe("member name of the arbiter (NOT \"master\", NOT a debater)"),
            debaters: tool.schema
                .array(tool.schema.string().min(1))
                .min(2)
                .describe("debater member names (at least 2, unique; none may be the arbiter)"),
            max_rounds: tool.schema
                .number()
                .min(1)
                .max(20)
                .optional()
                .describe("debate round limit before the ruling (default 1)"),
            hitl_phase: tool.schema
                .enum(["pre", "post", "both"])
                .optional()
                .describe(
                    "HITL pause point(s) when human_approval is true. "
                    + "'pre' (default): pause once after debate, before arbiter dispatch. "
                    + "'post': pause once after arbiter ruling, before delivery. "
                    + "'both': pause at both points.",
                ),
            ...signoffSchemaFields,
            ...humanApprovalSchemaFields,
            ...commonOrchestrationFields,
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
                        if (!team.members.some(m => m.name === name && !m.isMaster)) {
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
                    hitlPhase: args.hitl_phase ?? "pre",
                    maxRounds: args.max_rounds ?? DEFAULT_ARBITRATE_ROUNDS,
                    currentRound: 1,
                    ...humanApprovalTaskFields(args),
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
                () => `team_arbitrate started on "${args.team_id}" `
                    + `(arbiter: ${args.arbiter}, ${args.debaters.length} debater(s)).`,
            )
        },
    })
}

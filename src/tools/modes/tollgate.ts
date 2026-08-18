/**
 * team_tollgate tool -- verdict-gated pipeline with three-valued verification
 * gates (PASS / FAIL / INVALID) between stages.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import type { GatedStage } from "../../core/types.js"
import { advanceToGatedStage } from "../../orchestration/modes/tollgate.js"
import {
    DEFAULT_TIMEOUT_MS,
    baseTaskFields,
    humanApprovalTaskFields,
    signoffTaskFields,
    startOrchestration,
} from "../../orchestration/lifecycle/startup.js"
import { commonOrchestrationFields, humanApprovalSchemaFields, signoffSchemaFields } from "../schema.js"
import { validateSignoff } from "../support.js"

/** Run a verdict-gated pipeline where each stage is verified before the next proceeds. */
export function teamTollgateTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Verdict-gated pipeline: between each stage sits a three-valued "
            + "verification gate. A downstream stage starts "
            + "only on a verifier's PASS verdict. FAIL returns the producer "
            + "with a diff (up to max_gate_retries, then the "
            + "run fails). INVALID (verifier/reference cannot evaluate) "
            + "isolates the stage and escalates the verifier side "
            + "— the producer is NOT penalized. Each gate's verifier must differ from its producer.",
        args: {
            team_id: tool.schema.string().min(1),
            stages: tool.schema
                .array(
                    tool.schema.object({
                        member: tool.schema.string().min(1).describe("the producer member name"),
                        task: tool.schema.string().min(1).max(8192).describe("the producer's task"),
                        verifier: tool.schema
                            .string()
                            .min(1)
                            .describe("the verifier member name (must differ from member)"),
                        criteria: tool.schema
                            .string()
                            .min(1)
                            .max(8192)
                            .describe(
                                "verification criteria (tolerance / conservation law "
                                + "/ reference description)",
                            ),
                        reference: tool.schema
                            .string()
                            .max(8192)
                            .optional()
                            .describe("golden reference location for a Compare-style numerical verdict"),
                    }),
                )
                .min(1),
            escalate_to: tool.schema
                .string()
                .optional()
                .describe(
                    "INVALID escalation target member. When unset, an INVALID "
                    + "verdict is escalated to the leader.",
                ),
            max_gate_retries: tool.schema
                .number()
                .int()
                .min(0)
                .max(20)
                .optional()
                .describe(
                    "gate FAIL retry cap, DISTINCT from provider-retry "
                    + "max_retries. Default 0 (first FAIL fails).",
                ),
            max_invalid_cycles: tool.schema
                .number()
                .int()
                .min(0)
                .max(20)
                .optional()
                .describe(
                    "cap on INVALID/escalate ping-pong per gate. Default 3; "
                    + "beyond it the run fails with "
                    + "tollgate_invalid:exhausted instead of burning "
                    + "wall-clock/turn budget.",
                ),
            ...signoffSchemaFields,
            ...humanApprovalSchemaFields,
            ...commonOrchestrationFields,
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
                    // The escalation target must not be any stage's producer.
                    if (args.escalate_to) {
                        for (const s of args.stages) {
                            if (args.escalate_to === s.member) {
                                return `Error: escalate_to "${args.escalate_to}" must not equal stage producer "${s.member}" — the escalation response would overwrite the producer's original artifact`
                            }
                        }
                    }
                    // A member who is a producer in one gate must not be a
                    // verifier in another gate (and vice versa). The shared
                    // task.responses[member] slot means a verifier's verdict
                    // would overwrite the producer's artifact, causing upstream
                    // context and summary to read the wrong content.
                    const allProducers = new Set(args.stages.map(s => s.member))
                    const allVerifiers = new Set(args.stages.map(s => s.verifier))
                    const overlap = [...allProducers].filter(p => allVerifiers.has(p))
                    if (overlap.length > 0) {
                        return `Error: member "${overlap[0]}" appears as both producer and verifier across different gates — shared response slots would cause artifact overwrite. Use distinct members for each role.`
                    }
                    // Prohibit the same producer across multiple stages.
                    // task.responses[member] is a single slot; a second stage
                    // with the same producer would overwrite the first stage's
                    // artifact, corrupting upstream context and summary.
                    const seenProducers = new Set<string>()
                    for (const s of args.stages) {
                        if (seenProducers.has(s.member)) {
                            return `Error: producer "${s.member}" appears in multiple stages — shared response slots would cause artifact overwrite. Use a distinct producer for each stage.`
                        }
                        seenProducers.add(s.member)
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
                        if (!team.members.some(m => m.name === name && !m.isMaster)) {
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
                        ...humanApprovalTaskFields(args),
                        ...signoffTaskFields(args),
                    }
                },
                // dispatch: ONLY the stage-0 producer; verification starts
                // when it idles.
                async (_team, task) => {
                    if (task.type !== "tollgate") return
                    // Guard against an empty stages array defensively -- the zod
                    // schema enforces min(1), but the non-null assertion `!` is
                    // removed so a future schema regression cannot feed
                    // `undefined` into advanceToGatedStage.
                    const first = task.gatedStages?.[0]
                    if (!first) return
                    await advanceToGatedStage(ctx, _team, first)
                },
                // successMessage
                () => `team_tollgate started on "${args.team_id}" with ${args.stages.length} gate(s).`,
            )
        },
    })
}

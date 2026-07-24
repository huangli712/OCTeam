/**
 * team_parallel tool -- run a task across all members in parallel.
 * Single-track orchestration (no routing, no gating, no recursion).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import { dispatchToMember } from "../../orchestration/control/dispatch.js"
import {
    DEFAULT_REDUCE_POLICY,
    DEFAULT_TIMEOUT_MS,
    baseTaskFields,
    signoffTaskFields,
    startOrchestration,
} from "../../orchestration/lifecycle/startup.js"
import { commonOrchestrationFields, signoffSchemaFields } from "../schema.js"
import { assertMember, validateSignoff, nonMasterMembers } from "../support.js"

/** Run a task across all team members in parallel with isolated or cooperative mode. */
export function teamParallelTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Run a task across all members in parallel. Modes: isolated "
            + "(same task, no comms), cooperative (per-member tasks, free comms). "
            + "For multi-round debate to consensus, use team_consensus.",
        args: {
            team_id: tool.schema.string().min(1),
            mode: tool.schema.enum(["isolated", "cooperative"]),
            task: tool.schema
                .string()
                .max(8192)
                .optional()
                .describe("isolated mode: the single task sent to all members"),
            tasks: tool.schema
                .record(tool.schema.string(), tool.schema.string().max(8192))
                .optional()
                .describe("cooperative mode: { memberName: task }"),
            reduce_policy: tool.schema
                .enum(["summarize", "select", "merge", "rubric"])
                .optional()
                .describe("how to combine member outputs (default: summarize)."),
            reduce_rubric: tool.schema
                .string()
                .max(8192)
                .optional()
                .describe("scoring rubric when reduce_policy='rubric'"),
            reduce_select: tool.schema
                .string()
                .max(8192)
                .optional()
                .describe(
                    "selection criteria when reduce_policy='select' — what 'best' means. "
                    + "Should be method-neutral; otherwise the reducer defaults to its own "
                    + "prior task assignment as the standard.",
                ),
            reducer_member: tool.schema
                .string()
                .optional()
                .describe(
                    "member that performs a real reduce when reduce_policy != summarize. "
                    + "If omitted, the reduce guidance is delivered to master "
                    + "(legacy behavior).",
                ),
            ...signoffSchemaFields,
            ...commonOrchestrationFields,
            max_errored_members: tool.schema
                .number()
                .int()
                .min(0)
                .optional()
                .describe(
                    "tolerate up to N terminally-errored members and still deliver "
                    + "survivors' work. Default 0 (any member error fails the run).",
                ),
            require_done_ack: tool.schema
                .boolean()
                .optional()
                .describe(
                    "when true, the all-idle barrier is replaced by an all-acked barrier. "
                    + "Members must call team_done() to signal completion; members that go idle "
                    + "without acking receive an automatic re-prompt. Prevents premature barrier "
                    + "when a member idles waiting for a dependency. Default false (backward compatible).",
                ),
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_parallel",
                // validate
                (team) => {
                    if (args.mode === "isolated" && !args.task) {
                        return "Error: isolated mode requires `task`"
                    }
                    if (args.mode === "cooperative" && !args.tasks) {
                        return "Error: cooperative mode requires `tasks`"
                    }
                    // Every key in the cooperative `tasks` map must
                    // name a real non-master member. An unknown key is a typo
                    // whose task would never be dispatched, so reject it
                    // instead of silently ignoring it.
                    if (args.mode === "cooperative" && args.tasks) {
                        for (const name of Object.keys(args.tasks)) {
                            const memberErr = assertMember(team, name, "participant")
                            if (memberErr) return memberErr
                        }
                    }
                    // reduce_policy 'rubric' scores outputs against
                    // reduce_rubric, so the rubric text must be present.
                    if (args.reduce_policy === "rubric" && !args.reduce_rubric) {
                        return "Error: reduce_policy 'rubric' requires reduce_rubric (the scoring rubric)"
                    }
                    // Non-summarize reduce policies REQUIRE a reducer_member.
                    // Without one, buildSummary produces scoring/selection/merge
                    // guidance text delivered to master as a tool result — but a
                    // tool result is data, not an enforceable task, so master may
                    // skip the scoring entirely while the run still marks complete.
                    // Force the caller to either name a reducer (autonomous,
                    // verifiable reduce) or use summarize (honest concatenation).
                    if (args.reduce_policy && args.reduce_policy !== "summarize" && !args.reducer_member) {
                        return `Error: reduce_policy '${args.reduce_policy}' requires reducer_member. `
                            + `Either specify a reducer member, or use reduce_policy 'summarize'.`
                    }
                    const signoffErr = validateSignoff(args, team)
                    if (signoffErr) return signoffErr
                    // Validate reducer_member is a real member.
                    if (args.reducer_member) {
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
                    reduceSelect: args.reduce_select,
                    reducerMember: args.reducer_member,
                    requireDoneAck: args.require_done_ack === true,
                    maxErroredMembers: args.max_errored_members,
                    ...signoffTaskFields(args),
                }),
                // dispatch
                async (team) => {
                    const participants = nonMasterMembers(team)
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

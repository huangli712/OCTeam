/**
 * team_arena tool -- competitive multi-candidate arena. N candidate members
 * implement competing solutions in isolated worktrees (implement phase); a
 * dedicated evaluator then scores every candidate and a deterministic winner is
 * selected. v1 delivers the winner directly (no signoff gate).
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import type { Team } from "../../state/store.js"
import { dispatchToMember } from "../../orchestration/control/dispatch.js"
import {
    DEFAULT_TIMEOUT_MS,
    baseTaskFields,
    startOrchestration,
} from "../../orchestration/lifecycle/startup.js"
import { commonOrchestrationFields } from "../schema.js"
import { assertMember, findMember, nonMasterMembers } from "../support.js"

/** Competitive arena with multiple candidates and a dedicated evaluator. */
export function teamArenaTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Competitive arena: N candidate members implement competing solutions, each in an isolated git worktree "
            + "(implement phase); a dedicated evaluator then runs the same objective evaluation "
            + "over every candidate and emits a structured scoreboard; a deterministic winner is "
            + "selected on the winner metric and delivered directly. Every candidate MUST be created "
            + "with worktree:true.",
        args: {
            team_id: tool.schema.string().min(1),
            task: tool.schema.string().min(1).max(8192).describe("the shared implement task every candidate works on"),
            evaluator: tool.schema
                .string()
                .min(1)
                .describe("member name of the evaluator (NOT \"master\", NOT a candidate)"),
            candidates: tool.schema
                .array(tool.schema.string().min(1))
                .optional()
                .describe(
                    "candidate member names (unique, >=2). Defaults to all non-master "
                    + "members except the evaluator.",
                ),
            eval_command: tool.schema
                .string()
                .max(8192)
                .optional()
                .describe(
                    "objective command the evaluator runs against each candidate worktree. "
                    + "At least one of eval_command/eval_criteria is required.",
                ),
            eval_criteria: tool.schema
                .string()
                .max(8192)
                .optional()
                .describe(
                    "scoring criteria for the evaluator. At least one of "
                    + "eval_command/eval_criteria is required.",
                ),
            winner_metric: tool.schema
                .string()
                .max(64)
                .optional()
                .describe("metric the winner is selected on (default \"score\")."),
            score_direction: tool.schema
                .enum(["max", "min"])
                .optional()
                .describe("whether the winner is the max or min of the winner metric (default \"max\")."),
            max_eval_retries: tool.schema
                .number()
                .int()
                .min(0)
                .max(5)
                .optional()
                .describe("evaluator re-dispatch cap on scoreboard parse/selection failure (default 1)."),
            max_errored_members: tool.schema
                .number()
                .int()
                .min(0)
                .optional()
                .describe(
                    "candidate failure isolation: tolerate up to N errored candidates "
                    + "during implement. Default 0.",
                ),
            ...commonOrchestrationFields,
        },
        async execute(args, context) {
            // Resolve candidates once (shared by validate, buildTask, and the
            // success message): explicit list, or every non-master member except
            // the evaluator.
            const resolveCandidates = (team: Team): string[] =>
                args.candidates
                ?? nonMasterMembers(team).filter(m => m.name !== args.evaluator).map(m => m.name)
            let candidateCount = 0
            return startOrchestration(
                args.team_id, context, ctx, "team_arena",
                // validate
                (team) => {
                    // Evaluator must be a real non-master member.
                    const evaluatorMember = team.members.find(m => m.name === args.evaluator)
                    if (evaluatorMember === undefined) {
                        return `Error: unknown evaluator "${args.evaluator}"`
                    }
                    if (evaluatorMember.isMaster) {
                        return `Error: evaluator "${args.evaluator}" must be a non-master member`
                    }
                    const candidates = resolveCandidates(team)
                    // Unique names (mirrors team_arbitrate): duplicates would
                    // double-dispatch one member and corrupt barrier/survivor
                    // /tie-break semantics.
                    if (new Set(candidates).size !== candidates.length) {
                        return "Error: candidates must have unique names"
                    }
                    if (candidates.includes(args.evaluator)) {
                        return `Error: evaluator "${args.evaluator}" must not also be a candidate`
                    }
                    if (candidates.length < 2) {
                        return "Error: team_arena requires at least 2 candidates"
                    }
                    // The evaluator needs a basis to score.
                    if (!args.eval_command && !args.eval_criteria) {
                        return "Error: team_arena requires at least one of eval_command or eval_criteria"
                    }
                    for (const name of candidates) {
                        const memberErr = assertMember(team, name, "candidate")
                        if (memberErr) return memberErr
                    }
                    return null
                },
                // buildTask: runs AFTER ensureMembersReady, so worktreePath is
                // now populated for members created with worktree:true.
                async (team) => {
                    const candidates = resolveCandidates(team)
                    const missing = candidates.filter(name => {
                        const m = team.members.find(x => x.name === name)
                        return !m?.worktreePath
                    })
                    if (missing.length > 0) {
                        return {
                            error: `team_arena requires every candidate to have an isolated worktree `
                                + `(create with worktree:true): ${missing.join(", ")}`,
                        }
                    }
                    candidateCount = candidates.length
                    return {
                        type: "arena",
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        task: args.task,
                        stages: [],
                        arenaPhase: "implement",
                        evalAttempts: 0,
                        maxEvalRetries: args.max_eval_retries ?? 1,
                        scoreDirection: args.score_direction ?? "max",
                        winnerMetric: args.winner_metric ?? "score",
                        maxErroredMembers: args.max_errored_members,
                        candidates,
                        evaluatorMember: args.evaluator,
                        evalCommand: args.eval_command,
                        evalCriteria: args.eval_criteria,
                    }
                },
                // dispatch: the shared implement task to every candidate, each in
                // its own worktree. The evaluator waits for the evaluate phase.
                async (team, task) => {
                    if (task.type !== "arena") return
                    for (const name of task.candidates) {
                        const m = findMember(team, name)
                        if (!m) continue
                        await dispatchToMember(ctx, m, task.task, m.worktreePath ?? ctx.directory, team)
                    }
                },
                // successMessage
                () => `team_arena started on "${args.team_id}" `
                    + `(evaluator: ${args.evaluator}, ${candidateCount} candidate(s)).`,
            )
        },
    })
}

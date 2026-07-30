/**
 * H42: optional parse-failure threshold fields for modes with bounded
 * decision/verdict parse recovery. Each mode tool selects only its matching
 * field (loop, arbitrate, route, recurse).
 * Pre-fix code: handlers supported overrides but the tool schemas never
 * exposed them, so callers could not actually configure them.
 */
export const parseThresholdFields = {
    max_decision_parse_failures: tool.schema
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(
            "loop mode: consecutive <decision> parse failures before the run fails. " +
            "Default 3.",
        ),
    max_ruling_parse_failures: tool.schema
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(
            "arbitrate mode: consecutive arbiter ruling parse failures before the run fails. " +
            "Default 2.",
        ),
    max_route_parse_failures: tool.schema
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(
            "route mode: consecutive router decision parse failures before the run fails. " +
            "Default 2.",
        ),
    max_aggregation_dispatches: tool.schema
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(
            "recurse mode: max aggregation re-dispatches before declaring the run stalled. " +
            "Default 3.",
        ),
}

/**
 * Shared tool-schema field builders used by the workflow tools.
 *
 * Extracted from orchestration/lifecycle/startup.ts so that the orchestration
 * runtime layer no longer depends on the @opencode-ai/plugin tool-framework
 * value API (it still imports the ToolContext *type*, which is erased at
 * runtime and therefore not a behavioral coupling).
 *
 * The matching ActiveTask field builders (signoffTaskFields /
 * humanApprovalTaskFields) remain in orchestration/lifecycle/startup.ts
 * because they depend on runtime types (SignoffPolicy, Team).
 */

import { tool } from "@opencode-ai/plugin"

/**
 * The three signoff schema fields shared by every workflow tool that supports
 * post-completion review (9 of 12 tools — all except consensus, loop, and
 * quorum, which have their own built-in agreement gates). Spread into a tool's
 * tool.schema.object({...}) to single-source the descriptions and constraints.
 */
export const signoffSchemaFields = {
    signoff_policy: tool.schema
        .enum(["none", "decider", "peer-quorum"])
        .optional()
        .describe(
            "post-completion review gate. 'none' (default): direct delivery. " +
            "'decider': named member reviews. 'peer-quorum': all members vote.",
        ),
    signoff_decider: tool.schema
        .string()
        .optional()
        .describe("member name to act as signoff decider (when signoff_policy='decider')"),
    signoff_quorum: tool.schema
        .number()
        .gt(0)
        .max(1)
        .optional()
        .describe(
            "fraction of members needed for peer-quorum (default 0.5 = at least half approve). " +
            "Only when signoff_policy='peer-quorum'.",
        ),
}

/** Schema fields for human approval: a boolean flag to pause at mid-run boundaries. */
export const humanApprovalSchemaFields = {
    human_approval: tool.schema
        .boolean()
        .optional()
        .describe(
            "Pause at supported mid-run boundaries and require the leader to call " +
            "team_approve/team_reject before continuing.",
        ),
}

/**
 * Common orchestration schema fields shared by every mode tool: timeout, token
 * budget, and member-retry grace windows. Spread into a tool's schema.object().
 */
export const commonOrchestrationFields = {
    timeout_ms: tool.schema.number().int().min(1000).optional(),
    token_budget: tool.schema
        .number()
        .int()
        .min(1)
        .optional()
        .describe("optional token cap; orchestration fails if exceeded"),
    max_retries: tool.schema
        .number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .describe(
            "re-dispatch grace windows before a sustained-retry member " +
            "is marked errored. Default 0.",
        ),
}

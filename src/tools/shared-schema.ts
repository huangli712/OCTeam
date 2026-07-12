/**
 * Shared tool-schema field builders used by the workflow tools.
 *
 * Extracted from orchestration/lifecycle/start-orchestration.ts so that the orchestration
 * runtime layer no longer depends on the @opencode-ai/plugin tool-framework
 * value API (it still imports the ToolContext *type*, which is erased at
 * runtime and therefore not a behavioral coupling).
 *
 * The matching ActiveTask field builders (signoffTaskFields /
 * humanApprovalTaskFields) remain in orchestration/lifecycle/start-orchestration.ts
 * because they depend on runtime types (SignoffPolicy, Team).
 */

import { tool } from "@opencode-ai/plugin"

/**
 * The three signoff schema fields shared by every workflow tool that supports
 * post-completion review (7 of 9 tools — all except consensus and loop, which
 * have their own built-in agreement gates). Spread into a tool's
 * tool.schema.object({...}) to single-source the descriptions and constraints.
 */
export const signoffSchemaFields = {
    signoff_policy: tool.schema
        .enum(["none", "decider", "peer-quorum"])
        .optional()
        .describe("post-completion review gate. 'none' (default): direct delivery. 'decider': named member reviews. 'peer-quorum': all members vote."),
    signoff_decider: tool.schema
        .string()
        .optional()
        .describe("member name to act as signoff decider (when signoff_policy='decider')"),
    signoff_quorum: tool.schema
        .number()
        .gt(0)
        .max(1)
        .optional()
        .describe("fraction of members needed for peer-quorum (default 0.5 = majority). Only when signoff_policy='peer-quorum'."),
}

/** Schema fields for human approval: a boolean flag to pause at mid-run boundaries. */
export const humanApprovalSchemaFields = {
    human_approval: tool.schema
        .boolean()
        .optional()
        .describe("Pause at supported mid-run boundaries and require the leader to call team_approve/team_reject before continuing."),
}

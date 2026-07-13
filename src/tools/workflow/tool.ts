/**
 * team_workflow tool -- deterministic, declaratively-composed linear step
 * engine. Each step is either a `task` (one member produces output) or
 * a `gate` (a verifier renders a PASS/FAIL verdict over one or more prior task
 * outputs). The engine -- not the master LLM -- drives every step transition,
 * keeping intermediate results out of master context.
 *
 * Type definitions + tool definition. Lowering + ref resolution live in lower.ts.
 * Validation lives in validate.ts. Dry-run formatting lives in lower.ts.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
// --- public types (canonical home: core/workflow-types.ts; re-exported here
//     for backward compatibility with existing imports from this module) ---

export type {
    ResolvedWorkflowToolArgs,
    WorkflowFanoutBranch,
    WorkflowFanoutToolStep,
    WorkflowLinearToolStep,
    WorkflowStepRef,
    WorkflowToolArgs,
    WorkflowToolStep,
    WorkflowWhere,
} from "../../core/types/workflow.js"

import type {
    WorkflowStep,
    WorkflowTask,
} from "../../core/types.js"
import { activationError } from "../../state/activation.js"
import { dispatchTaskStep, maybePauseBeforeWorkflowStep } from "../../orchestration/workflow/engine.js"
import { resolveCallerInTeam } from "../../state/resolve.js"
import { loadTeamState } from "../../state/store.js"
import {
    DEFAULT_TIMEOUT_MS,
    baseTaskFields,
    humanApprovalTaskFields,
    signoffTaskFields,
    startOrchestration,
} from "../../orchestration/lifecycle/startup.js"
import { humanApprovalSchemaFields, signoffSchemaFields } from "../shared-schema.js"
import { lowerWorkflowSteps, toWorkflowStep } from "./lower.js"
import { formatWorkflowDryRun } from "./lower-format.js"
import {
    resolveWorkflowArgs,
    validateWorkflowArgs,
} from "./validate.js"

// --- re-exports for backward compat ---

export { validateWorkflowStepsAgainstMembers } from "./validate.js"
export { expandMatrixForeachFanout } from "./lower.js"

// --- tool definition ---

/** Run a declarative workflow engine with task, gate, fanout, and join steps. */
export function teamWorkflowTool(ctx: PluginContext): ToolDefinition {
    const workflowStepRefSchema = tool.schema.union([tool.schema.number().int().min(1), tool.schema.string().min(1)])
    const workflowStepSchemaFields = {
        id: tool.schema.string().min(1).max(64).optional().describe("optional stable step identifier; gates may reference a task step by this id via target_step or targets"),
        member: tool.schema.string().min(1).optional().describe("task steps: the actor member name"),
        fallback_member: tool.schema.string().min(1).optional().describe("task steps: fallback actor used only when member has no live session"),
        task: tool.schema.string().min(1).max(8192).optional().describe("task steps: the task text"),
        verifier: tool.schema.string().min(1).optional().describe("gate steps: the verifier member name (must differ from the target task member)"),
        fallback_verifier: tool.schema.string().min(1).optional().describe("gate steps: fallback verifier used only when verifier has no live session; must differ from every target task member"),
        verifiers: tool.schema.array(tool.schema.string().min(1)).min(2).optional().describe("gate steps: multiple verifiers for ensemble verdict. Mutually exclusive with verifier/fallback_verifier. When set, ensemble_policy is required."),
        ensemble_policy: tool.schema.enum(["majority", "quorum", "unanimous"]).optional().describe("gate steps: aggregation policy for ensemble verdict. Required when verifiers is set. majority = >50% agreement; quorum = ensemble_quorum fraction agreement; unanimous = all agree."),
        ensemble_quorum: tool.schema.number().min(0).max(1).optional().describe("gate steps: quorum fraction (0 < quorum <= 1) for ensemble_policy='quorum'. Required when ensemble_policy='quorum'."),
        criteria: tool.schema.string().min(1).max(8192).optional().describe("gate steps: verification criteria"),
        target_step: workflowStepRefSchema.optional().describe("gate steps: one target task step to verify, using a 1-based number or step id; branch gate references are branch-local. Mutually exclusive with targets."),
        targets: tool.schema.array(workflowStepRefSchema).min(1).optional().describe("gate steps: multiple prior task steps to verify together. Mutually exclusive with target_step."),
        inputs: tool.schema.array(workflowStepRefSchema).min(1).optional().describe("task steps: explicit upstream task/join steps to include, using 1-based numbers or step ids. Overrides implicit upstream selection."),
        expose_output: tool.schema.boolean().optional().describe("task steps: when false, suppress this task output from implicit downstream upstream context. Explicit inputs may still reference it."),
        retry_on: tool.schema.object({
            empty: tool.schema.boolean().optional(),
            output_contains: tool.schema.string().min(1).optional(),
            output_not_contains: tool.schema.string().min(1).optional(),
            regex: tool.schema.string().min(1).optional(),
        }).optional().describe("task steps: auto-retry condition. Exactly one key: empty (retry on empty/whitespace-only output), output_contains (retry when output contains pattern), output_not_contains (retry when output does NOT contain pattern), regex (retry when output matches regex). Requires max_task_retries."),
        max_task_retries: tool.schema.number().int().min(0).max(5).optional().describe("task steps: max auto-retry attempts when retry_on condition matches. Default 0. Required when retry_on is set."),
        on_fail: tool.schema.enum(["retry", "fail", "skip"]).optional().describe("gate steps: FAIL control. 'fail' (default) fails the run; 'retry' re-dispatches the target task up to max_retries; 'skip' marks the gate skipped and advances."),
        max_retries: tool.schema.number().int().min(0).max(5).optional().describe("gate steps: FAIL retry cap when on_fail='retry'. Default 0."),
        on_invalid: tool.schema.enum(["fail", "retry_verifier", "escalate"]).optional().describe("gate steps: INVALID control. 'fail' (default) terminates producer-neutral as workflow_invalid; 'retry_verifier' re-dispatches this gate's verifier up to max_invalid_retries; 'escalate' pauses for human approval (approve=advance, reject=workflow_invalid)."),
        max_invalid_retries: tool.schema.number().int().min(0).max(5).optional().describe("gate steps: retry_verifier cap when on_invalid='retry_verifier'. Default 0. Required when on_invalid='retry_verifier'."),
        on_malformed: tool.schema.enum(["fail", "retry_verifier", "skip", "escalate"]).optional().describe("gate steps: parse_failure control. 'fail' (default, falls back to on_invalid) terminates; 'retry_verifier' re-dispatches verifier up to max_malformed_retries; 'skip' marks gate skipped and advances; 'escalate' pauses for human approval."),
        max_malformed_retries: tool.schema.number().int().min(0).max(5).optional().describe("gate steps: retry_verifier cap for malformed verdicts when on_malformed='retry_verifier'. Default 0. Required when on_malformed='retry_verifier'."),
        on_pass_goto: workflowStepRefSchema.optional().describe("gate steps: step to jump to after PASS (1-based number or step id) instead of advancing linearly. Branch gotos are branch-local."),
        on_fail_goto: workflowStepRefSchema.optional().describe("gate steps: step to jump to at a FAIL terminal point (on_fail=fail, or retry exhausted) instead of failing the run."),
        on_invalid_goto: workflowStepRefSchema.optional().describe("gate steps: step to jump to at an INVALID terminal point (on_invalid=fail, or retry_verifier exhausted). Incompatible with on_invalid='escalate'."),
        where: tool.schema.object({
            score_gte: tool.schema.number().optional(),
            score_lt: tool.schema.number().optional(),
            confidence_gte: tool.schema.number().optional(),
            has_issue_severity: tool.schema.enum(["low", "medium", "high", "critical"]).optional(),
        }).optional().describe("gate steps: optional threshold condition gating on_pass_goto/on_fail_goto. Exactly one condition key is allowed."),
        approval_before: tool.schema.boolean().optional().describe("task/gate steps: pause for team_approve before dispatching this step. Disallowed inside fanout branches."),
        approval_after: tool.schema.boolean().optional().describe("task/gate steps: pause for team_approve after this step completes, before advancing. Disallowed inside fanout branches."),
        max_output_bytes: tool.schema.number().int().min(1).optional().describe("task steps: cap the captured output snapshot to N UTF-8 bytes (head+tail preserved). Gate steps may not set this."),
        timeout_ms: tool.schema.number().int().min(1000).optional().describe("task/gate steps: wall-clock deadline in milliseconds from dispatch time."),
        on_timeout: tool.schema.enum(["fail", "retry", "skip"]).optional().describe("task/gate steps: timeout control. 'fail' (default) fails the workflow; 'retry' re-dispatches up to max_timeout_retries; 'skip' marks the step skipped and advances."),
        max_timeout_retries: tool.schema.number().int().min(0).max(5).optional().describe("task/gate steps: timeout retry cap when on_timeout='retry'. Required when on_timeout='retry'."),
        max_jumps: tool.schema.number().int().min(0).max(10).optional().describe("gate steps: per-gate cap on verdict-driven jumps. Default 3. Terminates as workflow_failed:jump_limit when exceeded."),
        loop: tool.schema.object({
            max_iterations: tool.schema.number().int().min(1).max(20),
            on_exhaust: tool.schema.enum(["fail", "continue"]).optional(),
        }).optional().describe("gate steps: loop control for on_fail_goto. Bounds backward iterations via on_fail_goto and defines exhaust behavior. Requires on_fail_goto. Incompatible with on_fail='retry' or on_fail='skip'."),
        join_policy: tool.schema.enum(["all", "quorum", "any_success", "required_branches", "reduce", "select"]).optional().describe("fanout steps: join semantics. Default (unset) uses max_errored tolerance. 'all' requires every branch to succeed; 'quorum' requires quorum fraction of survivors; 'any_success' joins once any branch succeeds; 'required_branches' requires the listed branches to succeed; 'reduce' requires all then dispatches reducer_member to aggregate; 'select' requires all then dispatches reducer_member to choose one winning branch."),
        quorum: tool.schema.number().min(0).max(1).optional().describe("fanout steps: survivor fraction required by join_policy='quorum' (0 < quorum <= 1)."),
        required_branches: tool.schema.array(tool.schema.string().min(1)).min(1).optional().describe("fanout steps: branch ids that must succeed under join_policy='required_branches'."),
        reducer_member: tool.schema.string().min(1).optional().describe("fanout steps: member who aggregates branch outputs under join_policy='reduce' or selects a winning branch under join_policy='select'."),
        use_survivors: tool.schema.boolean().optional().describe("fanout steps: when true, strict join policies continue with surviving branch outputs instead of failing on branch errors."),
        matrix: tool.schema.record(tool.schema.string(), tool.schema.array(tool.schema.string().min(1))).optional().describe("fanout steps: expand into the cartesian product of named value arrays, substituting ${name} in each branch step's text fields. Mutually exclusive with branches/foreach."),
        foreach: tool.schema.array(tool.schema.string().min(1)).optional().describe("fanout steps: single-dimension value list; one branch per value, substituting ${as} in each branch step. Mutually exclusive with branches/matrix."),
        as: tool.schema.string().min(1).optional().describe("fanout steps: variable name bound to the current foreach value (default 'item')."),
    }
    const workflowBranchStepSchema = tool.schema.object({
        kind: tool.schema.enum(["task", "gate", "fanout", "join"]),
        ...workflowStepSchemaFields,
        branches: tool.schema.array(tool.schema.object({
            id: tool.schema.string().min(1).max(64),
            steps: tool.schema.array(tool.schema.object({
                kind: tool.schema.enum(["task", "gate", "fanout", "join"]),
                ...workflowStepSchemaFields,
            })).min(1),
        })).optional(),
        max_errored: tool.schema.number().int().min(0).optional(),
    })
    const workflowStepSchema = tool.schema.object({
        kind: tool.schema.enum(["task", "gate", "fanout", "join"]),
        ...workflowStepSchemaFields,
        branches: tool.schema.array(tool.schema.object({
            id: tool.schema.string().min(1).max(64),
            steps: tool.schema.array(workflowBranchStepSchema).min(1),
        })).optional().describe("fanout steps: branch objects with stable ids and branch-local task/gate steps"),
        max_errored: tool.schema.number().int().min(0).optional().describe("fanout steps: maximum errored branches tolerated; must leave at least one surviving branch"),
    })
    return tool({
        description:
            "Run a deterministic, declaratively-composed workflow. Each step is either a `task` (one member produces output) or a `gate` (a verifier renders a PASS/FAIL/INVALID verdict over one or more prior task outputs). The engine drives transitions, retry, INVALID handling, and verdict-gated jumps while keeping intermediate results out of the leader's context.",
        args: {
            team_id: tool.schema.string().min(1),
            steps: tool.schema
                .array(workflowStepSchema)
                .min(1)
                .optional()
                .describe("ordered workflow steps; fanout must be immediately followed by a join marker"),
            workflow_file: tool.schema.string().min(1).optional().describe("relative path to a JSON workflow file under the workspace; mutually exclusive with steps"),
            vars: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe("template variables for workflow_file string values, referenced as ${name}"),
            dry_run: tool.schema.boolean().optional().describe("Validate and render the 1-based workflow step ledger without starting orchestration"),
            ...signoffSchemaFields,
            ...humanApprovalSchemaFields,
            timeout_ms: tool.schema.number().min(1000).optional(),
            token_budget: tool.schema.number().min(1).optional().describe("optional token cap; orchestration fails if exceeded"),
            max_retries: tool.schema.number().int().min(0).max(5).optional().describe("re-dispatch grace windows before a sustained-retry member is marked errored. Default 0."),
        },
        async execute(args, context) {
            const caller = await resolveCallerInTeam(ctx.storageRoot, context.sessionID, args.team_id)
            if (!caller?.isMaster) return "Error: team_workflow is master-only"
            const resolvedArgs = await resolveWorkflowArgs(ctx, args)
            if (typeof resolvedArgs === "string") return resolvedArgs
            if (args.dry_run) {
                const team = await loadTeamState(ctx.storageRoot, args.team_id, caller.leadSessionId)
                const gate = activationError(team.teamName, team.activatedAt)
                if (gate) return gate
                const validationError = validateWorkflowArgs(resolvedArgs, team)
                if (validationError) return validationError
                return formatWorkflowDryRun(resolvedArgs)
            }
            return startOrchestration(
                args.team_id, context, ctx, "team_workflow",
                (team) => {
                    return validateWorkflowArgs(resolvedArgs, team)
                },
                async (team) => {
                    const loweredSteps = lowerWorkflowSteps(resolvedArgs.steps)
                    const steps: WorkflowStep[] = loweredSteps.map((s, index) => toWorkflowStep(s, loweredSteps, index))
                    const wfTask: WorkflowTask = {
                        type: "workflow",
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        stages: [],
                        steps,
                        ...(steps.some(step => step.kind === "fanout") ? { activeStepIndices: [0] } : {}),
                        ...humanApprovalTaskFields(args),
                        ...signoffTaskFields(args),
                    }
                    return wfTask
                },
                async (team, task) => {
                    if (task.type !== "workflow") return
                    const step = task.steps?.[0]
                    if (!step || step.kind !== "task" || !step.member || !step.task) throw new Error("workflow initial step is invalid")
                    if (await maybePauseBeforeWorkflowStep(ctx, team, 0)) return
                    if (!(await dispatchTaskStep(ctx, team, task, 0))) throw new Error(`workflow initial member "${step.member}" has no live session`)
                },
                () => `team_workflow started on "${args.team_id}" with ${lowerWorkflowSteps(resolvedArgs.steps).length} step(s).`,
            )
        },
    })
}

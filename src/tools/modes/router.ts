/**
 * team_route tool -- Content-Based Routing. A router member inspects the input
 * and decides which branch(es) handle it; selected branches run in parallel.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../core/context.js"
import type { RouteBranch } from "../../core/types.js"
import { dispatchToMember } from "../../orchestration/control/dispatch.js"
import { buildRouterPrompt } from "../../orchestration/modes/route.js"
import {
    DEFAULT_TIMEOUT_MS,
    baseTaskFields,
    humanApprovalTaskFields,
    signoffTaskFields,
    startOrchestration,
} from "../../orchestration/lifecycle/startup.js"
import { commonOrchestrationFields, humanApprovalSchemaFields, parseThresholdFields, signoffSchemaFields } from "../schema.js"
import { validateSignoff } from "../support.js"
import { MASTER_NAME } from "../../state/naming.js"
/** Content-based routing: a router inspects input and dispatches to matching branches. */
export function teamRouteTool(ctx: PluginContext): ToolDefinition {
    return tool({
        description:
            "Content-Based Routing: a router member inspects the input and decides which branch(es) handle it; "
            + "selected branches run in parallel and their outputs are summarized to the leader. No default route — "
            + "an unmatched input fails the run.",
        args: {
            team_id: tool.schema.string().min(1),
            router: tool.schema
                .string()
                .min(1)
                .describe("member name of the router (NOT \"master\", NOT a branch member)"),
            input: tool.schema
                .string()
                .min(1)
                .max(32768)
                .describe(
                    "the content to be routed (dispatched to the router; if a branch "
                    + "has no per-branch task, the branch member receives this input)",
                ),
            routes: tool.schema
                .array(
                    tool.schema.object({
                        name: tool.schema.string().min(1).describe("branch label the router selects by (unique)"),
                        member: tool.schema
                            .string()
                            .min(1)
                            .describe("target member to dispatch to (unique across branches)"),
                        task: tool.schema
                            .string()
                            .min(1)
                            .max(8192)
                            .optional()
                            .describe(
                                "per-branch task; if omitted, the branch member "
                                + "receives the routing `input`",
                            ),
                        description: tool.schema.string().max(1024).optional().describe("hint shown to the router"),
                    }),
                )
                .min(1),
            ...signoffSchemaFields,
            ...humanApprovalSchemaFields,
            ...commonOrchestrationFields,
            ...parseThresholdFields,
        },
        async execute(args, context) {
            return startOrchestration(
                args.team_id, context, ctx, "team_route",
                // validate
                (team) => {
                    if (args.router === MASTER_NAME) {
                        return "Error: router must be a member name, not \"master\""
                    }
                    // Validate routes: unique names, unique members, members
                    // exist, and the router must not also be a branch target
                    // (it is the sole Phase-A advancer -- routing to itself
                    // would deadlock).
                    const branchNames = args.routes.map(r => r.name)
                    if (new Set(branchNames).size !== branchNames.length) {
                        return "Error: route branch names must be unique"
                    }
                    const branchMembers = args.routes.map(r => r.member)
                    if (new Set(branchMembers).size !== branchMembers.length) {
                        return "Error: route branch members must be unique"
                    }
                    if (branchMembers.includes(args.router)) {
                        return "Error: router must not also be a branch target"
                    }
                    for (const name of [args.router, ...branchMembers]) {
                        if (!team.members.some(m => m.name === name && !m.isMaster)) {
                            return `Error: unknown member "${name}" in router/routes`
                        }
                    }
                    const signoffErr = validateSignoff(args, team)
                    if (signoffErr) return signoffErr
                    return null
                },
                // buildTask
                async (team) => {
                    const branches: RouteBranch[] = args.routes.map(r => ({
                        name: r.name,
                        member: r.member,
                        task: r.task,
                        description: r.description,
                    }))
                    return {
                        type: "route",
                        ...baseTaskFields(args, team, DEFAULT_TIMEOUT_MS),
                        stages: [],
                        task: args.input,
                        routerMember: args.router,
                        routeBranches: branches,
                        routeStage: false,
                        ...humanApprovalTaskFields(args),
                        ...signoffTaskFields(args),
                    }
                },
                // dispatch: ONLY the router; it decides the targets (Phase A).
                async (team, task) => {
                    if (task.type !== "route") return
                    const routerMember = team.members.find(m => m.name === args.router)
                    if (!routerMember) return
                    const prompt = buildRouterPrompt(team.teamName, args.input, task.routeBranches ?? [])
                    await dispatchToMember(ctx, routerMember, prompt, routerMember.worktreePath ?? ctx.directory, team)
                },
                // successMessage
                () => `team_route started on "${args.team_id}" `
                    + `(router: ${args.router}, ${args.routes.length} route(s)).`,
            )
        },
    })
}

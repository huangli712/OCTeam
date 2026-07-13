/**
 * Tool registry. createTools(ctx) returns the full { [name]: ToolDefinition }
 * map consumed by the server module's Hooks.tool. Each tool closes over the
 * shared PluginContext.
 */

import type { PluginContext } from "../core/context.js"
import type { ToolDefinition } from "@opencode-ai/plugin"
import { teamActivateTool } from "./activate.js"
import { teamAddMemberTool } from "./add.js"
import { teamCancelTool } from "./cancel.js"
import { teamCreateTool } from "./create.js"
import { teamDeactivateTool } from "./deactivate.js"
import { teamDeleteTool } from "./delete.js"
import { teamDetailsTool } from "./details.js"
import { teamFixMemberTool } from "./fixmember.js"
import { teamListTool } from "./list.js"
import { teamQueryTool } from "./query.js"
import { teamRemoveMemberTool } from "./remove.js"
import { teamRenameTool } from "./rename.js"
import { teamSendMessageTool } from "./messaging.js"
import {
    teamTaskCreateTool,
    teamTaskGetTool,
    teamTaskListTool,
    teamTaskUpdateTool,
} from "./task.js"
import { teamConsensusTool } from "./consensus.js"
import { teamDelegateTool } from "./delegate.js"
import { teamLoopTool } from "./loop.js"
import { teamParallelTool } from "./parallel.js"
import { teamPipelineTool } from "./pipeline.js"
import { teamRouteTool } from "./router.js"
import { teamArbitrateTool } from "./arbitrate.js"
import { teamArenaTool } from "./arena.js"
import { teamRecurseTool } from "./recurse.js"
import { teamTollgateTool } from "./tollgate.js"
import { teamWorkflowTool } from "./workflow/tool.js"
import { teamFixWorkflowTool } from "./fixflow.js"
import { teamPlannerTool } from "./workflow/planner.js"
import { teamDoneTool } from "./done.js"
import { teamResultsTool, teamResultGetTool } from "./results.js"
import { teamProgressTool } from "./progress.js"
import { teamInterveneTool } from "./intervene.js"
import { teamMetricsTool } from "./metrics.js"
import { teamResumeTool } from "./resume.js"
import { teamApproveTool, teamRejectTool } from "./approve.js"


/** Build and return all team orchestration tools keyed by name. */
export function createTools(ctx: PluginContext): Record<string, ToolDefinition> {
    return {
        team_create: teamCreateTool(ctx),
        team_activate: teamActivateTool(ctx),
        team_deactivate: teamDeactivateTool(ctx),
        team_add_member: teamAddMemberTool(ctx),
        team_cancel: teamCancelTool(ctx),
        team_remove_member: teamRemoveMemberTool(ctx),
        team_rename: teamRenameTool(ctx),
        team_delete: teamDeleteTool(ctx),
        team_list: teamListTool(ctx),
        team_query: teamQueryTool(ctx),
        team_details: teamDetailsTool(ctx),
        team_fix_member: teamFixMemberTool(ctx),
        team_send_message: teamSendMessageTool(ctx),
        team_task_create: teamTaskCreateTool(ctx),
        team_task_list: teamTaskListTool(ctx),
        team_task_update: teamTaskUpdateTool(ctx),
        team_task_get: teamTaskGetTool(ctx),
        team_parallel: teamParallelTool(ctx),
        team_consensus: teamConsensusTool(ctx),
        team_pipeline: teamPipelineTool(ctx),
        team_loop: teamLoopTool(ctx),
        team_delegate: teamDelegateTool(ctx),
        team_route: teamRouteTool(ctx),
        team_arbitrate: teamArbitrateTool(ctx),
        team_recurse: teamRecurseTool(ctx),
        team_tollgate: teamTollgateTool(ctx),
        team_arena: teamArenaTool(ctx),
        team_workflow: teamWorkflowTool(ctx),
        team_fix_workflow: teamFixWorkflowTool(ctx),
        team_planner: teamPlannerTool(ctx),
        team_done: teamDoneTool(ctx),
        team_results: teamResultsTool(ctx),
        team_result_get: teamResultGetTool(ctx),
        team_progress: teamProgressTool(ctx),
        team_intervene: teamInterveneTool(ctx),
        team_approve: teamApproveTool(ctx),
        team_reject: teamRejectTool(ctx),
        team_metrics: teamMetricsTool(ctx),
        team_resume: teamResumeTool(ctx),
    }
}

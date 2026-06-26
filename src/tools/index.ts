/**
 * Tool registry. createTools(ctx) returns the full { [name]: ToolDefinition }
 * map consumed by the server module's Hooks.tool. Each tool closes over the
 * shared PluginContext.
 */

import type { PluginContext } from "../core/context.js"
import type { ToolDefinition } from "@opencode-ai/plugin"
import {
    teamActivateTool,
    teamAddMemberTool,
    teamCancelTool,
    teamCreateTool,
    teamDeactivateTool,
    teamDeleteTool,
    teamDetailsTool,
    teamFixMemberTool,
    teamListTool,
    teamQueryTool,
    teamRemoveMemberTool,
    teamRenameTool,
} from "./lifecycle.js"
import { teamSendMessageTool } from "./messaging.js"
import {
    teamTaskCreateTool,
    teamTaskGetTool,
    teamTaskListTool,
    teamTaskUpdateTool,
} from "./task.js"
import {
    teamConsensusTool,
    teamDelegateTool,
    teamLoopTool,
    teamParallelTool,
    teamPipelineTool,
    teamRouteTool,
    teamArbitrateTool,
} from "./workflow.js"
import { teamDoneTool } from "./done.js"
import { teamResultsTool, teamResultGetTool } from "./results.js"
import { teamProgressTool } from "./progress.js"
import { teamInterveneTool } from "./intervene.js"
import { teamMetricsTool } from "./metrics.js"
import { teamResumeTool } from "./resume.js"


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
        team_done: teamDoneTool(ctx),
        team_results: teamResultsTool(ctx),
        team_result_get: teamResultGetTool(ctx),
        team_progress: teamProgressTool(ctx),
        team_intervene: teamInterveneTool(ctx),
        team_metrics: teamMetricsTool(ctx),
        team_resume: teamResumeTool(ctx),
    }
}

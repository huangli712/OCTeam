/**
 * Tool registry. createTools(ctx) returns the full { [name]: ToolDefinition }
 * map consumed by the server module's Hooks.tool. Each tool closes over the
 * shared PluginContext.
 */

import type { PluginContext } from "../context.js"
import type { ToolDefinition } from "@opencode-ai/plugin"
import {
    teamCreateTool,
    teamDeleteTool,
    teamDetailsTool,
    teamFixTool,
    teamListTool,
    teamQueryTool,
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
} from "./workflow.js"
import { teamDoneTool } from "./done.js"

export function createTools(ctx: PluginContext): Record<string, ToolDefinition> {
    return {
        team_create: teamCreateTool(ctx),
        team_delete: teamDeleteTool(ctx),
        team_list: teamListTool(ctx),
        team_query: teamQueryTool(ctx),
        team_details: teamDetailsTool(ctx),
        team_fix: teamFixTool(ctx),
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
        team_done: teamDoneTool(ctx),
    }
}

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
    teamApproveShutdownTool,
    teamRejectShutdownTool,
    teamShutdownRequestTool,
} from "./shutdown.js"
import {
    teamDelegateTool,
    teamLoopTool,
    teamParallelTool,
    teamPipelineTool,
} from "./workflow.js"

export function createTools(ctx: PluginContext): Record<string, ToolDefinition> {
    return {
        team_create: teamCreateTool(ctx),
        team_delete: teamDeleteTool(ctx),
        team_list: teamListTool(ctx),
        team_query: teamQueryTool(ctx),
        team_details: teamDetailsTool(ctx),
        team_send_message: teamSendMessageTool(ctx),
        team_task_create: teamTaskCreateTool(ctx),
        team_task_list: teamTaskListTool(ctx),
        team_task_update: teamTaskUpdateTool(ctx),
        team_task_get: teamTaskGetTool(ctx),
        team_shutdown_request: teamShutdownRequestTool(ctx),
        team_approve_shutdown: teamApproveShutdownTool(ctx),
        team_reject_shutdown: teamRejectShutdownTool(ctx),
        team_parallel: teamParallelTool(ctx),
        team_pipeline: teamPipelineTool(ctx),
        team_loop: teamLoopTool(ctx),
        team_delegate: teamDelegateTool(ctx),
    }
}

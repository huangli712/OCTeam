/**
 * Tool registry. createTools(ctx) returns the full { [name]: ToolDefinition }
 * map consumed by the server module's Hooks.tool. Each tool closes over the
 * shared PluginContext.
 */

import type { ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../core/context.js"
//
import { teamCancelTool } from "./control/cancel.js"
import { teamFixWorkflowTool } from "./control/fixflow.js"
import { teamDoneTool } from "./control/done.js"
import { teamInterveneTool } from "./control/intervene.js"
import { teamResumeTool } from "./control/resume.js"
import { teamApproveTool, teamRejectTool } from "./control/approve.js"
//
import { teamActivateTool } from "./lifecycle/activate.js"
import { teamAddMemberTool } from "./lifecycle/add.js"
import { teamCreateTool } from "./lifecycle/create.js"
import { teamDeactivateTool } from "./lifecycle/deactivate.js"
import { teamDeleteTool } from "./lifecycle/delete.js"
import { teamDetailsTool } from "./lifecycle/details.js"
import { teamFixMemberTool } from "./lifecycle/fixmember.js"
import { teamListTool } from "./lifecycle/list.js"
import { teamRemoveMemberTool } from "./lifecycle/remove.js"
import { teamRenameTool } from "./lifecycle/rename.js"
//
import { teamQueryTool } from "./query/inspect.js"
import { teamMetricsTool } from "./query/metrics.js"
import { teamResultsTool, teamResultGetTool } from "./query/results.js"
import { teamRunDirTool } from "./query/rundir.js"
import { teamRootDirTool } from "./query/rootdir.js"
import { teamProgressTool } from "./query/progress.js"
//
import { teamSendMessageTool } from "./exchange/messaging.js"
import {
    teamTaskCreateTool,
    teamTaskGetTool,
    teamTaskListTool,
    teamTaskUpdateTool,
} from "./exchange/task.js"
//
import { teamConsensusTool } from "./modes/consensus.js"
import { teamDelegateTool } from "./modes/delegate.js"
import { teamLoopTool } from "./modes/loop.js"
import { teamParallelTool } from "./modes/parallel.js"
import { teamPipelineTool } from "./modes/pipeline.js"
import { teamRouteTool } from "./modes/router.js"
import { teamArbitrateTool } from "./modes/arbitrate.js"
import { teamArenaTool } from "./modes/arena.js"
import { teamQuorumTool } from "./modes/quorum.js"
import { teamRecurseTool } from "./modes/recurse.js"
import { teamTollgateTool } from "./modes/tollgate.js"
//
import { teamWorkflowTool } from "./workflow/engine.js"
import { teamPlannerTool } from "./workflow/planner.js"

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
        team_quorum: teamQuorumTool(ctx),
        team_workflow: teamWorkflowTool(ctx),
        team_fix_workflow: teamFixWorkflowTool(ctx),
        team_planner: teamPlannerTool(ctx),
        team_done: teamDoneTool(ctx),
        team_results: teamResultsTool(ctx),
        team_result_get: teamResultGetTool(ctx),
        team_run_dir: teamRunDirTool(ctx),
        team_root_dir: teamRootDirTool(ctx),
        team_progress: teamProgressTool(ctx),
        team_intervene: teamInterveneTool(ctx),
        team_approve: teamApproveTool(ctx),
        team_reject: teamRejectTool(ctx),
        team_metrics: teamMetricsTool(ctx),
        team_resume: teamResumeTool(ctx),
    }
}

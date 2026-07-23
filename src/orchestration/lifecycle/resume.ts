/**
 * Per-mode re-dispatch entry for team_resume's Phase 3. The 11 mode-specific
 * resume handlers and their shared helpers live in resume-modes.ts; this file
 * owns only the dispatcher (called by tools/control/resume.ts).
 *
 * Called inside team.mutex.runExclusive AFTER activeTask is committed. Mutates
 * team/task freely; does NOT save state (caller owns persistence).
 */

import type { PluginContext } from "../../core/context.js";
import type { ActiveTask } from "../../core/types.js";
import type { Team } from "../../state/store.js";
import { resumeApprovalStage } from "../control/approval.js";
import {
    resumeSignoffReduceStage,
    resumeParallelMode,
    resumeConsensusMode,
    resumeSequentialMode,
    resumeDelegateMode,
    resumeRouteMode,
    resumeArbitrateMode,
    resumeRecurseMode,
    resumeTollgateMode,
    resumeWorkflowMode,
    resumeArenaMode,
    resumeQuorumMode,
} from "./resume-modes.js";

/** Per-mode re-dispatch entry for team_resume Phase 3: delegates to each mode's resume handler. */
export async function resumeDispatch(
    ctx: PluginContext,
    team: Team,
    task: ActiveTask,
): Promise<void> {
    if (await resumeApprovalStage(ctx, team)) return;
    // Signoff/reduce sub-stage recovery (returns early if in progress).
    if (await resumeSignoffReduceStage(ctx, team, task)) return;

    switch (task.type) {
        case "parallel":
            return await resumeParallelMode(ctx, team, task);
        case "consensus":
            return await resumeConsensusMode(ctx, team, task);
        case "pipeline":
        case "loop":
            return await resumeSequentialMode(ctx, team, task);
        case "delegate":
            return await resumeDelegateMode(ctx, team);
        case "route":
            return await resumeRouteMode(ctx, team, task);
        case "arbitrate":
            return await resumeArbitrateMode(ctx, team, task);
        case "recurse":
            return await resumeRecurseMode(ctx, team);
        case "tollgate":
            return await resumeTollgateMode(ctx, team, task);
        case "workflow":
            return await resumeWorkflowMode(ctx, team, task);
        case "arena":
            return await resumeArenaMode(ctx, team, task);
        case "quorum":
            return await resumeQuorumMode(ctx, team, task);
        default: {
            // Exhaustiveness guard: every OrchestrationType is handled above, so
            // task.type narrows to `never` here. A new type added without a
            // matching case fails this assignment at compile time; at runtime it
            // throws instead of letting resumeDispatch return and stall the run.
            const _exhaustive: never = task;
            void _exhaustive;
            throw new Error(
                `Unhandled task type: ${(task as { type: string }).type}`,
            );
        }
    }
}

/**
 * Result summary construction and leader delivery.
 *
 * The leader session is always notified via promptAsync when a workflow
 * completes — the summary is pushed immediately regardless of the leader's
 * current session state. The host queues the promptAsync if the leader is
 * mid-turn and drives a new turn when the leader becomes available.
 *
 * Detailed per-member results that were sent to the master mailbox during the
 * workflow (e.g. via team_send_message in delegate/consensus modes) are
 * drained separately by deliverQueuedResultsToMaster on the master's idle
 * event.
 */

import type { PluginContext } from "../../core/context.js"
import { type Team, clearActiveTask } from "../../state/store.js"
import { truncateOutput } from "../protocol/output.js"
import { deliverSummaryToLeader } from "../runtime/completion.js"
import type { ActiveTask } from "../../core/types.js"
import {
    summarizeDelegate,
    summarizeLoop,
    summarizeRoute,
    summarizeArbitrate,
    summarizeRecurse,
    summarizeTollgate,
    summarizePipeline,
    summarizeWorkflow,
    summarizeConsensus,
    summarizeParallel,
    summarizeArena,
} from "./summarize-mode.js"

/**
 * Deliver the run summary, clear the active task, and set the team status.
 * Consolidates the teardown triplet (deliver -> clear -> status) that was
 * copy-pasted across the orchestration primitives. Sites with intervening
 * work between deliver and clear (e.g. loop's decisionHistory.push) call the
 * individual operations directly.
 */
export async function finishRun(
    ctx: PluginContext,
    team: Team,
    reason: string,
    status: "idle" | "failed",
): Promise<void> {
    // Map team status to run status for persistRun. "idle" = completed run,
    // "failed" = failed run. Threaded explicitly so persistRun no longer relies
    // on the runStatusFromReason substring heuristic.
    await deliverSummaryToLeader(ctx, team, reason, status === "failed" ? "failed" : "completed")
    clearActiveTask(team)
    team.status = status
}

/**
 * Mode-aware summary. delegate aggregates from the task list (per-task results
 * were already delivered to master via team_send_message; responses[] is NOT
 * used for delegate). loop uses decisionHistory (structured) rather than
 * the overwritten responses[]. parallel/pipeline concatenate captured outputs.
 *
 * Per-mode formatting lives in the summarize* helpers below; this function is
 * a thin dispatcher with an exhaustiveness guard on OrchestrationType.
 */
export async function buildSummary(
    team: Team,
    task: ActiveTask,
    reason: string,
): Promise<string> {
    const head = `mode=${task.type} reason=${reason} tokens=${task.tokensUsed}`
    switch (task.type) {
        case "delegate": return await summarizeDelegate(team, head)
        case "loop": return summarizeLoop(task, head)
        case "route": return summarizeRoute(task, head)
        case "arbitrate": return summarizeArbitrate(task, head)
        case "recurse": return await summarizeRecurse(team, task, head)
        case "tollgate": return summarizeTollgate(task, head)
        case "pipeline": return summarizePipeline(task, head)
        case "consensus": return summarizeConsensus(task, head)
        case "parallel": return summarizeParallel(task, head)
        case "workflow": return summarizeWorkflow(task, head)
        case "arena": return summarizeArena(task, head)
        default: {
            // Exhaustiveness guard for OrchestrationType. Every variant has an
            // explicit case above, so task narrows to `never` here. Adding a new
            // OrchestrationType without a matching case fails this assignment at
            // compile time. Runtime throw prevents silent fall-through.
            const _exhaustive: never = task
            void _exhaustive
            throw new Error(`buildSummary: unhandled OrchestrationType: ${String((task as { type: string }).type)}`)
        }
    }
}

/** One-line-per-member digest of the current round's outputs (consensus). */
export function buildRoundSummary(responses: Record<string, string>): string {
    return Object.entries(responses)
        .map(([name, out]) => `- ${name}: ${truncateOutput(out, 500)}`)
        .join("\n")
}

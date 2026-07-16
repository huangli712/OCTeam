/**
 * Result summary construction for completed orchestration runs.
 */

import type { Team } from "../../state/store.js"
import { truncateOutput } from "../protocol/output.js"
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
} from "./renderers.js"

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
    const head = `<mode>${task.type}</model>\n` 
        + `<reason>${reason}</reason>\n`
        + `<tokens>${task.tokensUsed}</tokens>\n`
    switch (task.type) {
        case "delegate": return await summarizeDelegate(team, task, head)
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
        .map(([name, out]) => `by ${name}:\n ${truncateOutput(out, 500)}`)
        .join("\n\n")
}

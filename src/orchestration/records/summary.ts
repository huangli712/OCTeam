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
    summarizeQuorum,
} from "./renderers.js"

/**
 * Mode-aware summary. delegate aggregates from the task list (per-task results
 * were already delivered to master via team_send_message) and also uses
 * responses[] for the final output. loop uses decisionHistory (structured)
 * rather than the overwritten responses[]. parallel/pipeline concatenate
 * captured outputs.
 *
 * Per-mode formatting lives in the summarize* helpers below; this function is
 * a thin dispatcher with an exhaustiveness guard on OrchestrationType.
 */
export async function buildSummary(
    team: Team,
    task: ActiveTask,
    reason: string,
): Promise<string> {
    // Escape XML control fields so member output or reason
    // text containing </reason> etc. cannot break the summary structure.
    const escapeXml = (s: string): string =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    const head = `<mode>${task.type}</mode>\n` 
        + `<reason>${escapeXml(reason)}</reason>\n`
        + `<tokens>${task.tokensUsed}</tokens>\n`
    // Enforce a total UTF-8 byte budget on the summary so large
    // multi-member outputs don't create an oversized leader prompt.
    const SUMMARY_BUDGET = 65536
    let body: string
    switch (task.type) {
        case "delegate": body = await summarizeDelegate(team, task, head); break
        case "loop": body = summarizeLoop(task, head); break
        case "route": body = summarizeRoute(task, head); break
        case "arbitrate": body = summarizeArbitrate(task, head); break
        case "recurse": body = await summarizeRecurse(team, task, head); break
        case "tollgate": body = summarizeTollgate(task, head); break
        case "pipeline": body = summarizePipeline(task, head); break
        case "consensus": body = summarizeConsensus(task, head); break
        case "parallel": body = summarizeParallel(task, head); break
        case "workflow": body = summarizeWorkflow(task, head); break
        case "arena": body = summarizeArena(task, head); break
        case "quorum": body = summarizeQuorum(task, head); break
        default: {
            const _exhaustive: never = task
            void _exhaustive
            throw new Error(
                `buildSummary: unhandled OrchestrationType: ${String((task as { type: string }).type)}`,
            )
        }
    }
    if (Buffer.byteLength(body, "utf8") > SUMMARY_BUDGET) {
        const marker = "\n[...summary truncated at 64KiB]"
        const markerBytes = Buffer.byteLength(marker, "utf8")
        return truncateOutput(body, SUMMARY_BUDGET - markerBytes) + marker
    }
    return body
}

/** One-line-per-member digest of the current round's outputs (consensus). */
export function buildRoundSummary(responses: Record<string, string>): string {
    return Object.entries(responses)
        .map(([name, out]) => `by ${name}:\n${truncateOutput(out, 500)}`)
        .join("\n\n")
}

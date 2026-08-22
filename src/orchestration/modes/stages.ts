/**
 * Shared infrastructure for sequential-stage modes (pipeline, loop, tollgate):
 * upstream-context assembly and the stage-advance dispatch primitive.
 */

import type { PluginContext } from "../../core/context.js";
import type { Stage } from "../../core/types.js";
import type { Team } from "../../state/store.js";
import { dispatchToMember } from "../control/dispatch.js";
import { truncateOutput } from "../protocol/output.js";
import { recordEvent } from "../records/events.js";
import { finishRun } from "../control/completion.js";

/** Byte budget for assembled upstream context to prevent unbounded prompt
 *  growth. Soft cap: truncation markers and block separators are not counted
 *  against it, so the assembled text can slightly exceed this figure. */
const UPSTREAM_TOTAL_CAP = 65_536;

/** Contract injected into read-only stages so a clean report can end the loop early via <no_issues/>. */
const NO_ISSUES_CONTRACT =
    "If you find NO issues, end your reply with the literal tag <no_issues/> " +
    "(or <无问题/>). Emit it ONLY when truly clean — it ends the loop.";

/**
 * Assemble upstream context from completed prior stages' outputs, budgeted
 * at UPSTREAM_TOTAL_CAP bytes (soft cap — the truncation marker and block
 * separators are added outside the budget). Returns the concatenated blocks
 * (or an empty string when no prior stage produced output).
 */
export function buildUpstreamContext(
    stages: Stage[],
    responses: Record<string, string>,
    uptoIndex: number,
): string {
    // Iterate backward from the most recent completed stage so truncation drops
    // the oldest, least relevant outputs rather than the immediately preceding one.
    const collected: string[] = [];
    let used = 0;
    for (let i = uptoIndex - 1; i >= 0; i--) {
        const stage = stages[i];
        if (!stage?.completed) continue;
        const output = responses[stage.member];
        if (!output) continue;
        const label = `[Output from ${stage.member}]\n`;
        const bodyBudget = UPSTREAM_TOTAL_CAP - Buffer.byteLength(label, "utf8");
        const block = label + truncateOutput(output, bodyBudget);
        const blockSize = Buffer.byteLength(block, "utf8");
        if (used + blockSize > UPSTREAM_TOTAL_CAP) {
            collected.unshift(`[...upstream context truncated at ${UPSTREAM_TOTAL_CAP} bytes]`);
            break;
        }
        collected.unshift(block);
        used += blockSize;
    }
    return collected.join("\n\n");
}

/**
 * Dispatch the given stage's member with upstream context prepended. Applies
 * the read-only <no_issues/> contract when the stage action is read_only, and
 * an optional contextPrefix (e.g. loop decider feedback) before the upstream
 * block. Transitions the member to running and records a dispatched event.
 */
export async function advanceToStage(
    ctx: PluginContext,
    team: Team,
    stage: Stage,
    contextPrefix?: string,
): Promise<void> {
    const task = team.activeTask;
    if (!task) return;
    const member = team.members.find((candidate) => candidate.name === stage.member);
    if (!member?.sessionId) {
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "errored",
            member: stage.member,
            detail: `advanceToStage: member "${stage.member}" has no session`,
        });
        await finishRun(ctx, team, `stage_failed:missing_session:${stage.member}`, "failed");
        return;
    }
    const upstream = buildUpstreamContext(
        task.stages,
        task.responses,
        task.currentStageIndex,
    );
    const readOnlyContract = stage.action === "read_only" ? `\n\n${NO_ISSUES_CONTRACT}` : "";
    const base = upstream
        ? `${upstream}\n\n[Your task]\n${stage.task}${readOnlyContract}`
        : `${stage.task}${readOnlyContract}`;
    const rawText = contextPrefix ? `${contextPrefix}\n\n${base}` : base;
    // Route through the canonical dispatch primitive so promptAsync +
    // member state transition + saveTeamState + event recording are atomic.
    await dispatchToMember(
        ctx,
        member,
        rawText,
        member.worktreePath ?? ctx.directory,
        team,
    );
}

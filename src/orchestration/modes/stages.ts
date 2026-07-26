/**
 * Shared infrastructure for sequential-stage modes (pipeline, loop, tollgate):
 * upstream-context assembly and the stage-advance dispatch primitive.
 */

import type { PluginContext } from "../../core/context.js";
import { safeMemberAgent } from "../../core/role.js";
import type { Stage } from "../../core/types.js";
import type { Team } from "../../state/store.js";
import { prependStandingInstruction } from "../control/dispatch.js";
import { truncateOutput } from "../protocol/output.js";
import { recordEvent } from "../records/events.js";
import { finishRun } from "../control/completion.js";

/** Hard byte cap on assembled upstream context to prevent unbounded prompt growth. */
const UPSTREAM_TOTAL_CAP = 65_536;

/** Contract injected into read-only stages so a clean report can end the loop early via <no_issues/>. */
const NO_ISSUES_CONTRACT =
    "If you find NO issues, end your reply with the literal tag <no_issues/> " +
    "(or <无问题/>). Emit it ONLY when truly clean — it ends the loop.";

/**
 * Assemble upstream context from completed prior stages' outputs, capped at
 * UPSTREAM_TOTAL_CAP bytes. Returns the concatenated blocks (or an empty
 * string when no prior stage produced output).
 */
export function buildUpstreamContext(
    stages: Stage[],
    responses: Record<string, string>,
    uptoIndex: number,
): string {
    const blocks: string[] = [];
    let used = 0;
    for (let i = 0; i < uptoIndex; i++) {
        const stage = stages[i];
        if (!stage?.completed) continue;
        const output = responses[stage.member];
        if (!output) continue;
        const block = `[Output from ${stage.member}]\n${truncateOutput(output)}`;
        const blockSize = Buffer.byteLength(block, "utf8");
        if (used + blockSize > UPSTREAM_TOTAL_CAP) {
            blocks.push(`[…upstream context truncated at ${UPSTREAM_TOTAL_CAP} bytes]`);
            break;
        }
        blocks.push(block);
        used += blockSize;
    }
    return blocks.join("\n\n");
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
    const newText = prependStandingInstruction(member, rawText);
    await ctx.client.session.promptAsync({
        path: { id: member.sessionId },
        body: {
            parts: [
                {
                    type: "text",
                    text: `${newText}\n<!-- OMO_INTERNAL_INITIATOR -->`,
                    synthetic: false,
                }
            ],
            agent: safeMemberAgent(member.agent),
        },
        query: { directory: member.worktreePath ?? ctx.directory },
    });
    member.promptDelivered = true;
    member.status = "running";
    member.turnCount++;
    recordEvent(team, {
        timestamp: Date.now(),
        kind: "dispatched",
        member: member.name,
        stage: task.currentStageIndex,
        round: task.currentRound,
    });
}

/**
 * Member task-dispatch primitives shared by orchestration modes.
 */

import type { PluginContext } from "../../core/context.js";
import { safeMemberAgent } from "../../core/role.js";
import type { MemberState } from "../../core/types.js";
import type { Team } from "../../state/store.js";
import { recordEvent } from "../records/events.js";

/**
 * Prepend the member's standing instruction once per member.
 */
export function prependStandingInstruction(
    member: MemberState,
    text: string,
): string {
    if (member.promptDelivered || !member.prompt) return text;
    return `<standing-instruction>\n${member.prompt}\n</standing-instruction>\n\n${text}`;
}

/**
 * Send a synthetic text prompt to a member and mark it running.
 */
export async function dispatchToMember(
    ctx: PluginContext,
    member: MemberState,
    text: string,
    directory: string,
    team?: Team,
    eventMeta?: { stepIndex?: number; correlationId?: string },
): Promise<void> {
    if (!member.sessionId) return;
    if (member.status === "errored") return;
    const dispatchedText = prependStandingInstruction(member, text);
    await ctx.client.session.promptAsync({
        path: { id: member.sessionId },
        body: {
            parts: [{ type: "text", text: dispatchedText, synthetic: true }],
            agent: safeMemberAgent(member.agent),
        },
        query: { directory },
    });
    member.promptDelivered = true;
    member.status = "running";
    member.turnCount++;
    if (team) {
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "dispatched",
            member: member.name,
            ...eventMeta,
        });
    }
}

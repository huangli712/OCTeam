/**
 * Canonical member-dispatch primitives shared by orchestration modes.
 *
 * All synthetic task prompts pass through dispatchToMember so standing
 * instructions, member state transitions, turn accounting, agent selection,
 * worktree routing, and dispatch telemetry remain consistent.
 */

import type { PluginContext } from "../../core/context.js"
import { safeMemberAgent } from "../../core/role.js"
import type { MemberState } from "../../core/types.js"
import type { Team } from "../../state/store.js"
import { recordEvent } from "../records/events.js"

/**
 * Prefix a member's persistent standing instruction until the first successful
 * dispatch marks it delivered. Resume and retry paths may call this repeatedly.
 */
export function prependStandingInstruction(
    member: MemberState,
    text: string,
): string {
    if (member.promptDelivered || !member.prompt) return text
    return `<member-instruction>\n${member.prompt}\n</member-instruction>\n\n`
        +`${text}`
}

/**
 * Send one synthetic task prompt and transition the member to running.
 *
 * Members without sessions are unavailable, and errored members are terminal
 * until an explicit recovery path resets them. When a Team is supplied, the
 * dispatch is also appended to the run event stream.
 */
export async function dispatchToMember(
    ctx: PluginContext,
    member: MemberState,
    text: string,
    directory: string,
    team?: Team,
    eventMeta?: { stepIndex?: number; correlationId?: string },
): Promise<void> {
    if (!member.sessionId) return
    if (member.status === "errored") return
    const dispatchedText = prependStandingInstruction(member, text)
    await ctx.client.session.promptAsync({
        path: { id: member.sessionId },
        body: {
            parts: [
                { 
                    type: "text",
                    text: `${dispatchedText}\n<!-- OMO_INTERNAL_INITIATOR -->`,
                    synthetic: false,
                },
            ],
            agent: safeMemberAgent(member.agent),
        },
        query: { directory },
    })
    member.promptDelivered = true
    member.status = "running"
    member.turnCount++
    if (team) {
        recordEvent(team, {
            timestamp: Date.now(),
            kind: "dispatched",
            member: member.name,
            ...eventMeta,
        })
    }
}

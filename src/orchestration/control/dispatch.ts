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
import { type Team, saveTeamState } from "../../state/store.js"
import { recordEvent } from "../records/events.js"
import { logSwallowed } from "../../core/log.js"

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
        +`<task-instruction>\n${text}\n</task-instruction>`
}

/**
 * Send one synthetic task prompt and transition the member to running.
 *
 * Members without sessions are unavailable, and errored members are terminal
 * until an explicit recovery path resets them. When a Team is supplied, the
 * dispatch is also appended to the run event stream.
 *
 * C5 atomicity: after promptAsync succeeds and state is mutated, saveTeamState
 * is called IMMEDIATELY (before returning to the caller). This eliminates the
 * window where a caller could forget or delay the save, leaving the member
 * dispatched on the host but not persisted to disk. Callers that also call
 * saveTeamState after dispatch will double-save (harmless: the second save is
 * a three-way merge no-op for unchanged fields).
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
        // C5: persist immediately so the dispatched state survives a crash
        // before the caller's own saveTeamState call. If this save fails,
        // log it but do NOT throw — the member is already dispatched on the
        // host, and throwing would leave the caller unable to recover. The
        // caller's subsequent saveTeamState (or the sweep's save) will retry.
        try {
            await saveTeamState(team)
        } catch (err) {
            logSwallowed(ctx, "dispatchToMember: immediate saveTeamState failed after dispatch", err, {
                member: member.name, team: team.teamName,
            })
        }
    }
}

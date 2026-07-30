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
import { type Team, saveTeamStateBounded } from "../../state/store.js"
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
    // #10: persist dispatch intent BEFORE sending the prompt. Pre-fix code
    // called promptAsync first, then set status/turnCount and saved — a crash
    // between prompt and save left disk unaware of the dispatch, and recovery
    // would re-dispatch (duplicate prompt) with no way to attribute the old
    // output. Now: set state + persist first, then send. If promptAsync
    // fails, rollback the state so the next caller can retry.
    // Save originals for accurate rollback.
    const origPromptDelivered = member.promptDelivered
    const origStatus = member.status
    const origTurnCount = member.turnCount
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
        try {
            await saveTeamStateBounded(team)
        } catch (err) {
            // If we cannot persist the dispatch intent, do NOT send the prompt.
            member.status = origStatus
            member.turnCount = origTurnCount
            member.promptDelivered = origPromptDelivered
            throw err
        }
    }
    try {
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
    } catch (err) {
        // promptAsync failed after we persisted the dispatch intent. Rollback
        // to idle so the barrier can re-drive, and persist the rollback.
        if (team) {
            member.status = origStatus
            member.turnCount = origTurnCount
            member.promptDelivered = origPromptDelivered
            try {
                await saveTeamStateBounded(team)
            } catch (rollbackErr) {
                logSwallowed(ctx, "dispatchToMember: rollback persist failed after promptAsync error", rollbackErr, {
                    member: member.name, team: team.teamName,
                })
            }
        }
        throw err
    }
}

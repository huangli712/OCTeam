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
 * Atomicity: the dispatch intent (status, turnCount, promptDelivered) is
 * persisted via saveTeamStateBounded BEFORE promptAsync is sent, so a crash
 * cannot leave the member prompted on the host but unrecorded on disk. If
 * promptAsync throws, the state is rolled back and re-persisted.
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
    // Persist dispatch intent before sending the prompt so recovery cannot
    // duplicate a prompt after a crash. Roll back the persisted intent if
    // promptAsync fails so the next caller can retry.
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
            member.status = "idle"
            member.turnCount = origTurnCount
            member.promptDelivered = origPromptDelivered
            if (team.activeTask?.type === "workflow" && eventMeta?.stepIndex !== undefined) {
                const step = team.activeTask.steps?.[eventMeta.stepIndex]
                if (step) {
                    step.dispatchedAt = undefined
                    // Clear dispatchedActor and correlationId too so resume
                    // doesn't see a stale actor reference without dispatchedAt
                    // and misclassify the step as dispatched-but-broken.
                    step.dispatchedActor = undefined
                    step.correlationId = undefined
                }
            }
            // Set retryingSince so the sweep timer re-drives this member
            // instead of stalling until wall-clock timeout. The mode handler
            // that called dispatchToMember may not have a catch path.
            member.retryingSince = Date.now()
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

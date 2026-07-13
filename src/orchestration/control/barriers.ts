/**
 * Idempotent barrier primitives shared by concurrent orchestration modes.
 *
 * Barriers do not block. They re-check readiness after each idle or explicit
 * completion acknowledgement and invoke the supplied transition exactly once
 * when every participant reaches a terminal state for the current phase.
 */

import type { Team } from "../../state/store.js"

/**
 * Check readiness for one orchestration phase without waiting.
 *
 * In the default mode, idle members are ready. When requireDoneAck is enabled
 * on the active task, members must explicitly call team_done. Errored members
 * are terminal in both modes so failure-isolation policies can advance with the
 * surviving participants. Missing members remain not-ready defensively.
 *
 * The caller holds the team mutex, so a successful transition cannot fire twice
 * for the same phase.
 */
export async function maybeAdvanceBarrier(
    team: Team,
    memberNames: string[],
    onBarrier: () => Promise<void>,
): Promise<void> {
    const requireDoneAck = team.activeTask?.requireDoneAck === true
    const allReady = memberNames.every(name => {
        const member = team.members.find(candidate => candidate.name === name)
        if (!member) return false
        if (member.status === "errored") return true
        return requireDoneAck
            ? member.declaredDone === true
            : member.status === "idle"
    })
    if (allReady) {
        await onBarrier()
    }
    // Otherwise the next idle or acknowledgement re-checks readiness.
}

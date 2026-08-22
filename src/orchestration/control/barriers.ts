/**
 * Idempotent-leaning barrier primitives shared by concurrent orchestration modes.
 *
 * Barriers do not block. They re-check readiness after each idle or explicit
 * completion acknowledgement and invoke the supplied transition when every
 * participant reaches a terminal state for the current phase. There is no
 * one-shot latch: callers must make the transition itself idempotent (or
 * transition the task so a re-check no longer fires it); the caller-held team
 * mutex serializes concurrent checks.
 */

import type { Team } from "../../state/store.js"

/**
 * Check readiness for one orchestration phase without waiting.
 *
 * In the default mode, idle members are ready. When requireDoneAck is enabled
 * on the active task, members must explicitly call team_done and finish their
 * active turn. Errored members are terminal in both modes so failure-isolation
 * policies can advance with the surviving participants. Missing members remain
 * not-ready defensively.
 *
 * The caller holds the team mutex, which serializes concurrent barrier
 * checks; re-entrancy after a completed transition is the callback's
 * responsibility (mode handlers typically finish the run or flip task state
 * so the readiness predicate no longer holds).
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
            ? member.declaredDone === true && member.status === "idle"
            : member.status === "idle"
    })
    if (allReady) {
        await onBarrier()
    }
    // Otherwise the next idle or acknowledgement re-checks readiness.
}

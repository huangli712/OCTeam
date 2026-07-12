/**
 * Idempotent barrier primitives shared by the concurrent-flavor handlers
 * (parallel, consensus, route-targets, arbitrate-debate). Extracted from the
 * god-file so the barrier logic can be unit-tested in isolation.
 */

import type { Team } from "../../state/store.js"

/**
 * Idempotent barrier check (NOT blocking). Called from handleParallelIdle on
 * each idle. If all participating members are idle, fires onBarrier exactly
 * once for this phase (the mutex guarantees the status flips are atomic, so a
 * later idle in the same phase sees members already "running" → no double-fire).
 *
 * require_done_ack mode: the readiness signal is `declaredDone === true`
 * (set by team_done tool) instead of `status === "idle"`. This prevents the
 * barrier from firing when a member goes idle prematurely (e.g. waiting for a
 * dependency); the barrier only fires after every participant has explicitly
 * acknowledged completion.
 *
 * Exported for direct unit testing of the readiness predicate.
 */
export async function waitForBarrier(
    team: Team,
    memberNames: string[],
    onBarrier: () => Promise<void>,
): Promise<void> {
    const requireDoneAck = team.activeTask?.requireDoneAck === true
    const allReady = memberNames.every(name => {
        const m = team.members.find(x => x.name === name)
        if (!m) return false
        // errored is TERMINAL: it counts toward the barrier so survivors can be
        // delivered (failure isolation). Checked first so it also unblocks a
        // require_done_ack run, where an errored member never calls team_done().
        if (m.status === "errored") return true
        return requireDoneAck
            ? m.declaredDone === true
            : m.status === "idle"
    })
    if (allReady) {
        await onBarrier()
    }
    // else: return — the next idle/ack re-checks. checkTermination + sweep enforce timeouts.
}

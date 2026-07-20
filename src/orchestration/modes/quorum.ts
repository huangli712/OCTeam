/**
 * Quorum handler -- wait-all barrier then k-of-n tally.
 *
 * STATE MACHINE:
 *   dispatch → barrier_wait → tally → deliver
 *   - Some option >= threshold → deliver (idle, "quorum_succeeded:"+option)
 *   - No option >= threshold   → deliver (failed, "quorum_no_majority")
 *   - nEff == 0                → deliver (failed, "quorum_all_errored")
 *
 * Runtime errors are handled by checkTermination (pre-barrier) per maxErroredMembers.
 * Invalid ballots are handled here (post-barrier) per parseBallot. Both abstain
 * (excluded from the denominator, not counted as no-votes).
 *
 * Re-driven by status.ts:escalateMemberToErrored on tolerated runtime errors
 * so the barrier can re-check readiness (otherwise hang until wall-clock).
 */
import type { PluginContext } from "../../core/context.js"
import { type Team } from "../../state/store.js"
import type { QuorumBallot } from "../../core/types.js"
import { finishRun } from "../control/completion.js"
import { maybeAdvanceBarrier } from "../control/barriers.js"

/**
 * Extract a ballot from a member's captured output. Returns invalid on any
 * parse failure so abstention is the safe default.
 */
function parseBallot(
    output: string | undefined,
    voteKey: string,
    voteOptions: string[] | undefined,
): QuorumBallot {
    if (!output) return { vote: "", status: "invalid" }
    // Tolerate <vote> or <投票>; extract first {...} JSON payload inside the tag.
    const match = output.match(/<(?:vote|投票)>\s*(\{[\s\S]*?\})\s*<\/(?:vote|投票)>/)
    if (!match) return { vote: "", status: "invalid" }
    try {
        const obj = JSON.parse(match[1]) as Record<string, unknown>
        const raw = obj[voteKey]
        if (typeof raw !== "string") return { vote: "", status: "invalid" }
        const vote = raw.trim()
        if (!vote) return { vote: "", status: "invalid" }
        if (voteOptions && !voteOptions.includes(vote)) {
            return { vote, status: "invalid" }
        }
        const rationale = typeof obj.rationale === "string" ? obj.rationale : undefined
        return { vote, rationale, status: "valid" }
    } catch {
        return { vote: "", status: "invalid" }
    }
}

/**
 * k-of-n quorum tally: wait for all participants, then count ballots.
 * Single mutation site: all task writes happen inside the barrier callback
 * (no concurrency). Tally reads member.status === "errored" first so runtime
 * errors are counted once via erroredCount, not double-counted via parseBallot.
 */
export async function handleQuorumIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "quorum") return
    const participants = task.participants

    await maybeAdvanceBarrier(team, participants, async () => {
        const ballots: Record<string, QuorumBallot> = {}
        let erroredCount = 0

        for (const name of participants) {
            const member = team.members.find(m => m.name === name)
            // Runtime-errored members: abstain. Their responses[name] is ignored
            // even if it contains output from an earlier turn.
            if (member?.status === "errored") {
                ballots[name] = { vote: "", status: "errored" }
                erroredCount++
                continue
            }
            const ballot = parseBallot(task.responses[name], task.voteKey, task.voteOptions)
            ballots[name] = ballot
            if (ballot.status !== "valid") erroredCount++
        }

        const nEff = participants.length - erroredCount
        const threshold = Math.floor(nEff / 2) + 1

        task.ballots = ballots
        task.erroredCount = erroredCount
        task.nEff = nEff
        task.threshold = threshold

        const counts: Record<string, number> = {}
        for (const name of participants) {
            const b = ballots[name]
            if (b.status === "valid") {
                counts[b.vote] = (counts[b.vote] ?? 0) + 1
            }
        }

        // Verdict — three explicit terminal states.
        if (nEff === 0) {
            await finishRun(ctx, team, "quorum_all_errored", "failed")
            return
        }
        let winner: string | null = null
        // threshold = floor(nEff/2)+1 guarantees strict majority: at most one
        // option can reach it, so first match wins and no tie-breaking is needed.
        for (const [option, count] of Object.entries(counts)) {
            if (count >= threshold) { winner = option; break }
        }
        if (winner !== null) {
            task.winningOption = winner
            await finishRun(ctx, team, `quorum_succeeded:${winner}`, "idle")
        } else {
            await finishRun(ctx, team, "quorum_no_majority", "failed")
        }
    })
}

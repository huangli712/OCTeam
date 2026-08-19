/**
 * Quorum handler -- wait-all barrier then k-of-n tally.
 *
 * STATE MACHINE:
 *   dispatch → barrier_wait → tally → deliver
 *   - Some option >= threshold → deliver (idle, "quorum_succeeded:"+option)
 *   - No option >= threshold   → deliver (failed, "quorum_no_majority")
 *   - nEff == 0                → deliver (failed, quorum_all_abstained /
 *     quorum_all_errored / quorum_all_malformed per cause)
 *
 * Runtime errors are handled by checkTermination (pre-barrier) per maxErroredMembers.
 * Invalid ballots are handled here (post-barrier) per parseBallot. Both abstain
 * (excluded from the denominator, not counted as no-votes).
 *
 * Re-driven by status.ts:escalateMemberToErrored on tolerated runtime errors
 * so the barrier can re-check readiness (otherwise hang until wall-clock).
 */

import { extractTaggedJSON } from "../protocol/decisions.js"
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
    // Use shared extractTaggedJSON instead of a local regex.
    const parsed = extractTaggedJSON(output, "vote", "投票")
    if (parsed === null || parsed === undefined) return { vote: "", status: "invalid" }
    const raw = parsed[voteKey]
    if (typeof raw !== "string") return { vote: "", status: "invalid" }
    const vote = raw.trim()
    if (!vote) return { vote: "", status: "invalid" }
    const normalizedOptions = voteOptions?.map(o => o.trim())
    if (normalizedOptions && !normalizedOptions.includes(vote)) {
        return { vote, status: "invalid" }
    }
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale : undefined
    return { vote, rationale, status: "valid" }
}

/**
 * k-of-n quorum tally: wait for all participants, then count ballots.
 * Single mutation site: all task writes happen inside the barrier callback
 * (no concurrency). Tally reads member.status === "errored" first so runtime
 * errors are counted once via abstainCount, not double-counted via parseBallot.
 */
export async function handleQuorumIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "quorum") return
    const participants = task.participants

    await maybeAdvanceBarrier(team, participants, async () => {
        const ballots: Record<string, QuorumBallot> = {}
        let abstainCount = 0
        // Track malformed ballots separately from errored members so the run
        // record distinguishes crashes from unparseable output.
        let malformedCount = 0
        let erroredMemberCount = 0

        for (const name of participants) {
            const member = team.members.find(m => m.name === name)
            if (member?.status === "errored") {
                ballots[name] = { vote: "", status: "errored" }
                abstainCount++
                erroredMemberCount++
                continue
            }
            const ballot = parseBallot(task.responses[name], task.voteKey, task.voteOptions)
            ballots[name] = ballot
            if (ballot.status !== "valid") {
                abstainCount++
                malformedCount++
            }
        }

        const nEff = participants.length - abstainCount
        const threshold = Math.floor(nEff / 2) + 1

        task.ballots = ballots
        // Record the combined abstain count for backward compatibility. The
        // errored/malformed split stays local and surfaces only in the
        // all-abstained termination reason below.
        task.erroredCount = abstainCount
        task.nEff = nEff
        task.threshold = threshold

        // Use a null-prototype object so ballots such as "__proto__" or
        // "constructor" cannot mutate the prototype or shadow inherited
        // properties in the vote counts.
        const counts: Record<string, number> = Object.create(null)
        for (const name of participants) {
            const b = ballots[name]
            if (b.status === "valid") {
                counts[b.vote] = (counts[b.vote] ?? 0) + 1
            }
        }

        // Verdict — three explicit terminal states.
        if (nEff === 0) {
            // Distinguish all-errored (members crashed) from
            // all-malformed (members returned unparseable output).
            const reason = erroredMemberCount > 0 && malformedCount > 0
                ? `quorum_all_abstained:${erroredMemberCount}_errored:${malformedCount}_malformed`
                : erroredMemberCount > 0
                    ? "quorum_all_errored"
                    : "quorum_all_malformed"
            await finishRun(ctx, team, reason, "failed")
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

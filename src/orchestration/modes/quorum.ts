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
    // Tolerate <vote> or <投票>; extract LAST {...} JSON payload inside the tag.
    // H-17: use matchAll + last, not match (which returns first). When a member
    // restates an old vote before giving the final one, the stale FIRST match
    // would win — the LAST match is the authoritative ballot.
    const re = /<(?:vote|投票)>\s*(\{[\s\S]*?\})\s*<\/(?:vote|投票)>/g
    const matches = [...output.matchAll(re)]
    if (matches.length === 0) return { vote: "", status: "invalid" }
    const match = matches[matches.length - 1]
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
 * errors are counted once via abstainCount, not double-counted via parseBallot.
 */
export async function handleQuorumIdle(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "quorum") return
    const participants = task.participants

    await maybeAdvanceBarrier(team, participants, async () => {
        const ballots: Record<string, QuorumBallot> = {}
        let abstainCount = 0

        for (const name of participants) {
            const member = team.members.find(m => m.name === name)
            // Runtime-errored members: abstain. Their responses[name] is ignored
            // even if it contains output from an earlier turn.
            if (member?.status === "errored") {
                ballots[name] = { vote: "", status: "errored" }
                abstainCount++
                continue
            }
            const ballot = parseBallot(task.responses[name], task.voteKey, task.voteOptions)
            ballots[name] = ballot
            if (ballot.status !== "valid") abstainCount++
        }

        const nEff = participants.length - abstainCount
        const threshold = Math.floor(nEff / 2) + 1

        task.ballots = ballots
        task.erroredCount = abstainCount
        task.nEff = nEff
        task.threshold = threshold

        // HIGH-D: use a null-prototype object for vote counts so a ballot
        // with value "__proto__" or "constructor" cannot pollute Object.prototype
        // or shadow inherited properties. Pre-fix code used `{}` which inherits
        // from Object.prototype — `counts["__proto__"]` would set the prototype,
        // and `counts["constructor"]` would shadow the constructor property.
        const counts: Record<string, number> = Object.create(null)
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

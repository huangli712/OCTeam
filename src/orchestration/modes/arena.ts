/**
 * Arena orchestration: the deterministic winner selection (selectArenaWinner,
 * pure) plus the two-phase state machine — implement (barrier, failure
 * isolation, implement->evaluate transition that dispatches the evaluator) and
 * evaluate (scoreboard parse, winner selection, bounded eval retry, delivery).
 */

import type { PluginContext } from "../../core/context.js"
import { type Team, saveTeamState } from "../../state/store.js"
import type { ArenaCandidateScore, ArenaScoreboard, ArenaTask, MemberState } from "../../core/types.js"
import { waitForBarrier } from "../runtime/barriers.js"
import { dispatchToMember } from "../runtime/dispatch.js"
import { parseScoreboard } from "../protocol/decisions.js"
import { finishRun } from "../runs/summary.js"

/**
 * Select the winning candidate deterministically from an evaluator-attested
 * scoreboard. `candidates` is the eligible-to-win set (the caller passes
 * `task.survivingCandidates`, NOT the original full candidate list), so a
 * candidate that errored during implement is "unknown" here and can never win
 * even if the evaluator still scored it.
 *
 * A candidate is eligible IFF it appears in `candidates`, has exactly one
 * scoreboard entry (duplicate entries are ambiguous → ineligible), `passed`
 * is strictly true, and its selected metric is a finite number — where the
 * value is `entry.score` when `winnerMetric === "score"`, else
 * `entry.metrics?.[winnerMetric]`. Among eligible candidates the max (or min)
 * value wins; ties are broken by the earliest index in `candidates`. When no
 * candidate qualifies the result is `{ winner: undefined, reason:
 * "no_eligible_candidate" }`.
 */
export function selectArenaWinner(
    candidates: string[],
    scoreboard: ArenaScoreboard,
    direction: "max" | "min",
    winnerMetric: string,
): { winner?: string; reason?: string } {
    // Index entries by member so a member with more than one entry is treated
    // as ambiguous (ineligible); dedup is a selection concern, not a parse one.
    const entriesByMember = new Map<string, ArenaCandidateScore[]>()
    for (const entry of scoreboard.scores) {
        const list = entriesByMember.get(entry.member)
        if (list) list.push(entry)
        else entriesByMember.set(entry.member, [entry])
    }

    let winner: string | undefined
    let bestValue: number | undefined
    for (const name of candidates) {
        const entries = entriesByMember.get(name)
        if (!entries || entries.length !== 1) continue   // unknown (0) or duplicate (>1)
        const entry = entries[0]
        if (entry.passed !== true) continue
        const value = winnerMetric === "score" ? entry.score : entry.metrics?.[winnerMetric]
        if (typeof value !== "number" || !Number.isFinite(value)) continue
        // Strict comparison keeps the earliest-index candidate on a tie.
        if (bestValue === undefined || (direction === "max" ? value > bestValue : value < bestValue)) {
            winner = name
            bestValue = value
        }
    }

    if (winner === undefined) return { winner: undefined, reason: "no_eligible_candidate" }
    return { winner }
}

/**
 * Transition implement -> evaluate. Live-check the evaluator (exists,
 * non-master, has a session, not terminally errored); if it is not live, fail
 * closed WITHOUT entering the evaluate phase (there would be no running prompt
 * to await). Otherwise set the evaluate phase and dispatch the evaluator its
 * scoreboard prompt in its own worktree.
 */
export async function startArenaEvaluation(ctx: PluginContext, team: Team): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "arena") return
    const evaluator = team.members.find(m => m.name === task.evaluatorMember && !m.isMaster)
    if (!evaluator?.sessionId || evaluator.status === "errored") {
        await finishRun(ctx, team, "arena_failed:evaluator_unavailable", "failed")
        return
    }
    task.arenaPhase = "evaluate"
    await dispatchToMember(
        ctx,
        evaluator,
        buildArenaEvaluatorPrompt(task, team),
        evaluator.worktreePath ?? ctx.directory,
        team,
    )
    await saveTeamState(team)
}

/**
 * Build the evaluator's dispatch prompt: every SURVIVING candidate's name +
 * absolute worktree path, the eval command/criteria, the winner metric +
 * direction, and the EXACT <scoreboard> block the evaluator must emit. The
 * evaluator runs the command against each candidate's WORKING TREE (uncommitted
 * agent edits included), reading the absolute paths shown — NOT a committed ref.
 */
export function buildArenaEvaluatorPrompt(task: ArenaTask, team: Team): string {
    const survivors = task.survivingCandidates ?? []
    const rows = survivors
        .map(name => {
            const wt = team.members.find(m => m.name === name)?.worktreePath ?? "(no worktree)"
            return `- ${name}: ${wt}`
        })
        .join("\n")
    const basis: string[] = []
    if (task.evalCommand) basis.push(`Eval command: ${task.evalCommand}`)
    if (task.evalCriteria) basis.push(`Eval criteria: ${task.evalCriteria}`)
    return (
        `[Arena evaluation] Objectively score every candidate below on the same basis.\n`
        + `Candidates (name: absolute worktree path):\n${rows}\n\n`
        + `${basis.join("\n")}\n`
        + `Winner metric: "${task.winnerMetric}", selected by ${task.scoreDirection}.\n\n`
        + `Run the eval command against EACH candidate's WORKING TREE at the absolute path `
        + `above (include uncommitted agent edits; do NOT check out a committed ref). Read `
        + `each candidate's files at the path shown and score them all identically.\n`
        + `Emit EXACTLY one scoreboard block and nothing after it:\n`
        + `<scoreboard>{"scores":[{"member":"...","score":<n>,"metrics":{...},"passed":true|false,"rationale":"..."}],"rationale":"..."}</scoreboard>`
    )
}

/**
 * Arena idle handler for BOTH phases.
 *
 * IMPLEMENT: on each candidate idle, re-check the barrier over the ORIGINAL
 * candidate set (errored members count as terminal-ready in waitForBarrier).
 * When it fires, apply failure isolation IDENTICAL to termination 3b — the two
 * MUST agree on the reason string — then hand the surviving subset to the
 * evaluator. The barrier ignores the trigger member's identity.
 *
 * EVALUATE: only the evaluator's idle is honored (a stray candidate idle is
 * ignored). Parse its <scoreboard>; on parse failure or no eligible winner,
 * delete the stale response and re-dispatch the evaluator (bounded by
 * maxEvalRetries), else record the deterministic winner and deliver directly
 * (v1 has NO signoff gate).
 */
export async function handleArenaIdle(
    ctx: PluginContext,
    team: Team,
    member: MemberState,
): Promise<void> {
    const task = team.activeTask
    if (!task || task.type !== "arena") return
    const phase = task.arenaPhase ?? "implement"

    if (phase === "evaluate") {
        // Only the evaluator's idle drives the evaluate phase; a stray candidate
        // idle (a late implement-phase turn) is ignored.
        if (member.name !== task.evaluatorMember) return
        // Fail closed on missing/empty survivingCandidates: it is
        // always set at the implement->evaluate transition, so absence here means
        // corrupted/edited state. NEVER fall back to task.candidates — that would
        // re-admit an errored candidate to winning.
        if (!task.survivingCandidates || task.survivingCandidates.length === 0) {
            await finishRun(ctx, team, "arena_failed:no_survivors", "failed")
            return
        }
        const sb = parseScoreboard(task.responses[task.evaluatorMember] ?? "")
        const sel = sb.parseFailed
            ? { winner: undefined }
            : selectArenaWinner(task.survivingCandidates, sb, task.scoreDirection, task.winnerMetric)
        if (sb.parseFailed || !sel.winner) {
            // Parse failure or no eligible winner: consume a retry. Past the cap,
            // fail closed; otherwise delete the stale evaluator response
            // (required — stops a resume re-consuming it) and re-dispatch the same
            // prompt to the evaluator.
            task.evalAttempts = (task.evalAttempts ?? 0) + 1
            if (task.evalAttempts > task.maxEvalRetries) {
                await finishRun(ctx, team, "arena_failed:eval_invalid", "failed")
                return
            }
            delete task.responses[task.evaluatorMember]
            await dispatchToMember(
                ctx,
                member,
                buildArenaEvaluatorPrompt(task, team),
                member.worktreePath ?? ctx.directory,
                team,
            )
            await saveTeamState(team)
            return
        }
        // Success: record the deterministic winner + scoreboard, then deliver
        // directly. v1 has NO signoff gate (Must-NOT-Have).
        task.scoreboard = sb
        task.winner = sel.winner
        await finishRun(ctx, team, "arena_complete", "idle")
        return
    }

    // IMPLEMENT phase (or undefined): the barrier ignores the trigger member's
    // identity — it only inspects team-wide candidate status.
    await waitForBarrier(team, task.candidates, async () => {
        const erroredCandidates = task.candidates.filter(
            n => team.members.find(m => m.name === n)?.status === "errored",
        )
        const survivors = task.candidates.filter(n => !erroredCandidates.includes(n))
        // Ordered branching MUST match termination.ts (3b): zero survivors ->
        // no_survivors; else over tolerance -> member_error; else proceed.
        if (survivors.length === 0) {
            await finishRun(ctx, team, "arena_failed:no_survivors", "failed")
            return
        }
        if (erroredCandidates.length > (task.maxErroredMembers ?? 0)) {
            await finishRun(ctx, team, `arena_failed:member_error:${erroredCandidates[0]}`, "failed")
            return
        }
        // Errored candidates stay in task.candidates for audit but are excluded
        // from scoring: survivingCandidates is the eligible-to-win subset.
        task.survivingCandidates = survivors
        await startArenaEvaluation(ctx, team)
    })
}

/**
 * Per-mode summary builders for OCTeam orchestration results.
 *
 * Extracted from summary.ts — these are pure renderers that format an
 * ActiveTask's captured outputs into the text delivered to the leader.
 * buildSummary (summary.ts) dispatches to exactly one of these per run.
 */

import type { Team } from "../../state/store.js"
import { listAllTasks } from "../../state/tasks.js"
import { truncateOutput } from "../protocol/output.js"
import { formatWorkflowLedgerLines, formatWorkflowOutputSections } from "./ledger.js"
import type { ActiveTask, ArenaCandidateScore } from "../../core/types.js"

/**
 * Render a delegate run: task status lines plus each member's captured output.
 * Member outputs are essential for signoff reviewers — without them the summary
 * is only "- [completed] Task (@owner)" lines, giving the reviewer no code to
 * evaluate. Mirrors the responses-inclusion pattern used by summarizePipeline.
 */
export async function summarizeDelegate(team: Team, task: ActiveTask, head: string): Promise<string> {
    const tasks = await listAllTasks(team.directory)
    const lines = tasks.map(
        t => `- [${t.status}] ${t.subject}${t.owner ? ` (@${t.owner})` : ""}`,
    )
    const outputs = Object.entries(task.responses)
        .filter(([, out]) => out.trim().length > 0)
        .map(([name, out]) => `by ${name}:\n${truncateOutput(out)}`)
        .join("\n\n")
    return outputs
        ? `${head}\n${lines.join("\n")}\n\n${outputs}`
        : `${head}\n${lines.join("\n")}`
}

/** Render a loop run: decision history + per-member work outputs. */
export function summarizeLoop(task: ActiveTask, head: string): string {
    const history = task.decisionHistory ?? []
    const last = history.at(-1)
    const rounds = history.map(
        d => `  round ${d.round}: ${d.decision} — ${d.rationale}`,
    )
    const decisions = `${head} rounds=${task.currentRound ?? 0}\nfinal: ${last?.decision ?? "n/a"}\n${rounds.join("\n")}`
    // Include the actual member outputs (the work product), not just the
    // decision log — otherwise a finished loop delivers nothing usable.
    const outputs = Object.entries(task.responses)
        .map(([name, out]) => `### ${name}\n${truncateOutput(out)}`)
        .join("\n\n")
    return outputs ? `${decisions}\n\n${outputs}` : decisions
}

/** Render a route run: selected targets' outputs + router rationale. */
export function summarizeRoute(task: Extract<ActiveTask, { type: "route" }>, head: string): string {
    // Exclude the router's <route> decision JSON (noise); show only the
    // selected targets' outputs plus the router's rationale.
    const targets = task.routeTargets ?? []
    const outputs = targets
        .map(name => `\nby ${name}:\n\n${truncateOutput(task.responses[name] ?? "")}`)
        .join("\n\n")
    const rationale = task.routeDecisionRationale
        ? `\nRouter rationale: ${task.routeDecisionRationale}`
        : ""
    return `${head}${rationale}\n${outputs}`
}

/** Render an arbitrate run: binding ruling + debaters' positions. */
export function summarizeArbitrate(task: Extract<ActiveTask, { type: "arbitrate" }>, head: string): string {
    // Lead with the arbiter's binding ruling; follow with the debaters'
    // final positions. The arbiter's raw <ruling> JSON is excluded.
    const positions = (task.disputants ?? [])
        .map(name => `by ${name}:\n${truncateOutput(task.responses[name] ?? "")}`)
        .join("\n\n")
    const ruling = task.arbitrationRuling
        ? `Ruling: ${task.arbitrationRuling}`
        : "Ruling: (none)"
    const rationale = task.arbitrationRationale
        ? `\nRationale: ${task.arbitrationRationale}`
        : ""
    return `${head}\n${ruling}${rationale}\n\n${positions}`
}

/** Render a recurse run: root task result + depth-indented decomposition tree. */
export async function summarizeRecurse(team: Team, task: Extract<ActiveTask, { type: "recurse" }>, head: string): Promise<string> {
    // Lead with the root task's result (the final deliverable); follow
    // with the decomposition tree (depth-indented subject/status).
    const tasks = await listAllTasks(team.directory)
    const root = tasks.find(t => t.id === task.rootTaskId)
    const rootResult = root?.result ?? "(no result)"
    const tree = tasks
        .slice()
        .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))
        .map(t => `${"  ".repeat(t.depth ?? 0)}- [${t.status}] ${t.subject}`)
        .join("\n")
    return `${head}\nRoot result:\n${truncateOutput(rootResult)}\n\nTask tree:\n${tree}`
}

/** Render a tollgate run: per-gate verdict table + completed gates' outputs. */
export function summarizeTollgate(task: Extract<ActiveTask, { type: "tollgate" }>, head: string): string {
    // One line per gate: its verdict (or pending), producer, verifier,
    // and FAIL-retry count. Follow with each completed gate's output.
    const stages = task.gatedStages ?? []
    const rows = stages.map((s, i) =>
        `${i}. [${s.verdict ?? "pending"}] ${s.member} -> verified by ${s.verifier}`
        + (s.attempts > 0 ? ` (${s.attempts} retries)` : ""))
    const outputs = stages
        .filter(s => s.completed)
        .map(s => `by ${s.member}:\n${truncateOutput(task.responses[s.member] ?? "")}`)
        .join("\n\n")
    return outputs
        ? `${head}\nGates:\n${rows.join("\n")}\n\n${outputs}`
        : `${head}\nGates:\n${rows.join("\n")}`
}

/** Render a pipeline run: concatenated stage outputs in order. */
export function summarizePipeline(task: ActiveTask, head: string): string {
    // Concatenate stage outputs in order.
    const candidates = Object.entries(task.responses)
        .map(([name, out]) => `by ${name}:\n${truncateOutput(out)}`)
        .join("\n\n")
    return `${head}\n${candidates}`
}

/**
 * Render a workflow run: 1-based per-step ledger plus task-step outputs (each
 * labeled by step number + member, so a member running multiple task steps
 * does not produce duplicate ### member headers with the wrong output).
 */
export function summarizeWorkflow(task: Extract<ActiveTask, { type: "workflow" }>, head: string): string {
    const steps = task.steps ?? []
    const rows = formatWorkflowLedgerLines(steps)
    const outputs = formatWorkflowOutputSections(steps).join("\n\n")
    const ledger = rows.length > 0 ? `\nSteps:\n${rows.join("\n")}` : ""
    return outputs ? `${head}${ledger}\n\n${outputs}` : `${head}${ledger}`
}

/** Render a consensus run: concatenated member outputs. */
export function summarizeConsensus(task: ActiveTask, head: string): string {
    // Consensus has no reducePolicy; concatenate member outputs
    // (the same summarize behavior the old default branch produced).
    const candidates = Object.entries(task.responses)
        .map(([name, out]) => `by ${name}:\n${truncateOutput(out)}`)
        .join("\n\n")
    return `${head}\n${candidates}`
}

/**
 * Render a parallel run. If the reducer produced a combined result, deliver it
 * verbatim; otherwise concatenate candidates and switch on reducePolicy to
 * add policy-specific instructions (summarize / select / merge / rubric).
 */
export function summarizeParallel(task: ActiveTask, head: string): string {
    // Once the reducer member has produced a combined result, deliver it
    // verbatim instead of the [Reduce policy:X] header. (Gated on
    // reducedResult presence, NOT the reason, so reduce_policy tests that
    // exercise the header path stay green.)
    if (task.reducedResult !== undefined) {
        return `${head}\n${task.reducedResult}`
    }
    const outputs = Object.entries(task.responses)
    const candidates = outputs
        .map(([name, out]) => `by ${name}:\n${truncateOutput(out)}`)
        .join("\n\n")

    // parallel: switch on reducePolicy
    const policy = task.reducePolicy ?? "summarize"
    switch (policy) {
        case "summarize":
            return `${head}\n\n${candidates}`
        case "select": {
            // reduceSelect (method-neutral) makes "best" explicit so the
            // reducer does not default to its own prior task assignment as
            // the judging standard. The anti-bias line is always present
            // because the reducer is often also a contestant.
            const criteria = task.reduceSelect ?? "the best overall answer"
            return (
                `${head}\n\n`
                + `[Reduce policy: SELECT]\n`
                + `Selection criteria: ${criteria}\n`
                + `The following ${outputs.length} candidates were produced. `
                + `Select the single best candidate per the criteria above. `
                + `Judge ONLY against the stated criteria — do NOT favor a `
                + `candidate because it matches your own method or assignment. `
                + `State your choice and reasoning.\n\n`
                + candidates
            )
        }
        case "merge":
            return (
                `${head}\n\n`
                + `[Reduce policy: MERGE]\n`
                + `The following ${outputs.length} solutions were produced. `
                + `Merge them into a single best solution, resolving conflicts. `
                + `Cite which candidate contributed each part.\n\n`
                + candidates
            )
        case "rubric": {
            const rubric = task.reduceRubric ?? "correctness (40%), clarity (30%), completeness (30%)"
            return (
                `${head}\n\n`
                + `[Reduce policy: RUBRIC]\n`
                + `Rubric: ${rubric}\n`
                + `Score each candidate on the rubric, then select the top-scoring one.\n\n`
                + candidates
            )
        }
        default: {
            // Exhaustiveness guard: if ReducePolicy gains a new variant,
            // this assignment fails to compile, forcing a case here.
            // Runtime fallback (defensive — an unknown value should not
            // reach here) mirrors summarize so the summary text is never
            // the literal string "undefined".
            const _exhaustive: never = policy
            void _exhaustive
            return `${head}\n${candidates}`
        }
    }
}

/** Render an arena run: winner line + evaluator scoreboard + audit note. */
export function summarizeArena(task: Extract<ActiveTask, { type: "arena" }>, head: string): string {
    // Lead with the winner line (name + selection basis), then the
    // evaluator-attested scoreboard sorted by the winner metric, then a
    // candidates/evaluator audit note. A failed run (no winner / no
    // scoreboard) renders a no-winner line without throwing.
    const basis = `${task.scoreDirection} ${task.winnerMetric}`
    const winnerLine = task.winner
        ? `Arena winner: ${task.winner} (${basis})`
        : `Arena winner: no winner selected (${basis})`
    const metricValue = (s: ArenaCandidateScore): number | undefined =>
        task.winnerMetric === "score" ? s.score : s.metrics?.[task.winnerMetric]
    const rows = [...(task.scoreboard?.scores ?? [])]
        .sort((a, b) => {
            const av = metricValue(a)
            const bv = metricValue(b)
            if (av === undefined && bv === undefined) return 0
            if (av === undefined) return 1
            if (bv === undefined) return -1
            return task.scoreDirection === "max" ? bv - av : av - bv
        })
        .map(s => {
            const val = metricValue(s)
            const rationale = s.rationale ? ` — ${s.rationale}` : ""
            return `- ${s.member}: ${task.winnerMetric}=${val ?? "n/a"} passed=${s.passed ?? false}${rationale}`
        })
    const table = rows.length > 0 ? `\nScoreboard:\n${rows.join("\n")}` : ""
    const note = `\nCandidates: ${task.candidates.join(", ")} | evaluator: ${task.evaluatorMember}`
    return `${head}\n${winnerLine}${table}${note}`
}

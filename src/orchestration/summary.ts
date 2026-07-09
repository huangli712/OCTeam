/**
 * Result summary construction and leader delivery.
 *
 * The leader session is always notified via promptAsync when a workflow
 * completes — the summary is pushed immediately regardless of the leader's
 * current session state. The host queues the promptAsync if the leader is
 * mid-turn and drives a new turn when the leader becomes available.
 *
 * Detailed per-member results that were sent to the master mailbox during the
 * workflow (e.g. via team_send_message in delegate/consensus modes) are
 * drained separately by deliverQueuedResultsToMaster on the master's idle
 * event.
 */

import type { PluginContext } from "../core/context.js"
import { type Team, clearActiveTask } from "../state/store.js"
import { formatMailboxInjection, pollMailbox, ackMessages } from "../messaging/mailbox.js"
import { listAllTasks } from "../state/tasks.js"
import { truncateOutput } from "../core/utils.js"
import { logSwallowed } from "../core/log.js"
import { persistRun } from "./runs.js"
import { recordEvent } from "./events.js"
import type { ActiveTask, ArenaCandidateScore, WorkflowStep } from "../core/types.js"

/**
 * Deliver the workflow summary to the leader. Always pushes via promptAsync
 * so the host wakes the leader (immediately if idle, or queued if mid-turn).
 */
export async function deliverSummaryToLeader(
    ctx: PluginContext,
    team: Team,
    reason: string,
): Promise<void> {
    if (!team.activeTask) return
    const summary = await buildSummary(team, team.activeTask, reason)

    // Timeline (#5): emit the terminated event while runId is still on the task
    // (finishRun at most call sites calls clearActiveTask right after this).
    recordEvent(team, { timestamp: Date.now(), kind: "terminated", reason })

    // Persist the run record (#2) BEFORE clearing/delivering. Best-effort: a
    // persistence failure must never block leader delivery. Runs under the
    // team mutex (every call site holds it), so the runId dir has one writer.
    await persistRun(team, reason).catch(err =>
        logSwallowed(ctx, "persist run record failed", err, { team: team.teamName, reason }),
    )

    await ctx.client.session.promptAsync({
        path: { id: team.leadSessionId },
        body: {
            parts: [
                {
                    type: "text",
                    text: `<team_result team="${team.teamName}">\n${summary}\n</team_result>`,
                    synthetic: true,
                },
            ],
        },
    })
}

/**
 * Deliver the run summary, clear the active task, and set the team status.
 * Consolidates the teardown triplet (deliver -> clear -> status) that was
 * copy-pasted across the orchestration primitives. Sites with intervening
 * work between deliver and clear (e.g. loop's decisionHistory.push) call the
 * individual operations directly.
 */
export async function finishRun(
    ctx: PluginContext,
    team: Team,
    reason: string,
    status: "idle" | "failed",
): Promise<void> {
    await deliverSummaryToLeader(ctx, team, reason)
    clearActiveTask(team)
    team.status = status
}

/**
 * Drain the master mailbox and deliver queued team results when the master goes
 * idle. Called from the event handler's master special-case branch.
 * Uses the same formatter as the Transform hook so the user sees consistent
 * formatting regardless of which drain path delivered the result.
 */
export async function deliverQueuedResultsToMaster(
    ctx: PluginContext,
    team: Team,
    masterSessionId: string,
): Promise<void> {
    const queued = await pollMailbox(team.directory, "master")
    if (queued.length === 0) return

    // Security: filter forged master self-impersonation directives. The master
    // mailbox is writable by any member agent with .octeam/ FS access (see
    // mailbox.ts TRUST BOUNDARY header). Without this filter, a forged line
    // {from:"master", kind:"directive", ...} would be rendered as [DIRECTIVE]
    // into the master's own session, weaponizing the master LLM via forged
    // self-directives. The master never legitimately sends directives to
    // itself, so strip both kind=directive and from=master entries on this
    // drain path. (Forge into other members' mailboxes remains a documented
    // accepted limitation — see mailbox.ts header.)
    const safe = queued.filter(m => m.kind !== "directive" && m.from !== "master")

    let delivered = true
    if (safe.length > 0) {
        await ctx.client.session.promptAsync({
            path: { id: masterSessionId },
            body: {
                parts: [{ type: "text", text: formatMailboxInjection(safe), synthetic: true }],
            },
        }).catch(err => {
            delivered = false
            logSwallowed(ctx, "deliver queued results to master failed", err, { team: team.teamName })
        })
    }
    // ACK all queued (including filtered forged entries) on successful delivery
    // so forged messages are permanently dropped rather than re-delivered by
    // releaseStaleReservations in a 30s TTL loop. On failure, leave all reserved
    // so releaseStaleReservations re-delivers legitimate team results after TTL
    // — otherwise a transient master-session error silently drops them.
    if (delivered) {
        await ackMessages(team.directory, "master", queued)
    }
}

/**
 * Mode-aware summary. delegate aggregates from the task list (per-task results
 * were already delivered to master via team_send_message; responses[] is NOT
 * used for delegate). loop uses decisionHistory (structured) rather than
 * the overwritten responses[]. parallel/pipeline concatenate captured outputs.
 *
 * Per-mode formatting lives in the summarize* helpers below; this function is
 * a thin dispatcher with an exhaustiveness guard on OrchestrationType.
 */
export async function buildSummary(
    team: Team,
    task: ActiveTask,
    reason: string,
): Promise<string> {
    const head = `mode=${task.type} reason=${reason} tokens=${task.tokensUsed}`
    switch (task.type) {
        case "delegate": return await summarizeDelegate(team, head)
        case "loop": return summarizeLoop(task, head)
        case "route": return summarizeRoute(task, head)
        case "arbitrate": return summarizeArbitrate(task, head)
        case "recurse": return await summarizeRecurse(team, task, head)
        case "tollgate": return summarizeTollgate(task, head)
        case "pipeline": return summarizePipeline(task, head)
        case "consensus": return summarizeConsensus(task, head)
        case "parallel": return summarizeParallel(task, head)
        case "workflow": return summarizeWorkflow(task, head)
        case "arena": return summarizeArena(task, head)
        default: {
            // Exhaustiveness guard for OrchestrationType. Every variant has an
            // explicit case above, so task narrows to `never` here. Adding a new
            // OrchestrationType without a matching case fails this assignment at
            // compile time. Runtime throw prevents silent fall-through.
            const _exhaustive: never = task
            void _exhaustive
            throw new Error(`buildSummary: unhandled OrchestrationType: ${String((task as { type: string }).type)}`)
        }
    }
}

// --- per-mode summary builders (extracted from buildSummary) ---

async function summarizeDelegate(team: Team, head: string): Promise<string> {
    const tasks = await listAllTasks(team.directory)
    const lines = tasks.map(
        t => `- [${t.status}] ${t.subject}${t.owner ? ` (@${t.owner})` : ""}`,
    )
    return `${head}\n${lines.join("\n")}`
}

function summarizeLoop(task: ActiveTask, head: string): string {
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

function summarizeRoute(task: Extract<ActiveTask, { type: "route" }>, head: string): string {
    // Exclude the router's <route> decision JSON (noise); show only the
    // selected targets' outputs plus the router's rationale.
    const targets = task.routeTargets ?? []
    const outputs = targets
        .map(name => `### ${name}\n${truncateOutput(task.responses[name] ?? "")}`)
        .join("\n\n")
    const rationale = task.routeDecisionRationale
        ? `\nRouter rationale: ${task.routeDecisionRationale}`
        : ""
    return `${head}${rationale}\n${outputs}`
}

function summarizeArbitrate(task: Extract<ActiveTask, { type: "arbitrate" }>, head: string): string {
    // Lead with the arbiter's binding ruling; follow with the debaters'
    // final positions. The arbiter's raw <ruling> JSON is excluded.
    const positions = (task.disputants ?? [])
        .map(name => `### ${name}\n${truncateOutput(task.responses[name] ?? "")}`)
        .join("\n\n")
    const ruling = task.arbitrationRuling
        ? `Ruling: ${task.arbitrationRuling}`
        : "Ruling: (none)"
    const rationale = task.arbitrationRationale
        ? `\nRationale: ${task.arbitrationRationale}`
        : ""
    return `${head}\n${ruling}${rationale}\n\n${positions}`
}

async function summarizeRecurse(team: Team, task: Extract<ActiveTask, { type: "recurse" }>, head: string): Promise<string> {
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

function summarizeTollgate(task: Extract<ActiveTask, { type: "tollgate" }>, head: string): string {
    // One line per gate: its verdict (or pending), producer, verifier,
    // and FAIL-retry count. Follow with each completed gate's output.
    const stages = task.gatedStages ?? []
    const rows = stages.map((s, i) =>
        `${i}. [${s.verdict ?? "pending"}] ${s.member} -> verified by ${s.verifier}`
        + (s.attempts > 0 ? ` (${s.attempts} retries)` : ""))
    const outputs = stages
        .filter(s => s.completed)
        .map(s => `### ${s.member}\n${truncateOutput(task.responses[s.member] ?? "")}`)
        .join("\n\n")
    return outputs
        ? `${head}\nGates:\n${rows.join("\n")}\n\n${outputs}`
        : `${head}\nGates:\n${rows.join("\n")}`
}

function summarizePipeline(task: ActiveTask, head: string): string {
    // Concatenate stage outputs in order.
    const candidates = Object.entries(task.responses)
        .map(([name, out]) => `### ${name}\n${truncateOutput(out)}`)
        .join("\n\n")
    return `${head}\n${candidates}`
}

// Renders a 1-based per-step ledger plus the task-step outputs (each labeled
// by step number + member, so a member running multiple task steps does not
// produce duplicate ### member headers with the wrong output).
function workflowTargetLabel(s: WorkflowStep): string {
    if (s.targetStepIndices !== undefined && s.targetStepIndices.length > 0) {
        const targets = s.targetStepIndices.map(index => index + 1)
        return targets.length === 1 ? `step ${targets[0]}` : `steps ${targets.join(", ")}`
    }
    return s.targetStepIndex === undefined ? "nearest task" : `step ${s.targetStepIndex + 1}`
}

function workflowVerdictMetrics(s: WorkflowStep): string {
    const metrics: string[] = []
    if (s.score !== undefined) metrics.push(`score=${s.score}`)
    if (s.confidence !== undefined) metrics.push(`confidence=${s.confidence}`)
    if (s.issues !== undefined && s.issues.length > 0) metrics.push(`issues=${s.issues.length}`)
    return metrics.length > 0 ? ` [${metrics.join(", ")}]` : ""
}

/** Per-issue detail lines for a gate step with structured verdict. Severity-sorted
 * (critical > high > medium > low) so the most actionable issues surface first. */
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

function assertNeverWorkflowStepKind(kind: never): never {
    throw new Error(`unhandled WorkflowStepKind: ${String(kind)}`)
}

function formatWorkflowIssueDetail(s: WorkflowStep): string {
    const issues = s.issues
    if (!issues || issues.length === 0) return ""
    const sorted = [...issues].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99))
    const lines = sorted.map(issue => {
        const msg = issue.message && issue.message.trim() !== "" ? `: ${issue.message}` : ""
        return `    - [${issue.severity}]${msg}`
    })
    return "\n" + lines.join("\n")
}

function workflowBranchStatus(steps: readonly WorkflowStep[], fanoutStep: WorkflowStep, branchId: string, branchIndex: number): string {
    const fanout = fanoutStep.fanout
    if (fanout === undefined) throw new Error("workflow fanout step missing fanout metadata")
    const range = fanout.branchRanges[branchIndex]
    if (range === undefined) throw new Error(`workflow fanout missing branch range ${branchIndex}`)
    const join = steps[fanout.joinIndex]?.join
    if (join?.erroredBranchIds?.includes(branchId) === true) return "errored"
    if (join?.survivorBranchIds?.includes(branchId) === true) return "completed"
    const tail = steps[range.endIndex]
    if (tail?.skipped === true) return "skipped"
    return tail?.completed === true ? "completed" : "pending"
}

function workflowBranchStatusList(steps: readonly WorkflowStep[], fanoutStep: WorkflowStep): string {
    const fanout = fanoutStep.fanout
    if (fanout === undefined) throw new Error("workflow fanout step missing fanout metadata")
    return fanout.branchIds
        .map((branchId, branchIndex) => `${branchId}:${workflowBranchStatus(steps, fanoutStep, branchId, branchIndex)}`)
        .join(", ")
}

function formatWorkflowBranchLine(steps: readonly WorkflowStep[], fanoutStep: WorkflowStep, branchId: string, branchIndex: number): string {
    const fanout = fanoutStep.fanout
    if (fanout === undefined) throw new Error("workflow fanout step missing fanout metadata")
    const range = fanout.branchRanges[branchIndex]
    if (range === undefined) throw new Error(`workflow fanout missing branch range ${branchIndex}`)
    const status = workflowBranchStatus(steps, fanoutStep, branchId, branchIndex)
    return `  - Branch ${branchId} [${status}] steps ${range.startIndex + 1}-${range.endIndex + 1}`
}

function formatWorkflowLedgerStep(steps: readonly WorkflowStep[], step: WorkflowStep, index: number): string {
    const idTag = step.id ? ` (${step.id})` : ""
    switch (step.kind) {
        case "task": {
            const state = step.skipped ? " (skipped)" : step.completed ? " (done)" : ""
            return `${index + 1}. [task]${idTag} ${step.member ?? "?"}${state}`
        }
        case "gate": {
            const target = workflowTargetLabel(step)
            const invalidTag = step.onInvalid && step.onInvalid !== "fail" ? `, on_invalid=${step.onInvalid}${(step.invalidAttempts ?? 0) > 0 ? ` (${step.invalidAttempts})` : ""}` : ""
            const jumpTag = (step.jumpCount ?? 0) > 0 ? `, jumps=${step.jumpCount}` : ""
            return `${index + 1}. [gate]${idTag} ${step.verifier ?? "?"} verifies ${target} -> ${step.verdict ?? "pending"}${workflowVerdictMetrics(step)}${(step.attempts ?? 0) > 0 ? ` (${step.attempts} retries)` : ""}${invalidTag}${jumpTag}${formatWorkflowIssueDetail(step)}`
        }
        case "fanout": {
            const fanout = step.fanout
            if (fanout === undefined) throw new Error(`workflow fanout step ${index + 1} missing fanout metadata`)
            const branchList = fanout.branchIds.length > 0 ? fanout.branchIds.join(", ") : "(none)"
            return `${index + 1}. [fanout]${idTag} branches ${branchList} -> join step ${fanout.joinIndex + 1}`
        }
        case "join": {
            const join = step.join
            if (join === undefined) throw new Error(`workflow join step ${index + 1} missing join metadata`)
            const fanoutStep = steps[join.fanoutIndex]
            const statuses = fanoutStep?.kind === "fanout" ? workflowBranchStatusList(steps, fanoutStep) : ""
            const statusTag = statuses === "" ? "" : ` branches ${statuses}`
            const joinedBytes = join.joinedOutput === undefined ? "" : ` (joined ${Buffer.byteLength(join.joinedOutput, "utf8")} bytes)`
            return `${index + 1}. [join]${idTag} fanout step ${join.fanoutIndex + 1}${statusTag}${joinedBytes}`
        }
        default:
            return assertNeverWorkflowStepKind(step.kind)
    }
}

function hasWorkflowBranchTree(steps: readonly WorkflowStep[]): boolean {
    return steps.some(step => step.kind === "fanout" || step.kind === "join" || step.branch !== undefined)
}

function formatWorkflowLedgerLines(steps: readonly WorkflowStep[]): string[] {
    if (!hasWorkflowBranchTree(steps)) return steps.map((step, index) => formatWorkflowLedgerStep(steps, step, index))

    const lines: string[] = []
    const rendered = new Set<number>()
    for (let index = 0; index < steps.length; index += 1) {
        if (rendered.has(index)) continue
        const step = steps[index]
        if (step === undefined) continue
        switch (step.kind) {
            case "fanout": {
                lines.push(formatWorkflowLedgerStep(steps, step, index))
                const fanout = step.fanout
                if (fanout === undefined) throw new Error(`workflow fanout step ${index + 1} missing fanout metadata`)
                for (let branchIndex = 0; branchIndex < fanout.branchIds.length; branchIndex += 1) {
                    const branchId = fanout.branchIds[branchIndex]
                    const range = fanout.branchRanges[branchIndex]
                    if (branchId === undefined || range === undefined) continue
                    lines.push(formatWorkflowBranchLine(steps, step, branchId, branchIndex))
                    for (let branchStepIndex = range.startIndex; branchStepIndex <= range.endIndex; branchStepIndex += 1) {
                        const branchStep = steps[branchStepIndex]
                        if (branchStep === undefined) continue
                        lines.push(`    ${formatWorkflowLedgerStep(steps, branchStep, branchStepIndex)}`)
                        rendered.add(branchStepIndex)
                    }
                }
                break
            }
            case "task":
            case "gate":
            case "join":
                lines.push(formatWorkflowLedgerStep(steps, step, index))
                break
            default:
                assertNeverWorkflowStepKind(step.kind)
        }
    }
    return lines
}

function formatWorkflowTaskOutput(step: WorkflowStep, index: number, headingLevel: "###" | "####"): string | null {
    if (step.kind !== "task" || !step.completed) return null
    return `${headingLevel} Step ${index + 1} - ${step.member ?? "?"}\n${truncateOutput(step.output ?? "")}`
}

function formatWorkflowOutputSections(steps: readonly WorkflowStep[]): string[] {
    if (!hasWorkflowBranchTree(steps)) {
        return steps
            .map((step, index) => formatWorkflowTaskOutput(step, index, "###"))
            .filter((x): x is string => x !== null)
    }

    const sections: string[] = []
    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]
        if (step === undefined) continue
        switch (step.kind) {
            case "task": {
                if (step.branch !== undefined) break
                const output = formatWorkflowTaskOutput(step, index, "###")
                if (output !== null) sections.push(output)
                break
            }
            case "fanout": {
                const fanout = step.fanout
                if (fanout === undefined) throw new Error(`workflow fanout step ${index + 1} missing fanout metadata`)
                for (let branchIndex = 0; branchIndex < fanout.branchIds.length; branchIndex += 1) {
                    const branchId = fanout.branchIds[branchIndex]
                    const range = fanout.branchRanges[branchIndex]
                    if (branchId === undefined || range === undefined) continue
                    const outputs: string[] = []
                    for (let branchStepIndex = range.startIndex; branchStepIndex <= range.endIndex; branchStepIndex += 1) {
                        const branchStep = steps[branchStepIndex]
                        if (branchStep === undefined) continue
                        const output = formatWorkflowTaskOutput(branchStep, branchStepIndex, "####")
                        if (output !== null) outputs.push(output)
                    }
                    if (outputs.length > 0) {
                        const status = workflowBranchStatus(steps, step, branchId, branchIndex)
                        sections.push(`### Fanout Step ${index + 1} Branch ${branchId} [${status}]\n${outputs.join("\n\n")}`)
                    }
                }
                break
            }
            case "join": {
                const joinedOutput = step.join?.joinedOutput
                if (joinedOutput !== undefined) sections.push(`### Join Step ${index + 1}\n${truncateOutput(joinedOutput)}`)
                break
            }
            case "gate":
                break
            default:
                assertNeverWorkflowStepKind(step.kind)
        }
    }
    return sections
}

function summarizeWorkflow(task: Extract<ActiveTask, { type: "workflow" }>, head: string): string {
    const steps = task.steps ?? []
    const rows = formatWorkflowLedgerLines(steps)
    const outputs = formatWorkflowOutputSections(steps).join("\n\n")
    const ledger = rows.length > 0 ? `\nSteps:\n${rows.join("\n")}` : ""
    return outputs ? `${head}${ledger}\n\n${outputs}` : `${head}${ledger}`
}

function summarizeConsensus(task: ActiveTask, head: string): string {
    // Consensus has no reducePolicy; concatenate member outputs
    // (the same summarize behavior the old default branch produced).
    const candidates = Object.entries(task.responses)
        .map(([name, out]) => `### ${name}\n${truncateOutput(out)}`)
        .join("\n\n")
    return `${head}\n${candidates}`
}

function summarizeParallel(task: ActiveTask, head: string): string {
    // #4 real reduce: once the reducer member has produced a combined
    // result, deliver it verbatim instead of the [Reduce policy:X] header.
    // (Gated on reducedResult presence, NOT the reason, so reduce_policy
    // tests that exercise the header path stay green.)
    if (task.reducedResult !== undefined) {
        return `${head}\n${task.reducedResult}`
    }
    const outputs = Object.entries(task.responses)
    const candidates = outputs
        .map(([name, out]) => `### ${name}\n${truncateOutput(out)}`)
        .join("\n\n")

    // parallel: switch on reducePolicy
    const policy = task.reducePolicy ?? "summarize"
    switch (policy) {
        case "summarize":
            return `${head}\n${candidates}`
        case "select": {
            // reduceSelect (method-neutral) makes "best" explicit so the
            // reducer does not default to its own prior task assignment as
            // the judging standard. The anti-bias line is always present
            // because the reducer is often also a contestant.
            const criteria = task.reduceSelect ?? "the best overall answer"
            return (
                `${head}\n`
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
                `${head}\n`
                + `[Reduce policy: MERGE]\n`
                + `The following ${outputs.length} solutions were produced. `
                + `Merge them into a single best solution, resolving conflicts. `
                + `Cite which candidate contributed each part.\n\n`
                + candidates
            )
        case "rubric": {
            const rubric = task.reduceRubric ?? "correctness (40%), clarity (30%), completeness (30%)"
            return (
                `${head}\n`
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

function summarizeArena(task: Extract<ActiveTask, { type: "arena" }>, head: string): string {
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

/** One-line-per-member digest of the current round's outputs (consensus). */
export function buildRoundSummary(responses: Record<string, string>): string {
    return Object.entries(responses)
        .map(([name, out]) => `- ${name}: ${truncateOutput(out, 500)}`)
        .join("\n")
}

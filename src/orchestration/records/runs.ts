/**
 * Persistent per-orchestration run records.
 *
 * Full member outputs are written to runs/<runId>/<member>.md at CAPTURE time
 * (idle.ts Step 6). This module writes the run's record.json — a JSON
 * index of metadata + references to those output files — at TERMINATION time,
 * via persistRun, which is called from deliverSummaryToLeader (the single seam
 * that every real termination funnels through). Retention is enforced here
 * (keep the most recent DEFAULT_MAX_RUNS).
 *
 * All writes use atomicWrite (parent-dir auto-created) and run under team.mutex
 * (every deliverSummaryToLeader call site holds it), so no extra locking is
 * needed — each runId directory has a single writer.
 */

import crypto from "node:crypto"
import fs from "node:fs/promises"

import { logger } from "../../core/log.js"
import { isEnoent } from "../../core/utils.js"

import type { WorkflowJoinMetadata } from "../../core/types.js"
import type { Team } from "../../state/store.js"
import type { RunRecord, RunStatus, WorkflowBranchStatus, WorkflowRunStep, WorkflowStep } from "../../core/types.js"
import { assertNoSymlinkTraversal, atomicWrite } from "../../state/locks.js"
import { runsDir, runDir, runRecordPath, runEventsPath } from "../../state/paths.js"
import type { RunEvent } from "../../core/types.js"
import { listAllTasks } from "../../state/tasks.js"
import { RunRecordSchema, RunEventSchema } from "./schemas.js"

/** Keep at most this many run records per team; older ones are pruned. */
export const DEFAULT_MAX_RUNS = 20

/**
 * Reason substrings that indicate a FAILED run. Everything else is "completed".
 *
 * IMPORTANT: when a new termination reason is added at any deliverSummaryToLeader
 * call site, classify it here if it represents a failure.
 */
const FAILED_REASON_MARKERS = [
    "timeout",
    "budget_exceeded",
    "member_turn_limit",
    "member_error",
    "max_rounds",          // consensus_max_rounds, loop_complete:max_rounds
    "deadlock",            // delegate_deadlock
    "decision_parse_failure",
    "interrupted",         // crash-reconcile of an interrupted run (hooks.ts)
    "arbiter_unavailable", // arbitrate: arbiter has no live session at ruling time
    "tollgate_failed",     // tollgate: a gate's FAIL retries (maxGateRetries) exhausted
    "tollgate_invalid",    // tollgate: verifier/oracle unevaluable, no escalation handler
    "workflow_failed",     // workflow: a gate FAIL (onFail='fail' or retries exhausted) or unparseable verdict
    "workflow_invalid",    // workflow: verifier could not evaluate the target task output
    "pipeline_failed",    // pipeline: a stage's member has no live session (explicit failure instead of stalling)
    "parallel_failed",    // parallel: reducer member missing on resume of a reduce stage
    "signoff_rejected",           // signoff: decider/reviewer rejected the work
    "signoff_quorum_not_reached", // signoff: peer-quorum did not get enough approvals
    "human_rejected",             // HITL: leader rejected a mid-run approval request
    "arena_failed",               // arena: every arena_failed:* reason (no_survivors, member_error, evaluator_*, eval_invalid); arena_complete matches no marker and stays completed
    "quorum_no_majority",         // quorum: tally complete but no option reached strict majority
    "quorum_all_errored",         // quorum: all participants abstained (unreachable via runtime errors alone; only via all-invalid-ballot path)
] as const

/**
 * Derive run status from the verbatim termination reason (heuristic fallback).
 *
 * Prefer passing an explicit `status` to persistRun when the caller already
 * knows it (every finishRun call site does). This heuristic is kept as a
 * fallback for any direct deliverSummaryToLeader caller that does not thread
 * status, and for backward compatibility with persisted records from older
 * builds.
 */
export function runStatusFromReason(reason: string): RunStatus {
    return FAILED_REASON_MARKERS.some(m => reason.includes(m)) ? "failed" : "completed"
}

/**
 * Parse + validate a RunRecord. Throws on corrupt JSON OR schema mismatch so the
 * caller's existing try/catch preserves its skip/null semantics unchanged.
 */
function parseRunRecord(raw: string): RunRecord {
    const result = RunRecordSchema.safeParse(JSON.parse(raw))
    if (!result.success) throw new Error(`invalid RunRecord: ${result.error.message}`)
    return result.data
}

/**
 * Parse + validate a RunEvent line. Throws on corrupt JSON OR schema mismatch so
 * the caller's existing try/catch preserves its skip semantics unchanged.
 */
function parseRunEvent(line: string): RunEvent {
    const result = RunEventSchema.safeParse(JSON.parse(line))
    if (!result.success) throw new Error(`invalid RunEvent: ${result.error.message}`)
    return result.data
}

/** Project a runtime join metadata object into the persisted (RunRecord) shape. */
function runJoinMetadata(join: WorkflowJoinMetadata | undefined): WorkflowRunStep["join"] {
    if (join === undefined) return undefined
    return {
        fanoutIndex: join.fanoutIndex,
        branchTailIndices: join.branchTailIndices,
        maxErrored: join.maxErrored,
        ...(join.joinPolicy === undefined ? {} : { joinPolicy: join.joinPolicy }),
        ...(join.quorum === undefined ? {} : { quorum: join.quorum }),
        ...(join.requiredBranchIds === undefined ? {} : { requiredBranchIds: join.requiredBranchIds }),
        ...(join.reducerMember === undefined ? {} : { reducerMember: join.reducerMember }),
        ...(join.useSurvivors === undefined ? {} : { useSurvivors: join.useSurvivors }),
        ...(join.survivorBranchIds === undefined ? {} : { survivorBranchIds: join.survivorBranchIds }),
        ...(join.erroredBranchIds === undefined ? {} : { erroredBranchIds: join.erroredBranchIds }),
        ...(join.selectedBranchId === undefined ? {} : { selectedBranchId: join.selectedBranchId }),
        ...(join.selectionRationale === undefined ? {} : { selectionRationale: join.selectionRationale }),
    }
}

/**
 * Persist the active task as a run record. Called from deliverSummaryToLeader
 * BEFORE activeTask is cleared. No-op if there is no active task. Best-effort:
 * the caller wraps this so a persistence failure never blocks delivery.
 *
 * @param status Explicit run status from the caller. When provided, this is
 *               stored directly instead of deriving from `reason` via the
 *               substring heuristic (runStatusFromReason). Every finishRun call
 *               site already knows whether the run succeeded or failed.
 */
export async function persistRun(team: Team, reason: string, status?: RunStatus): Promise<void> {
    const task = team.activeTask
    if (!task) return

    // Lazy runId: capture sets it on first output; cover delegate (no capture)
    // and legacy in-flight tasks loaded without a runId.
    const runId = (task.runId ??= crypto.randomUUID())
    const dir = runDir(team.directory, runId)

    // Collect the full-output files staged at capture time (<member>.md).
    const memberOutputs: RunRecord["memberOutputs"] = {}
    let entries: string[] = []
    try {
        entries = await fs.readdir(dir)
    } catch {
        // dir may not exist (e.g. a run with no member turns yet) — that's fine
    }
    for (const file of entries) {
        if (!file.endsWith(".md")) continue
        const member = file.slice(0, -3)
        try {
            const stat = await fs.stat(`${dir}/${file}`)
            memberOutputs[member] = { bytes: stat.size, file }
        } catch {
            // raced/removed — skip
        }
    }

    const record: RunRecord = {
        version: 1,
        runId,
        teamRunId: team.teamRunId,
        teamName: team.teamName,
        type: task.type,
        mode: task.mode,
        reason,
        status: status ?? (() => {
            logger.warn("persistRun: status not provided, falling back to reason substring heuristic", { reason })
            return runStatusFromReason(reason)
        })(),
        startedAt: task.startedAt,
        finishedAt: Date.now(),
        tokensUsed: task.tokensUsed,
        tokensByMember: task.tokensByMember,
        messagesSent: task.messagesSent,
        currentRound: task.currentRound,
        decisionHistory: task.type === "loop" ? task.decisionHistory : undefined,
        approvalHistory: task.approvalHistory,
        consensusReached: task.type === "consensus" ? task.consensusReached : undefined,
        signoffPolicy: task.signoffPolicy,
        signoffApprovals: task.signoffApprovals,
        memberOutputs,
    }

    if (task.type === "delegate") {
        const tasks = await listAllTasks(team.directory)
        record.tasks = tasks.map(t => ({
            id: t.id,
            subject: t.subject,
            status: t.status,
            owner: t.owner,
        }))
    }

    if (task.type === "workflow") {
        const steps = task.steps ?? []
        record.workflow = {
            steps: steps.map((step, index) => {
                const base = {
                    index,
                    step: index + 1,
                    kind: step.kind,
                    id: step.id,
                    dispatchedActor: step.dispatchedActor,
                    timeoutMs: step.timeoutMs,
                    onTimeout: step.onTimeout,
                    maxTimeoutRetries: step.maxTimeoutRetries,
                    skipped: step.skipped,
                    completed: step.completed,
                    output: step.output,
                    outputBytes: step.output === undefined ? undefined : Buffer.byteLength(step.output, "utf8"),
                    startedAt: step.startedAt,
                    completedAt: step.completedAt,
                    durationMs: step.durationMs,
                    inputs: step.inputs,
                    exposeOutput: step.exposeOutput,
                    branch: step.branch,
                    branchStatuses: workflowBranchStatusesForStep(steps, index, step),
                    approvalBefore: step.approvalBefore,
                    approvalAfter: step.approvalAfter,
                    maxOutputBytes: step.maxOutputBytes,
                }
                switch (step.kind) {
                    case "task":
                        return { ...base, member: step.member }
                    case "gate":
                        return {
                            ...base,
                            verifier: step.verifier,
                            // M-27: persist ensemble gate fields so run records
                            // capture which verifiers ran and their policy.
                            verifiers: step.verifiers,
                            ensemblePolicy: step.ensemblePolicy,
                            ensembleQuorum: step.ensembleQuorum,
                            targetStep: step.targetStepIndex === undefined ? undefined : step.targetStepIndex + 1,
                            targetSteps: step.targetStepIndices?.map(i => i + 1),
                            verdict: step.verdict,
                            score: step.score,
                            confidence: step.confidence,
                            issues: step.issues,
                            attempts: step.attempts,
                            onInvalid: step.onInvalid,
                            invalidAttempts: step.invalidAttempts,
                            // M-27: persist malformed/timeout counters and
                            // policies so the run record reflects the full
                            // retry/escalation history.
                            onMalformed: step.onMalformed,
                            malformedAttempts: step.malformedAttempts,
                            maxMalformedRetries: step.maxMalformedRetries,
                            onTimeout: step.onTimeout,
                            timeoutAttempts: step.timeoutAttempts,
                            maxTimeoutRetries: step.maxTimeoutRetries,
                            onFail: step.onFail,
                            maxRetries: step.maxRetries,
                            maxInvalidRetries: step.maxInvalidRetries,
                            onPassGoto: step.onPassGoto === undefined || step.onPassGoto < 0 ? undefined : step.onPassGoto + 1,
                            onFailGoto: step.onFailGoto === undefined || step.onFailGoto < 0 ? undefined : step.onFailGoto + 1,
                            onInvalidGoto: step.onInvalidGoto === undefined || step.onInvalidGoto < 0 ? undefined : step.onInvalidGoto + 1,
                            maxJumps: step.maxJumps,
                            // M-27: persist `where` condition and `loop` config
                            // so the run record reflects the gate's jump
                            // conditions and backward-iteration setup.
                            where: step.where,
                            loop: step.loop,
                            criteria: step.criteria,
                            jumpCount: step.jumpCount,
                        }
                    case "fanout":
                        return { ...base, fanout: step.fanout }
                    case "join":
                        return {
                            ...base,
                            join: runJoinMetadata(step.join),
                            joinedOutputBytes: step.join.joinedOutput === undefined ? undefined : Buffer.byteLength(step.join.joinedOutput, "utf8"),
                        }
                }
            }),
        }
    }

    if (task.type === "arena") {
        record.arena = {
            candidates: task.candidates,
            survivingCandidates: task.survivingCandidates,
            evaluator: task.evaluatorMember,
            winner: task.winner,
            scoreDirection: task.scoreDirection,
            winnerMetric: task.winnerMetric,
            scoreboard: task.scoreboard,
        }
    }

    if (task.type === "quorum") {
        record.quorum = {
            task: task.task,
            voteKey: task.voteKey,
            voteOptions: task.voteOptions,
            participants: task.participants,
            ballots: task.ballots,
            erroredCount: task.erroredCount,
            nEff: task.nEff,
            threshold: task.threshold,
            winningOption: task.winningOption,
        }
    }

    await atomicWrite(runRecordPath(team.directory, runId), JSON.stringify(record, null, 2), team.directory)
    await pruneRuns(team.directory, DEFAULT_MAX_RUNS)
}


/**
 * Keep the most recent `keep` runs (by record.finishedAt), deleting older run
 * directories. Best-effort; a prune failure never blocks termination.
 */
export async function pruneRuns(teamDirectory: string, keep: number): Promise<void> {
    const root = runsDir(teamDirectory)
    // C-2: refuse to scan/remove through a symlinked runs/ — without this,
    // a symlinked <team>/runs could let pruneRuns issue rm -rf against an
    // attacker-controlled location outside the team root.
    await assertNoSymlinkTraversal(teamDirectory, root)
    let runIds: string[] = []
    try {
        runIds = await fs.readdir(root)
    } catch {
        return // no runs/ yet
    }

    const dated: Array<{ runId: string; finishedAt: number }> = []
    const orphaned: string[] = []
    const corrupted: string[] = []
    const records = await Promise.all(
        runIds.map(runId =>
            fs.readFile(runRecordPath(teamDirectory, runId), "utf8")
                .then(raw => {
                    try { return { kind: "ok" as const, rec: parseRunRecord(raw) } }
                    catch { return { kind: "corrupt" as const, rec: null } }
                })
                .catch(err => ({
                    kind: isEnoent(err) ? "missing" as const : "corrupt" as const,
                    rec: null,
                }))
                .then(result => ({ runId, ...result })),
        ),
    )
    for (const { runId, kind, rec } of records) {
        if (kind === "ok" && rec) dated.push({ runId, finishedAt: rec.finishedAt ?? 0 })
        else if (kind === "missing") orphaned.push(runId)
        else corrupted.push(runId)
    }
    // Remove orphaned run directories (no record.json at all = crash-during-capture).
    for (const runId of orphaned) {
        const target = runDir(teamDirectory, runId)
        await assertNoSymlinkTraversal(teamDirectory, target)
        await fs.rm(target, { recursive: true, force: true }).catch((err) => {
            logger.warn("pruneRuns: failed to remove orphaned run directory", { runId, error: err instanceof Error ? err.message : String(err) })
        })
    }
    // Quarantine corrupted run directories — record.json exists but is unreadable
    // or invalid. Do NOT delete: member output .md files and event logs may still
    // be valid and recoverable. Log a warning so operators can investigate.
    for (const runId of corrupted) {
        logger.warn("pruneRuns: run directory has unreadable/invalid record.json; quarantining (not deleting) to preserve member outputs", { runId })
    }
    if (dated.length <= keep) return

    dated.sort((a, b) => b.finishedAt - a.finishedAt)
    for (const { runId } of dated.slice(keep)) {
        const target = runDir(teamDirectory, runId)
        await assertNoSymlinkTraversal(teamDirectory, target)
        await fs.rm(target, { recursive: true, force: true }).catch((err) => {
            logger.warn("pruneRuns: failed to remove run directory", { runId, error: err instanceof Error ? err.message : String(err) })
        })
    }
}
/**
 * Read all run records for a team, newest-first (by finishedAt). Runs without a
 * valid record.json (mid-capture / corrupt) are skipped. Used by team_results.
 */
export async function listRunRecords(teamDirectory: string): Promise<RunRecord[]> {
    const root = runsDir(teamDirectory)
    // C-2: refuse to list through a symlinked runs/.
    await assertNoSymlinkTraversal(teamDirectory, root)
    let runIds: string[] = []
    try {
        runIds = await fs.readdir(root)
    } catch {
        return []
    }
    const records: RunRecord[] = []
    for (const runId of runIds) {
        const recordPath = runRecordPath(teamDirectory, runId)
        try {
            await assertNoSymlinkTraversal(teamDirectory, recordPath)
            const raw = await fs.readFile(recordPath, "utf8")
            records.push(parseRunRecord(raw))
        } catch (err) {
            // skip incomplete/corrupt runs, but log non-ENOENT errors for observability
            if (!isEnoent(err)) {
                logger.warn("listRunRecords: failed to read run record", { runId, error: err instanceof Error ? err.message : String(err) })
            }
        }
    }
    records.sort((a, b) => b.finishedAt - a.finishedAt)
    return records
}

/** Read a single run record by id, or null if absent/corrupt. */
export async function readRunRecord(teamDirectory: string, runId: string): Promise<RunRecord | null> {
    const recordPath = runRecordPath(teamDirectory, runId)
    // C-2: refuse to read through a symlinked record.json or intermediate dir.
    // This MUST run before the try-catch below: the catch swallows non-ENOENT
    // errors as "corrupt run", which would silently accept attacker-controlled
    // content from a redirected file.
    await assertNoSymlinkTraversal(teamDirectory, recordPath)
    try {
        const raw = await fs.readFile(recordPath, "utf8")
        return parseRunRecord(raw)
    } catch (err) {
        if (!isEnoent(err)) {
            logger.warn("readRunRecord: failed to read run record", { runId, error: err instanceof Error ? err.message : String(err) })
        }
        return null
    }
}

/**
 * Read a run's event timeline (runs/<runId>/events.jsonl), sorted by timestamp
 * (NOT file order — events are appended fire-and-forget). Bad lines are skipped.
 * Returns [] when the file is absent (run produced no events yet).
 */
export async function readRunEvents(teamDirectory: string, runId: string): Promise<RunEvent[]> {
    const eventsPath = runEventsPath(teamDirectory, runId)
    // C-2: refuse to read through a symlinked events.jsonl or intermediate dir.
    // See readRunRecord: must run before the try-catch below so the symlink
    // rejection is not swallowed as "file unreadable".
    await assertNoSymlinkTraversal(teamDirectory, eventsPath)
    let raw: string
    try {
        raw = await fs.readFile(eventsPath, "utf8")
    } catch (err) {
        if (!isEnoent(err)) {
            logger.warn("readRunEvents: failed to read events file", { runId, error: err instanceof Error ? err.message : String(err) })
        }
        return []
    }
    const events: RunEvent[] = []
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue
        try {
            events.push(parseRunEvent(line))
        } catch {
            // skip malformed line
        }
    }
    events.sort((a, b) => a.timestamp - b.timestamp)
    return events
}

/**
 * Classify each fanout branch as completed, skipped, errored, or pending based
 * on the join's survivor/errored sets and branch-tail step state.
 */
function workflowBranchStatuses(steps: readonly WorkflowStep[], fanoutIndex: number): Record<string, WorkflowBranchStatus> | undefined {
    const fanoutStep = steps[fanoutIndex]
    const fanout = fanoutStep?.kind === "fanout" ? fanoutStep.fanout : undefined
    if (fanout === undefined) return undefined

    const joinStep = steps[fanout.joinIndex]
    const join = joinStep?.kind === "join" ? joinStep.join : undefined
    const survivorBranchIds = new Set(join?.survivorBranchIds ?? [])
    const erroredBranchIds = new Set(join?.erroredBranchIds ?? [])
    const statuses: Record<string, WorkflowBranchStatus> = {}

    for (let branchIndex = 0; branchIndex < fanout.branchIds.length; branchIndex += 1) {
        const branchId = fanout.branchIds[branchIndex]
        const range = fanout.branchRanges[branchIndex]
        if (branchId === undefined || range === undefined) continue

        if (erroredBranchIds.has(branchId)) {
            statuses[branchId] = "errored"
            continue
        }
        if (survivorBranchIds.has(branchId)) {
            statuses[branchId] = "completed"
            continue
        }

        const tail = steps[range.endIndex]
        if (tail?.skipped === true) {
            statuses[branchId] = "skipped"
        } else if (tail?.completed === true) {
            statuses[branchId] = "completed"
        } else {
            statuses[branchId] = "pending"
        }
    }

    return statuses
}

/** Resolve branch statuses for a step: fanout/join steps delegate to workflowBranchStatuses; task/gate return undefined. */
function workflowBranchStatusesForStep(
    steps: readonly WorkflowStep[],
    index: number,
    step: WorkflowStep,
): Record<string, WorkflowBranchStatus> | undefined {
    switch (step.kind) {
        case "fanout":
            return workflowBranchStatuses(steps, index)
        case "join":
            return step.join === undefined ? undefined : workflowBranchStatuses(steps, step.join.fanoutIndex)
        case "task":
        case "gate":
            return undefined
        default:
            step satisfies never
            return undefined
    }
}

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
import path from "node:path"

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

const WORKFLOW_OUTPUT_BYTE_BUDGET = 512 * 1024
const WORKFLOW_OUTPUT_TRUNCATED_MARKER = "[workflow outputs truncated: 524288-byte budget exceeded]"

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
    "workflow_failed",     // workflow: MUST stay in sync with WORKFLOW_FAILED_REASON_PREFIXES in workflow/reasons.ts
    "workflow_invalid",    // workflow: MUST stay in sync
    "workflow_input_skipped", // workflow: declared inputs were skipped by goto
    "workflow_frontier_deadlock", // workflow: no steps ready, all waiting
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
    // MEDIUM #15: joinedOutput is NOT included in record.json to keep the
    // record lean. Instead, persistRun writes it to a per-step artifact
    // file (join-<stepIndex>.md) so it's recoverable without bloating state.
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
    const memberNames = new Set(team.members.filter(member => !member.isMaster).map(member => member.name))
    let entries: string[] = []
    // C-2: runDir is <team>/runs/<runId>; verify the ancestor chain before
    // readdir so a symlinked intermediate (e.g. <team>/runs) cannot redirect
    // the enumeration outside the team root.
    try {
        await assertNoSymlinkTraversal(team.directory, dir)
        entries = await fs.readdir(dir)
    } catch (err) {
        // H37: only ENOENT is the benign "no member turns yet" case. Any other
        // error (EACCES, EIO) means the enumeration is unreliable, so rethrow
        // instead of persisting a record with silently-empty memberOutputs. The
        // best-effort caller boundary (deliverSummaryToLeader) logs the failure.
        if (!isEnoent(err)) {
            logger.warn("persistRun: readdir failed for run output dir", {
                dir, error: err instanceof Error ? err.message : String(err),
            })
            throw err
        }
        // dir may not exist (e.g. a run with no member turns yet) — that's fine
    }
    for (const file of entries) {
        if (!file.endsWith(".md")) continue
        const member = file.slice(0, -3)
        if (!memberNames.has(member)) continue
        // M10: skip files whose name starts with "master" — a member with
        // FS write access could plant a master.md to impersonate the leader.
        // Keep this defense even when a configured member has that prefix.
        if (member.startsWith("master")) continue
        try {
            const filePath = `${dir}/${file}`
            // C-2: verify each <runDir>/<member>.md path before stat so a
            // symlinked member-named file cannot redirect the stat or later
            // reads outside the team root.
            await assertNoSymlinkTraversal(team.directory, filePath)
            const stat = await fs.stat(filePath)
            memberOutputs[member] = { bytes: stat.size, file }
        } catch (err) {
            // H37: ENOENT means the file was raced/removed between readdir and
            // stat — skip it. Any other error (EACCES, EIO, symlink rejection)
            // means the metadata is unreliable, so rethrow instead of silently
            // dropping this member's output from the record.
            if (!isEnoent(err)) {
                logger.warn("persistRun: stat failed for member output", {
                    file, error: err instanceof Error ? err.message : String(err),
                })
                throw err
            }
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
        try {
            const tasks = await listAllTasks(team.directory)
            record.tasks = tasks.map(t => ({
                id: t.id,
                subject: t.subject,
                status: t.status,
                owner: t.owner,
            }))
        } catch (err) {
            logger.warn("persistRun: delegate task snapshot failed", {
                team: team.teamName,
                runId,
                error: err instanceof Error ? err.message : String(err),
            })
        }
    }

    if (task.type === "workflow") {
        const steps = task.steps ?? []
        const markerBytes = Buffer.byteLength(WORKFLOW_OUTPUT_TRUNCATED_MARKER, "utf8")
        let persistedOutputBytes = 0
        let outputsTruncated = false
        record.workflow = {
            steps: steps.map((step, index) => {
                const outputBytes = step.output === undefined
                    ? undefined
                    : Buffer.byteLength(step.output, "utf8")
                let output: string | undefined
                if (step.output !== undefined && outputBytes !== undefined && !outputsTruncated) {
                    if (persistedOutputBytes + outputBytes <= WORKFLOW_OUTPUT_BYTE_BUDGET - markerBytes) {
                        output = step.output
                        persistedOutputBytes += outputBytes
                    } else {
                        output = WORKFLOW_OUTPUT_TRUNCATED_MARKER
                        outputsTruncated = true
                    }
                }
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
                    output,
                    outputBytes,
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
                        return {
                            ...base,
                            member: step.member,
                            // M9: include task retry audit fields so run records
                            // capture the actual retry configuration and execution
                            // history (attempts consumed, retry_on condition used).
                            // Pre-fix code only included `member`.
                            fallbackMember: step.fallbackMember,
                            retryOn: step.retryOn,
                            maxTaskRetries: step.maxTaskRetries,
                            taskAttempts: step.taskAttempts,
                            timeoutAttempts: step.timeoutAttempts,
                        }
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
                            // M-RUNREC: persist runtime ensemble + loop audit
                            // fields so run records can reconstruct the actual
                            // decision process (which verifier ran, how many
                            // loop iterations executed).
                            fallbackVerifier: step.fallbackVerifier,
                            ensembleResults: step.ensembleResults,
                            loopIterations: step.loopIterations,
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

    // Index run-level artifacts (reduce.md, signoff.md) that the memberOutputs
    // scan skips because their basenames are not member names. Without this a
    // RunRecord consumer has no path reference to the reduced result or the
    // signoff verdict file. signoff maps each reviewer whose verdict was
    // captured (and thus written to the shared signoff.md) to that file.
    const artifacts: NonNullable<RunRecord["artifacts"]> = {}
    if (entries.includes("reduce.md")) artifacts.reduce = "reduce.md"
    // Signoff artifacts: per-reviewer files or shared signoff.md.
    const signoffFiles = entries.filter(f => f.startsWith("signoff") && f.endsWith(".md"))
    if (signoffFiles.length > 0) {
        artifacts.signoff = {}
        for (const f of signoffFiles) {
            // signoff-{reviewer}.md or signoff.md
            const reviewer = f === "signoff.md" ? "_shared" : f.slice("signoff-".length, -".md".length)
            artifacts.signoff[reviewer] = f
        }
    }
    // MEDIUM #15: index join output artifacts (join-<step>.md).
    const joinFiles = entries.filter(f => f.startsWith("join-") && f.endsWith(".md"))
    if (joinFiles.length > 0) {
        artifacts.join = {}
        for (const f of joinFiles) artifacts.join[f] = f
    }
    if (Object.keys(artifacts).length > 0) {
        record.artifacts = artifacts
    }

    // HIGH: schema validation before write. If the record is invalid,
    // write to record.invalid.json instead so readRunRecord doesn't
    // produce a record that readers will silently strip or reject.
    const serialized = JSON.stringify(record, null, 2)
    const parseResult = RunRecordSchema.safeParse(JSON.parse(serialized))
    if (!parseResult.success) {
        const issues = parseResult.error.issues.map(i => `${i.path.join(".")}: ${i.message}`)
        logger.warn("persistRun: record failed schema validation, writing to record.invalid.json", { runId, issues })
        const invalidPath = path.join(runDir(team.directory, runId), "record.invalid.json")
        await atomicWrite(invalidPath, serialized, team.directory)
    } else {
        await atomicWrite(runRecordPath(team.directory, runId), serialized, team.directory)
    }
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
        // HIGH: exclude .quarantine and non-directory entries.
        const entries = await fs.readdir(root, { withFileTypes: true })
        runIds = entries.filter(e => e.isDirectory() && e.name !== ".quarantine").map(e => e.name)
    } catch (err) {
        // M-PRUNE: distinguish ENOENT (no runs/ yet) from real errors.
        if (!isEnoent(err)) {
            logger.warn("pruneRuns: readdir failed", { dir: root, error: err instanceof Error ? err.message : String(err) })
        }
        return // no runs/ yet or unreadable
    }

    const dated: Array<{ runId: string; finishedAt: number }> = []
    const orphaned: string[] = []
    const corrupted: string[] = []
    // C-2: pre-check each runRecordPath before reading so a symlinked
    // <team>/runs/<runId>/record.json cannot read attacker-controlled content
    // from outside the team root. Filter out runIds whose path fails the check
    // (treat as corrupt so quarantine preserves any legitimate outputs).
    const checked: string[] = []
    for (const runId of runIds) {
        try {
            await assertNoSymlinkTraversal(teamDirectory, runRecordPath(teamDirectory, runId))
            checked.push(runId)
        } catch {
            corrupted.push(runId)
        }
    }
    const records = await Promise.all(
        checked.map(runId =>
            fs.readFile(runRecordPath(teamDirectory, runId), "utf8")
                .then(raw => {
                    try {
                        const rec = parseRunRecord(raw)
                        if (rec.runId !== runId) return { kind: "mismatch" as const, rec }
                        return { kind: "ok" as const, rec }
                    }
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
        else if (kind === "mismatch" && rec) {
            logger.warn("pruneRuns: runId mismatch; skipping run record", { runId, recordRunId: rec.runId })
        }
        else if (kind === "missing") orphaned.push(runId)
        else corrupted.push(runId)
    }
    // HIGH: quarantine orphaned run directories instead of deleting them.
    // Pre-fix code deleted crash-during-capture evidence. Now: rename to
    // a quarantine subdirectory so crash recovery tools can inspect them.
    for (const runId of orphaned) {
        const target = runDir(teamDirectory, runId)
        const quarantineDir = path.join(runsDir(teamDirectory), ".quarantine")
        const quarantined = path.join(quarantineDir, runId)
        try {
            await fs.mkdir(quarantineDir, { recursive: true })
            await fs.rename(target, quarantined)
            logger.warn("pruneRuns: quarantined orphaned run directory (no record.json)", { runId, quarantined })
        } catch (err) {
            if (isEnoent(err)) continue // already gone
            // If rename fails (cross-device, permissions), fall back to deletion.
            await fs.rm(target, { recursive: true, force: true }).catch((rmErr) => {
                logger.warn("pruneRuns: failed to remove orphaned run directory after quarantine failed", { runId, error: rmErr instanceof Error ? rmErr.message : String(rmErr) })
            })
        }
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
    } catch (err) {
        // M-12: distinguish ENOENT (no runs/ yet — return []) from real
        // storage failures (EACCES, EIO). Pre-fix code masked ALL errors as
        // "no runs," hiding disk problems from operators.
        if (!isEnoent(err)) {
            logger.warn("listRunRecords: readdir failed", { dir: root, error: err instanceof Error ? err.message : String(err) })
            throw err
        }
        return []
    }
    const records: RunRecord[] = []
    for (const runId of runIds) {
        const recordPath = runRecordPath(teamDirectory, runId)
        let raw: string
        try {
            await assertNoSymlinkTraversal(teamDirectory, recordPath)
            raw = await fs.readFile(recordPath, "utf8")
        } catch (err) {
            if (isEnoent(err)) continue
            logger.warn("listRunRecords: failed to read run record", { runId, error: err instanceof Error ? err.message : String(err) })
            throw err
        }
        try {
            const parsed = parseRunRecord(raw)
            if (parsed.runId !== runId) {
                logger.warn("listRunRecords: runId mismatch; skipping run record", { runId, recordRunId: parsed.runId })
                continue
            }
            records.push(parsed)
        } catch (err) {
            logger.warn("listRunRecords: invalid run record; skipping", { runId, error: err instanceof Error ? err.message : String(err) })
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
    let raw: string
    try {
        raw = await fs.readFile(recordPath, "utf8")
    } catch (err) {
        if (isEnoent(err)) return null
        logger.warn("readRunRecord: failed to read run record", { runId, error: err instanceof Error ? err.message : String(err) })
        throw err
    }
    try {
        const parsed = parseRunRecord(raw)
        if (parsed.runId !== runId) {
            throw new Error(`runId mismatch: expected ${runId}, got ${parsed.runId}`)
        }
        return parsed
    } catch (err) {
        logger.warn("readRunRecord: invalid run record", { runId, error: err instanceof Error ? err.message : String(err) })
        return null
    }
}

/**
 * Read a run's event timeline (runs/<runId>/events.jsonl), sorted by timestamp.
 * Per-run appends preserve emission order, and stable sorting preserves that
 * file order when multiple events share a timestamp. Bad lines are skipped.
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
        if (isEnoent(err)) return []
        logger.warn("readRunEvents: failed to read events file", { runId, error: err instanceof Error ? err.message : String(err) })
        throw err
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
    // MEDIUM: sort by sequence (if present) for stable ordering of
    // same-millisecond events. Process restart resets the counter to 0,
    // so within a single file the sequence is monotonic. For events from
    // multiple processes (rare), fall back to timestamp.
    events.sort((a, b) => {
        if (a.sequence !== undefined && b.sequence !== undefined) return a.sequence - b.sequence
        return a.timestamp - b.timestamp
    })
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

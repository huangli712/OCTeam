/**
 * Persistent per-orchestration run records (roadmap #2).
 *
 * Full member outputs are written to runs/<runId>/<member>.md at CAPTURE time
 * (handlers.ts Step 4). This module writes the run's record.json — a JSON
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

import { z } from "zod"

import type { Team } from "../state/store.js"
import type { RunRecord, RunStatus, WorkflowBranchStatus, WorkflowRunStep, WorkflowStep } from "../core/types.js"
import { atomicWrite } from "../state/locks.js"
import { runsDir, runDir, runRecordPath, runEventsPath } from "../state/paths.js"
import type { RunEvent } from "../core/types.js"
import { listAllTasks } from "../state/tasks.js"

/** Keep at most this many run records per team; older ones are pruned. */
export const DEFAULT_MAX_RUNS = 20

/**
 * Reason substrings that indicate a FAILED run. Everything else is "completed".
 *
 * IMPORTANT: when a new termination reason is added at any deliverSummaryToLeader
 * call site, classify it here if it represents a failure. The set below mirrors
 * the failed-status reasons in handlers.ts / termination.ts as of #1+#2.
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
    "signoff_rejected",           // signoff: decider/reviewer rejected the work
    "signoff_quorum_not_reached", // signoff: peer-quorum did not get enough approvals
    "human_rejected",             // HITL: leader rejected a mid-run approval request
    "arena_failed",               // arena: every arena_failed:* reason (no_survivors, member_error, evaluator_*, eval_invalid); arena_complete matches no marker and stays completed
] as const

/** Derive run status from the verbatim termination reason (heuristic; see set above). */
export function runStatusFromReason(reason: string): RunStatus {
    return FAILED_REASON_MARKERS.some(m => reason.includes(m)) ? "failed" : "completed"
}

/**
 * Zod schemas mirroring the RunRecord / RunEvent types (src/core/types.ts).
 * Used to validate JSON read back from disk instead of bare `as` casts: a
 * structurally-invalid record is treated the same as corrupt JSON (skipped).
 * Unknown keys are stripped (zod default); required fields match the types.
 */
const OrchestrationTypeSchema = z.enum([
    "parallel", "pipeline", "loop", "delegate", "consensus", "route", "arbitrate", "recurse", "tollgate", "workflow", "arena",
])
const ParallelModeSchema = z.enum(["isolated", "cooperative"])
const RunStatusSchema = z.enum(["completed", "failed"])
const SignoffPolicySchema = z.enum(["none", "decider", "peer-quorum"])

const DecisionRecordSchema = z.object({
    round: z.number(),
    decision: z.enum(["continue", "done"]),
    rationale: z.string(),
    nextActions: z.array(z.string()),
    timestamp: z.number(),
})

const ApprovalKindSchema = z.enum(["pipeline_stage", "tollgate_gate", "loop_done", "route_decision", "recurse_decompose", "arbitrate_ruling", "consensus_deadlock", "workflow_step"])
const ApprovalDecisionRecordSchema = z.object({
    id: z.string(),
    kind: ApprovalKindSchema,
    approved: z.boolean(),
    requestedAt: z.number(),
    resolvedAt: z.number(),
    feedback: z.string().optional(),
})

const WorkflowStepKindSchema = z.enum(["task", "gate", "fanout", "join"])
const VerdictSchema = z.enum(["PASS", "FAIL", "INVALID"])
const WorkflowOnInvalidSchema = z.enum(["fail", "retry_verifier", "escalate"])
const WorkflowBranchStatusSchema = z.enum(["pending", "completed", "skipped", "errored"])
const WorkflowIssueSchema = z.object({
    severity: z.enum(["low", "medium", "high", "critical"]),
    message: z.string().optional(),
})
const WorkflowBranchRangeSchema = z.object({
    startIndex: z.number().int().nonnegative(),
    endIndex: z.number().int().nonnegative(),
}).refine(range => range.endIndex >= range.startIndex, "branch range endIndex must be >= startIndex")
const WorkflowJoinPolicySchema = z.enum(["tolerance", "all", "quorum", "any_success", "required_branches", "reduce", "select"])
const WorkflowFanoutMetadataSchema = z.object({
    branchIds: z.array(z.string().min(1)),
    branchRanges: z.array(WorkflowBranchRangeSchema),
    joinIndex: z.number().int().nonnegative(),
    maxErrored: z.number().int().nonnegative(),
    joinPolicy: WorkflowJoinPolicySchema.optional(),
    quorum: z.number().optional(),
    requiredBranchIds: z.array(z.string().min(1)).optional(),
    reducerMember: z.string().min(1).optional(),
    useSurvivors: z.boolean().optional(),
}).refine(fanout => fanout.branchIds.length === fanout.branchRanges.length, "fanout branchIds and branchRanges length mismatch")
const WorkflowBranchMetadataSchema = z.object({
    fanoutIndex: z.number().int().nonnegative(),
    branchId: z.string().min(1),
    branchIndex: z.number().int().nonnegative(),
    joinIndex: z.number().int().nonnegative(),
})
const WorkflowJoinMetadataSchema = z.object({
    fanoutIndex: z.number().int().nonnegative(),
    branchTailIndices: z.array(z.number().int().nonnegative()),
    maxErrored: z.number().int().nonnegative(),
    joinPolicy: WorkflowJoinPolicySchema.optional(),
    quorum: z.number().optional(),
    requiredBranchIds: z.array(z.string().min(1)).optional(),
    reducerMember: z.string().min(1).optional(),
    useSurvivors: z.boolean().optional(),
    survivorBranchIds: z.array(z.string().min(1)).optional(),
    erroredBranchIds: z.array(z.string().min(1)).optional(),
    selectedBranchId: z.string().min(1).optional(),
    selectionRationale: z.string().optional(),
})
const WorkflowRunStepSchema = z.object({
    index: z.number(),
    step: z.number(),
    kind: WorkflowStepKindSchema,
    id: z.string().optional(),
    member: z.string().optional(),
    verifier: z.string().optional(),
    dispatchedActor: z.string().optional(),
    targetStep: z.number().optional(),
    targetSteps: z.array(z.number()).optional(),
    verdict: VerdictSchema.optional(),
    score: z.number().optional(),
    confidence: z.number().optional(),
    issues: z.array(WorkflowIssueSchema).optional(),
    attempts: z.number().optional(),
    onInvalid: WorkflowOnInvalidSchema.optional(),
    invalidAttempts: z.number().optional(),
    jumpCount: z.number().optional(),
    skipped: z.boolean().optional(),
    completed: z.boolean(),
    output: z.string().optional(),
    outputBytes: z.number().optional(),
    joinedOutputBytes: z.number().optional(),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
    durationMs: z.number().optional(),
    inputs: z.array(z.number()).optional(),
    exposeOutput: z.boolean().optional(),
    fanout: WorkflowFanoutMetadataSchema.optional(),
    branch: WorkflowBranchMetadataSchema.optional(),
    join: WorkflowJoinMetadataSchema.optional(),
    branchStatuses: z.record(z.string(), WorkflowBranchStatusSchema).optional(),
    // Static step-level control config (for post-run audit). Mirrors the
    // runtime-declared controls; approvalBeforeGranted is transient and NOT
    // persisted (it only matters mid-run).
    approvalBefore: z.boolean().optional(),
    approvalAfter: z.boolean().optional(),
    maxOutputBytes: z.number().optional(),
})

const WorkflowRunSchema = z.object({
    steps: z.array(WorkflowRunStepSchema),
}).superRefine((workflow, ctx) => {
    const steps = workflow.steps
    const addStepIssue = (index: number, message: string, path: Array<string | number> = []): void => {
        ctx.addIssue({ code: "custom", path: ["steps", index, ...path], message })
    }

    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]
        if (step === undefined) continue
        if (step.index !== index) addStepIssue(index, `workflow step index must equal ${index}`, ["index"])
        if (step.step !== index + 1) addStepIssue(index, `workflow display step must equal ${index + 1}`, ["step"])

        switch (step.kind) {
            case "fanout": {
                if (step.fanout === undefined) {
                    addStepIssue(index, "fanout step requires fanout metadata", ["fanout"])
                    break
                }
                if (step.branch !== undefined) addStepIssue(index, "fanout step cannot carry branch metadata", ["branch"])
                if (step.join !== undefined) addStepIssue(index, "fanout step cannot carry join metadata", ["join"])
                const fanout = step.fanout
                if (new Set(fanout.branchIds).size !== fanout.branchIds.length) {
                    addStepIssue(index, "fanout branch ids must be unique", ["fanout", "branchIds"])
                }
                const joinStep = steps[fanout.joinIndex]
                if (joinStep?.kind !== "join" || joinStep.join?.fanoutIndex !== index) {
                    addStepIssue(index, "fanout joinIndex must point to a matching join step", ["fanout", "joinIndex"])
                }
                for (let branchIndex = 0; branchIndex < fanout.branchRanges.length; branchIndex += 1) {
                    const range = fanout.branchRanges[branchIndex]
                    const branchId = fanout.branchIds[branchIndex]
                    if (range === undefined || branchId === undefined) continue
                    if (range.startIndex <= index || range.endIndex >= fanout.joinIndex || range.endIndex >= steps.length) {
                        addStepIssue(index, "fanout branch range must be between fanout and join", ["fanout", "branchRanges", branchIndex])
                        continue
                    }
                    if (joinStep?.join?.branchTailIndices[branchIndex] !== range.endIndex) {
                        addStepIssue(index, "join branchTailIndices must match fanout branch range tails", ["fanout", "branchRanges", branchIndex])
                    }
                    for (let branchStepIndex = range.startIndex; branchStepIndex <= range.endIndex; branchStepIndex += 1) {
                        const branchStep = steps[branchStepIndex]
                        if (branchStep === undefined) {
                            addStepIssue(index, "fanout branch range points outside workflow steps", ["fanout", "branchRanges", branchIndex])
                            continue
                        }
                        if (branchStep.kind === "fanout" || branchStep.kind === "join") {
                            addStepIssue(branchStepIndex, "fanout branch range can only contain task/gate steps")
                            continue
                        }
                        const branch = branchStep.branch
                        if (branch === undefined) {
                            addStepIssue(branchStepIndex, "branch step requires branch metadata", ["branch"])
                            continue
                        }
                        if (branch.fanoutIndex !== index || branch.branchId !== branchId || branch.branchIndex !== branchIndex || branch.joinIndex !== fanout.joinIndex) {
                            addStepIssue(branchStepIndex, "branch metadata must match containing fanout range", ["branch"])
                        }
                    }
                }
                break
            }
            case "join": {
                if (step.join === undefined) {
                    addStepIssue(index, "join step requires join metadata", ["join"])
                    break
                }
                if (step.fanout !== undefined) addStepIssue(index, "join step cannot carry fanout metadata", ["fanout"])
                if (step.branch !== undefined) addStepIssue(index, "join step cannot carry branch metadata", ["branch"])
                const fanoutStep = steps[step.join.fanoutIndex]
                if (fanoutStep?.kind !== "fanout" || fanoutStep.fanout?.joinIndex !== index) {
                    addStepIssue(index, "join fanoutIndex must point to a matching fanout step", ["join", "fanoutIndex"])
                    break
                }
                const fanout = fanoutStep.fanout
                if (fanout.branchRanges.length !== step.join.branchTailIndices.length) {
                    addStepIssue(index, "join branchTailIndices length must match fanout branches", ["join", "branchTailIndices"])
                }
                const branchIds = new Set(fanout.branchIds)
                const survivorBranchIds = step.join.survivorBranchIds ?? []
                const erroredBranchIds = step.join.erroredBranchIds ?? []
                for (const branchId of survivorBranchIds) {
                    if (!branchIds.has(branchId)) addStepIssue(index, "join survivorBranchIds must reference known fanout branches", ["join", "survivorBranchIds"])
                }
                for (const branchId of erroredBranchIds) {
                    if (!branchIds.has(branchId)) addStepIssue(index, "join erroredBranchIds must reference known fanout branches", ["join", "erroredBranchIds"])
                    if (survivorBranchIds.includes(branchId)) addStepIssue(index, "join branch cannot be both survivor and errored", ["join"])
                }
                break
            }
            case "task":
            case "gate": {
                if (step.fanout !== undefined) addStepIssue(index, "task/gate step cannot carry fanout metadata", ["fanout"])
                if (step.join !== undefined) addStepIssue(index, "task/gate step cannot carry join metadata", ["join"])
                if (step.branch === undefined) break
                const fanoutStep = steps[step.branch.fanoutIndex]
                if (fanoutStep?.kind !== "fanout" || fanoutStep.fanout === undefined) {
                    addStepIssue(index, "branch fanoutIndex must point to a matching fanout step", ["branch", "fanoutIndex"])
                    break
                }
                const range = fanoutStep.fanout.branchRanges[step.branch.branchIndex]
                const branchId = fanoutStep.fanout.branchIds[step.branch.branchIndex]
                if (range === undefined || branchId !== step.branch.branchId || step.branch.joinIndex !== fanoutStep.fanout.joinIndex || index < range.startIndex || index > range.endIndex) {
                    addStepIssue(index, "branch metadata must match containing fanout range", ["branch"])
                }
                break
            }
            default:
                step.kind satisfies never
        }
    }
})

const ArenaCandidateScoreSchema = z.object({
    member: z.string(),
    score: z.number().optional(),
    metrics: z.record(z.string(), z.number()).optional(),
    passed: z.boolean().optional(),
    rationale: z.string().optional(),
})
const ArenaScoreboardSchema = z.object({
    scores: z.array(ArenaCandidateScoreSchema),
    rationale: z.string().optional(),
})

const RunRecordSchema = z.object({
    version: z.literal(1),
    runId: z.string(),
    teamRunId: z.string(),
    teamName: z.string(),
    type: OrchestrationTypeSchema,
    mode: ParallelModeSchema.optional(),
    reason: z.string(),
    status: RunStatusSchema,
    startedAt: z.number(),
    finishedAt: z.number(),
    tokensUsed: z.number(),
    tokensByMember: z.record(z.string(), z.number()),
    messagesSent: z.number(),
    currentRound: z.number().optional(),
    decisionHistory: z.array(DecisionRecordSchema).optional(),
    approvalHistory: z.array(ApprovalDecisionRecordSchema).optional(),
    consensusReached: z.boolean().optional(),
    signoffPolicy: SignoffPolicySchema.optional(),
    signoffApprovals: z.record(z.string(), z.boolean()).optional(),
    memberOutputs: z.record(z.string(), z.object({ bytes: z.number(), file: z.string() })),
    tasks: z.array(z.object({
        id: z.string(),
        subject: z.string(),
        status: z.string(),
        owner: z.string().optional(),
    })).optional(),
    workflow: WorkflowRunSchema.optional(),
    arena: z.object({
        candidates: z.array(z.string()),
        survivingCandidates: z.array(z.string()).optional(),
        evaluator: z.string(),
        winner: z.string().optional(),
        scoreDirection: z.enum(["max", "min"]),
        winnerMetric: z.string(),
        scoreboard: ArenaScoreboardSchema.optional(),
    }).optional(),
})

const RunEventSchema = z.object({
    timestamp: z.number(),
    kind: z.enum([
        "dispatched", "captured", "retry", "errored", "stage_advanced", "round",
        "signoff", "approval_requested", "approval_resolved", "terminated", "routed", "arbitrated", "decomposed", "aggregated", "aggregation_stalled", "verdict", "repaired",
    ]),
    member: z.string().optional(),
    stage: z.number().optional(),
    round: z.number().optional(),
    stepIndex: z.number().optional(),
    correlationId: z.string().optional(),
    reason: z.string().optional(),
    bytes: z.number().optional(),
    detail: z.string().optional(),
})

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

function runJoinMetadata(join: WorkflowStep["join"]): WorkflowRunStep["join"] {
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

function workflowBranchStatuses(steps: readonly WorkflowStep[], fanoutIndex: number): Record<string, WorkflowBranchStatus> | undefined {
    const fanout = steps[fanoutIndex]?.fanout
    if (fanout === undefined) return undefined

    const join = steps[fanout.joinIndex]?.join
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
            step.kind satisfies never
            return undefined
    }
}

/**
 * Persist the active task as a run record. Called from deliverSummaryToLeader
 * BEFORE activeTask is cleared. No-op if there is no active task. Best-effort:
 * the caller wraps this so a persistence failure never blocks delivery.
 */
export async function persistRun(team: Team, reason: string): Promise<void> {
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
        status: runStatusFromReason(reason),
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
            steps: steps.map((step, index) => ({
                index,
                step: index + 1,
                kind: step.kind,
                id: step.id,
                member: step.member,
                verifier: step.verifier,
                dispatchedActor: step.dispatchedActor,
                targetStep: step.targetStepIndex === undefined ? undefined : step.targetStepIndex + 1,
                targetSteps: step.targetStepIndices?.map(index => index + 1),
                verdict: step.verdict,
                score: step.score,
                confidence: step.confidence,
                issues: step.issues,
                attempts: step.attempts,
                onInvalid: step.onInvalid,
                invalidAttempts: step.invalidAttempts,
                jumpCount: step.jumpCount,
                skipped: step.skipped,
                completed: step.completed,
                output: step.output,
                outputBytes: step.output === undefined ? undefined : Buffer.byteLength(step.output, "utf8"),
                joinedOutputBytes: step.join?.joinedOutput === undefined ? undefined : Buffer.byteLength(step.join.joinedOutput, "utf8"),
                startedAt: step.startedAt,
                completedAt: step.completedAt,
                durationMs: step.durationMs,
                inputs: step.inputs,
                exposeOutput: step.exposeOutput,
                fanout: step.fanout,
                branch: step.branch,
                join: runJoinMetadata(step.join),
                branchStatuses: workflowBranchStatusesForStep(steps, index, step),
                approvalBefore: step.approvalBefore,
                approvalAfter: step.approvalAfter,
                maxOutputBytes: step.maxOutputBytes,
            })),
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

    await atomicWrite(runRecordPath(team.directory, runId), JSON.stringify(record, null, 2))
    await pruneRuns(team.directory, DEFAULT_MAX_RUNS)
}

/**
 * Keep the most recent `keep` runs (by record.finishedAt), deleting older run
 * directories. Best-effort; a prune failure never blocks termination.
 */
export async function pruneRuns(teamDirectory: string, keep: number): Promise<void> {
    const root = runsDir(teamDirectory)
    let runIds: string[] = []
    try {
        runIds = await fs.readdir(root)
    } catch {
        return // no runs/ yet
    }

    const dated: Array<{ runId: string; finishedAt: number }> = []
    for (const runId of runIds) {
        try {
            const raw = await fs.readFile(runRecordPath(teamDirectory, runId), "utf8")
            const rec = parseRunRecord(raw)
            dated.push({ runId, finishedAt: rec.finishedAt ?? 0 })
        } catch {
            // no/invalid record.json (e.g. a run still mid-capture) — leave it alone
        }
    }
    if (dated.length <= keep) return

    dated.sort((a, b) => b.finishedAt - a.finishedAt)
    for (const { runId } of dated.slice(keep)) {
        await fs.rm(runDir(teamDirectory, runId), { recursive: true, force: true }).catch(() => {})
    }
}

/**
 * Read all run records for a team, newest-first (by finishedAt). Runs without a
 * valid record.json (mid-capture / corrupt) are skipped. Used by team_results.
 */
export async function listRunRecords(teamDirectory: string): Promise<RunRecord[]> {
    const root = runsDir(teamDirectory)
    let runIds: string[] = []
    try {
        runIds = await fs.readdir(root)
    } catch {
        return []
    }
    const records: RunRecord[] = []
    for (const runId of runIds) {
        try {
            const raw = await fs.readFile(runRecordPath(teamDirectory, runId), "utf8")
            records.push(parseRunRecord(raw))
        } catch {
            // skip incomplete/corrupt runs
        }
    }
    records.sort((a, b) => b.finishedAt - a.finishedAt)
    return records
}

/** Read a single run record by id, or null if absent/corrupt. */
export async function readRunRecord(teamDirectory: string, runId: string): Promise<RunRecord | null> {
    try {
        const raw = await fs.readFile(runRecordPath(teamDirectory, runId), "utf8")
        return parseRunRecord(raw)
    } catch {
        return null
    }
}

/**
 * Read a run's event timeline (runs/<runId>/events.jsonl), sorted by timestamp
 * (NOT file order — events are appended fire-and-forget). Bad lines are skipped.
 * Returns [] when the file is absent (run produced no events yet).
 */
export async function readRunEvents(teamDirectory: string, runId: string): Promise<RunEvent[]> {
    let raw: string
    try {
        raw = await fs.readFile(runEventsPath(teamDirectory, runId), "utf8")
    } catch {
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

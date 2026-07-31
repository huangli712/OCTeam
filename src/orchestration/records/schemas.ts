/**
 * Zod schemas mirroring the RunRecord / RunEvent types
 * (src/core/types/runs.ts). Used to validate JSON read back from disk instead
 * of bare `as` casts: a structurally-invalid record is treated the same as
 * corrupt JSON (skipped). Unknown keys are stripped (zod default); required
 * fields match the types.
 *
 * Extracted from runs.ts so the persistence/query logic and the (larger)
 * validation schema tree stay in focused modules.
 */

import { z } from "zod"

// ============================================================
// Basic enums (mirror core/types enums)
// ============================================================

const OrchestrationTypeSchema = z.enum([
    "parallel", "pipeline", "loop", "delegate", "consensus",
    "route", "arbitrate", "recurse", "tollgate", "workflow", "arena",
    "quorum",
])

const ParallelModeSchema = z.enum(["isolated", "cooperative"])

const RunStatusSchema = z.enum(["completed", "failed"])

const SignoffPolicySchema = z.enum(["none", "decider", "peer-quorum"])

// ============================================================
// Decision / approval records
// ============================================================

/** A loop decider's structured decision: continue/done, rationale, and next-action items. */
const DecisionRecordSchema = z.object({
    round: z.number(),
    decision: z.enum(["continue", "done"]),
    rationale: z.string(),
    nextActions: z.array(z.string()),
    timestamp: z.number(),
})

const ApprovalKindSchema = z.enum([
    "pipeline_stage", "tollgate_gate", "loop_done", "route_decision",
    "recurse_decompose", "arbitrate_ruling", "consensus_deadlock", "workflow_step",
])

/** A resolved HITL approval: id, kind, approved/rejected, timestamps, optional feedback. */
const ApprovalDecisionRecordSchema = z.object({
    id: z.string(),
    kind: ApprovalKindSchema,
    approved: z.boolean(),
    requestedAt: z.number(),
    resolvedAt: z.number(),
    feedback: z.string().optional(),
})

// ============================================================
// Workflow step metadata (mirrors runtime WorkflowStep sub-types)
// ============================================================

const WorkflowStepKindSchema = z.enum(["task", "gate", "fanout", "join"])

const VerdictSchema = z.enum(["PASS", "FAIL", "INVALID"])

const WorkflowOnInvalidSchema = z.enum(["fail", "retry_verifier", "escalate"])

const WorkflowOnFailSchema = z.enum(["fail", "retry", "skip"])

const WorkflowOnTimeoutSchema = z.enum(["fail", "retry", "skip"])

const WorkflowBranchStatusSchema = z.enum(["pending", "completed", "skipped", "errored"])

/** A structured issue from a gate verifier: severity plus an optional human-readable message. */
const WorkflowIssueSchema = z.object({
    severity: z.enum(["low", "medium", "high", "critical"]),
    message: z.string().optional(),
})

/** A fanout branch's step range; refined so endIndex >= startIndex. */
const WorkflowBranchRangeSchema = z.object({
    startIndex: z.number().int().nonnegative(),
    endIndex: z.number().int().nonnegative(),
}).refine(range => range.endIndex >= range.startIndex, "branch range endIndex must be >= startIndex")

const WorkflowJoinPolicySchema = z.enum([
    "tolerance", "all", "quorum", "any_success", "required_branches", "reduce", "select",
])

/** Persisted fanout metadata: branch ids, ranges, join pointer, and join policy config. */
const WorkflowFanoutMetadataSchema = z.object({
    branchIds: z.array(z.string().min(1)),
    branchRanges: z.array(WorkflowBranchRangeSchema),
    joinIndex: z.number().int().nonnegative(),
    maxErrored: z.number().int().nonnegative(),
    joinPolicy: WorkflowJoinPolicySchema.optional(),
    quorum: z.number().refine(v => v > 0 && v <= 1, "quorum must be in (0, 1]").optional(),
    requiredBranchIds: z.array(z.string().min(1)).optional(),
    reducerMember: z.string().min(1).optional(),
    useSurvivors: z.boolean().optional(),
}).refine(
    fanout => fanout.branchIds.length === fanout.branchRanges.length,
    "fanout branchIds and branchRanges length mismatch",
).refine(
    // MEDIUM: reject empty fanout (zero branches).
    fanout => fanout.branchIds.length > 0,
    "fanout must have at least one branch",
).refine(
    // M-33: cross-field constraints — joinPolicy requires its companion field.
    fanout => fanout.joinPolicy !== "reduce" && fanout.joinPolicy !== "select" || fanout.reducerMember !== undefined,
    "joinPolicy 'reduce'/'select' requires reducerMember",
).refine(
    fanout => fanout.joinPolicy !== "quorum" || fanout.quorum !== undefined,
    "joinPolicy 'quorum' requires quorum value",
).refine(
    fanout => fanout.joinPolicy !== "required_branches" || (fanout.requiredBranchIds ?? []).length > 0,
    "joinPolicy 'required_branches' requires non-empty requiredBranchIds",
).refine(
    // C-14: required_branches must reference existing branchIds. A tampered or
    // corrupt record with requiredBranchIds referencing non-existent branches
    // would pass the persistence boundary and produce misleading audit data.
    fanout => fanout.joinPolicy !== "required_branches"
        || (fanout.requiredBranchIds ?? []).every(id => fanout.branchIds.includes(id)),
    "joinPolicy 'required_branches' references unknown branchIds",
)

/** Persisted branch metadata: links a branch step to its containing fanout and join. */
const WorkflowBranchMetadataSchema = z.object({
    fanoutIndex: z.number().int().nonnegative(),
    branchId: z.string().min(1),
    branchIndex: z.number().int().nonnegative(),
    joinIndex: z.number().int().nonnegative(),
})

/** Persisted join metadata: fanout linkage, branch tail indices, and join-resolution results. */
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
}).superRefine((join, ctx) => {
    if (join.quorum !== undefined && (join.quorum <= 0 || join.quorum > 1)) {
        ctx.addIssue({
            code: "custom",
            path: ["quorum"],
            message: "quorum must be in (0, 1]",
        })
    }
})

/**
 * Persisted workflow step: the runtime WorkflowStep projected into the
 * RunRecord shape. Adds persisted-only fields (index, step number,
 * outputBytes, durationMs) and omits transient runtime fields.
 */
const WorkflowRunStepSchema = z.object({
    index: z.number(),
    step: z.number(),
    kind: WorkflowStepKindSchema,
    id: z.string().optional(),
    member: z.string().optional(),
    verifier: z.string().optional(),
    // M-3: ensemble gate fields — pre-fix schema omitted these, so Zod
    // parsing would STRIP them from the parsed record, losing the verifier
    // list, ensemble policy, and quorum from the persisted run record.
    verifiers: z.array(z.string()).optional(),
    fallbackVerifier: z.string().optional(),
    ensemblePolicy: z.enum(["majority", "quorum", "unanimous"]).optional(),
    ensembleQuorum: z.number().optional(),
    ensembleResults: z.record(z.string(), z.unknown()).optional(),
    dispatchedActor: z.string().optional(),
    targetStep: z.number().int().positive().optional(),
    targetSteps: z.array(z.number().int().positive()).optional(),
    verdict: VerdictSchema.optional(),
    score: z.number().optional(),
    confidence: z.number().optional(),
    issues: z.array(WorkflowIssueSchema).optional(),
    attempts: z.number().int().nonnegative().optional(),
    onInvalid: WorkflowOnInvalidSchema.optional(),
    invalidAttempts: z.number().int().nonnegative().optional(),
    // M-3: on_malformed + max_malformed_retries — pre-fix schema omitted these.
    onMalformed: z.enum(["fail", "retry_verifier", "skip", "escalate"]).optional(),
    maxMalformedRetries: z.number().int().nonnegative().optional(),
    malformedAttempts: z.number().int().nonnegative().optional(),
    onFail: WorkflowOnFailSchema.optional(),
    maxRetries: z.number().int().nonnegative().optional(),
    maxInvalidRetries: z.number().int().nonnegative().optional(),
    onPassGoto: z.number().int().positive().optional(),
    onFailGoto: z.number().int().positive().optional(),
    onInvalidGoto: z.number().int().positive().optional(),
    maxJumps: z.number().int().nonnegative().optional(),
    criteria: z.string().optional(),
    // M-3: where condition — pre-fix schema omitted it. Stored as a raw
    // object (the condition shape is validated at validate-time; the record
    // reader just needs to preserve it for display/audit).
    where: z.record(z.string(), z.any()).optional(),
    // M-3: loop config — pre-fix schema omitted it.
    loop: z.object({
        maxIterations: z.number().int().positive(),
        onExhaust: z.enum(["fail", "continue"]).optional(),
    }).optional(),
    loopIterations: z.number().int().nonnegative().optional(),
    timeoutMs: z.number().optional(),
    onTimeout: WorkflowOnTimeoutSchema.optional(),
    maxTimeoutRetries: z.number().int().nonnegative().optional(),
    // M-9: retry audit fields persisted by persistRun but previously stripped
    // by Zod on read. Without these, result/audit tools lose the retry
    // configuration and consumed-attempt history that persistence records.
    fallbackMember: z.string().optional(),
    retryOn: z.unknown().optional(),
    maxTaskRetries: z.number().int().nonnegative().optional(),
    taskAttempts: z.number().int().nonnegative().optional(),
    timeoutAttempts: z.number().int().nonnegative().optional(),
    jumpCount: z.number().int().nonnegative().optional(),
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
    // humanApproval removed from per-step schema (MEDIUM: persistRun never
    // writes it here; it's a per-run field on ActiveTaskBase).
})

/**
 * Persisted workflow run: step array plus cross-step structural validation.
 * The superRefine checks enforce fanout/join/branch consistency that zod
 * object schemas alone cannot express (e.g. joinIndex bidirectional pairing,
 * branch ranges within fanout..join bounds, branch metadata matching).
 */
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
                if (step.branch !== undefined)
                    addStepIssue(index, "fanout step cannot carry branch metadata", ["branch"])
                if (step.join !== undefined)
                    addStepIssue(index, "fanout step cannot carry join metadata", ["join"])
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
                    if (
                        range.startIndex <= index
                        || range.endIndex >= fanout.joinIndex
                        || range.endIndex >= steps.length
                    ) {
                        addStepIssue(
                            index,
                            "fanout branch range must be between fanout and join",
                            ["fanout", "branchRanges", branchIndex],
                        )
                        continue
                    }
                    if (joinStep?.join?.branchTailIndices[branchIndex] !== range.endIndex) {
                        addStepIssue(
                            index,
                            "join branchTailIndices must match fanout branch range tails",
                            ["fanout", "branchRanges", branchIndex],
                        )
                    }
                    for (
                        let branchStepIndex = range.startIndex;
                        branchStepIndex <= range.endIndex;
                        branchStepIndex += 1
                    ) {
                        const branchStep = steps[branchStepIndex]
                        if (branchStep === undefined) {
                            addStepIssue(
                                index,
                                "fanout branch range points outside workflow steps",
                                ["fanout", "branchRanges", branchIndex],
                            )
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
                        if (
                            branch.fanoutIndex !== index
                            || branch.branchId !== branchId
                            || branch.branchIndex !== branchIndex
                            || branch.joinIndex !== fanout.joinIndex
                        ) {
                            addStepIssue(
                                branchStepIndex,
                                "branch metadata must match containing fanout range",
                                ["branch"],
                            )
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
                    addStepIssue(
                        index,
                        "join fanoutIndex must point to a matching fanout step",
                        ["join", "fanoutIndex"],
                    )
                    break
                }
                const fanout = fanoutStep.fanout
                if (fanout.joinPolicy !== step.join.joinPolicy) {
                    addStepIssue(index, "join policy must match fanout join policy", ["join", "joinPolicy"])
                }
                if (fanout.quorum !== step.join.quorum) {
                    addStepIssue(index, "join quorum must match fanout quorum", ["join", "quorum"])
                }
                if (fanout.branchRanges.length !== step.join.branchTailIndices.length) {
                    addStepIssue(
                        index,
                        "join branchTailIndices length must match fanout branches",
                        ["join", "branchTailIndices"],
                    )
                }
                const branchIds = new Set(fanout.branchIds)
                const survivorBranchIds = step.join.survivorBranchIds ?? []
                const erroredBranchIds = step.join.erroredBranchIds ?? []
                for (const branchId of survivorBranchIds) {
                    if (!branchIds.has(branchId))
                        addStepIssue(
                            index,
                            "join survivorBranchIds must reference known fanout branches",
                            ["join", "survivorBranchIds"],
                        )
                }
                for (const branchId of erroredBranchIds) {
                    if (!branchIds.has(branchId))
                        addStepIssue(
                            index,
                            "join erroredBranchIds must reference known fanout branches",
                            ["join", "erroredBranchIds"],
                        )
                    if (survivorBranchIds.includes(branchId))
                        addStepIssue(index, "join branch cannot be both survivor and errored", ["join"])
                }
                break
            }
            case "task":
            case "gate": {
                if (step.fanout !== undefined)
                    addStepIssue(index, "task/gate step cannot carry fanout metadata", ["fanout"])
                if (step.join !== undefined)
                    addStepIssue(index, "task/gate step cannot carry join metadata", ["join"])
                if (step.branch === undefined) break
                const fanoutStep = steps[step.branch.fanoutIndex]
                if (fanoutStep?.kind !== "fanout" || fanoutStep.fanout === undefined) {
                    addStepIssue(
                        index,
                        "branch fanoutIndex must point to a matching fanout step",
                        ["branch", "fanoutIndex"],
                    )
                    break
                }
                const range = fanoutStep.fanout.branchRanges[step.branch.branchIndex]
                const branchId = fanoutStep.fanout.branchIds[step.branch.branchIndex]
                if (
                    range === undefined
                    || branchId !== step.branch.branchId
                    || step.branch.joinIndex !== fanoutStep.fanout.joinIndex
                    || index < range.startIndex
                    || index > range.endIndex
                ) {
                    addStepIssue(index, "branch metadata must match containing fanout range", ["branch"])
                }
                break
            }
            default:
                step.kind satisfies never
        }
    }
})

// ============================================================
// Arena scoreboard
// ============================================================

/** A single candidate's arena score: numeric score, custom metrics, pass/fail flag, rationale. */
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

// ============================================================
// Exported top-level schemas (public API for runs.ts)
// ============================================================

/** Validates a persisted RunRecord (record.json) read back from disk. */
export const RunRecordSchema = z.object({
    version: z.literal(1),
    runId: z.string(),
    teamRunId: z.string(),
    teamName: z.string(),
    type: OrchestrationTypeSchema,
    mode: ParallelModeSchema.optional(),
    reason: z.string(),
    status: RunStatusSchema,
    // M-26: metric fields must be non-negative (pre-fix code used bare
    // z.number(), allowing negative tokens/messages/bytes from corrupt
    // or tampered run records).
    startedAt: z.number().nonnegative(),
    finishedAt: z.number().nonnegative(),
    tokensUsed: z.number().nonnegative(),
    tokensByMember: z.record(z.string(), z.number().nonnegative()),
    messagesSent: z.number().nonnegative(),
    currentRound: z.number().optional(),
    decisionHistory: z.array(DecisionRecordSchema).optional(),
    approvalHistory: z.array(ApprovalDecisionRecordSchema).optional(),
    consensusReached: z.boolean().optional(),
    signoffPolicy: SignoffPolicySchema.optional(),
    signoffApprovals: z.record(z.string(), z.boolean()).optional(),
    memberOutputs: z.record(z.string(), z.object({ bytes: z.number().nonnegative(), file: z.string() })),
    artifacts: z.object({
        reduce: z.string().optional(),
        signoff: z.record(z.string(), z.string()).optional(),
        // HIGH: join artifacts were written but stripped by Zod on read.
        join: z.record(z.string(), z.string()).optional(),
    }).optional(),
    tasks: z.array(z.object({
        id: z.string(),
        subject: z.string(),
        status: z.enum(["pending", "claimed", "in_progress", "completed", "deleted"]),
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
    }).superRefine((arena, ctx) => {
        // MEDIUM: reject duplicate scoreboard entries for the same member.
        if (arena.scoreboard) {
            const seen = new Set<string>()
            for (const s of arena.scoreboard.scores) {
                if (seen.has(s.member)) {
                    ctx.addIssue({ code: "custom", path: ["scoreboard"], message: `duplicate scoreboard entry for member ${s.member}` })
                }
                seen.add(s.member)
            }
        }
        if (arena.winner === undefined) return
        if (!arena.candidates.includes(arena.winner)) {
            ctx.addIssue({
                code: "custom",
                path: ["winner"],
                message: "arena winner must be one of the candidates",
            })
        }
        if (arena.survivingCandidates?.includes(arena.winner) !== true) {
            ctx.addIssue({
                code: "custom",
                path: ["winner"],
                message: "arena winner must be one of the surviving candidates",
            })
        }
        const winnerEntry = arena.scoreboard?.scores.find(score => score.member === arena.winner)
        if (winnerEntry?.passed !== true) {
            ctx.addIssue({
                code: "custom",
                path: ["winner"],
                message: "arena winner must have passed === true in the scoreboard",
            })
        }
        const winnerScore = arena.winnerMetric === "score"
            ? winnerEntry?.score
            : winnerEntry?.metrics?.[arena.winnerMetric]
        if (typeof winnerScore !== "number" || !Number.isFinite(winnerScore)) {
            ctx.addIssue({
                code: "custom",
                path: ["scoreboard"],
                message: "arena winner must have a valid scoreboard score",
            })
        }
    }).optional(),
    quorum: z.object({
        task: z.string(),
        voteKey: z.string(),
        voteOptions: z.array(z.string()).optional(),
        participants: z.array(z.string()),
        ballots: z.record(z.string(), z.object({
            vote: z.string(),
            rationale: z.string().optional(),
            status: z.enum(["valid", "invalid", "errored"]),
        })).optional(),
        erroredCount: z.number().int().nonnegative().optional(),
        nEff: z.number().int().nonnegative().optional(),
        threshold: z.number().int().nonnegative().optional(),
        winningOption: z.string().optional(),
    }).superRefine((quorum, ctx) => {
        if (quorum.winningOption !== undefined
            && quorum.voteOptions !== undefined
            && !quorum.voteOptions.includes(quorum.winningOption)) {
            ctx.addIssue({
                code: "custom",
                path: ["winningOption"],
                message: "quorum winning option must be one of the vote options",
            })
        }
    }).optional(),
})

const RunEventCommonShape = {
    timestamp: z.number().nonnegative(),
    sequence: z.number().int().nonnegative().optional(),
    member: z.string().min(1).optional(),
    stage: z.number().int().nonnegative().optional(),
    round: z.number().int().nonnegative().optional(),
    stepIndex: z.number().int().nonnegative().optional(),
    correlationId: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    bytes: z.number().nonnegative().optional(),
    detail: z.string().min(1).optional(),
}

/** Validates a single RunEvent line from the events.jsonl timeline. */
export const RunEventSchema = z.discriminatedUnion("kind", [
    z.object({ ...RunEventCommonShape, kind: z.literal("dispatched"), member: z.string().min(1) }),
    z.object({
        ...RunEventCommonShape,
        kind: z.literal("captured"),
        member: z.string().min(1),
        bytes: z.number().nonnegative(),
    }),
    z.object({
        ...RunEventCommonShape,
        kind: z.literal("retry"),
        member: z.string().min(1),
        detail: z.string().min(1),
    }),
    z.object({ ...RunEventCommonShape, kind: z.literal("errored"), member: z.string().min(1) }),
    z.object({
        ...RunEventCommonShape,
        kind: z.literal("stage_advanced"),
        stage: z.number().int().nonnegative(),
        detail: z.string().min(1),
    }),
    z.object({ ...RunEventCommonShape, kind: z.literal("round"), round: z.number().int().nonnegative() }),
    z.object({ ...RunEventCommonShape, kind: z.literal("signoff"), detail: z.string().min(1) }),
    z.object({ ...RunEventCommonShape, kind: z.literal("approval_requested"), detail: z.string().min(1) }),
    z.object({ ...RunEventCommonShape, kind: z.literal("approval_resolved"), detail: z.string().min(1) }),
    z.object({ ...RunEventCommonShape, kind: z.literal("terminated"), reason: z.string().min(1) }),
    z.object({
        ...RunEventCommonShape,
        kind: z.literal("routed"),
        member: z.string().min(1),
        detail: z.string().min(1),
    }),
    z.object({
        ...RunEventCommonShape,
        kind: z.literal("arbitrated"),
        member: z.string().min(1),
        detail: z.string().min(1),
    }),
    z.object({
        ...RunEventCommonShape,
        kind: z.literal("decomposed"),
        member: z.string().min(1),
        detail: z.string().min(1),
    }),
    z.object({
        ...RunEventCommonShape,
        kind: z.literal("aggregated"),
        member: z.string().min(1),
        detail: z.string().min(1),
    }),
    z.object({
        ...RunEventCommonShape,
        kind: z.literal("aggregation_stalled"),
        member: z.string().min(1),
        detail: z.string().min(1),
    }),
    z.object({
        ...RunEventCommonShape,
        kind: z.literal("verdict"),
        member: z.string().min(1),
        stage: z.number().int().nonnegative(),
        detail: z.string().min(1),
    }),
    z.object({ ...RunEventCommonShape, kind: z.literal("repaired"), detail: z.string().min(1) }),
]).superRefine((event, ctx) => {
    if (event.kind === "errored" && event.reason === undefined && event.detail === undefined) {
        ctx.addIssue({
            code: "custom",
            path: ["reason"],
            message: "errored event must include a reason or detail",
        })
    }
})

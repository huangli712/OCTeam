/**
 * Run record and run event type definitions — persistent per-orchestration
 * result and timeline, stored under runs/<runId>/.
 *
 * Layer 2 in the types decomposition — imports from workflow.ts (Verdict,
 * WorkflowStep-related types) and orchestration.ts (OrchestrationType,
 * ParallelMode, enums, DecisionRecord, ApprovalDecisionRecord, ArenaScoreboard).
 */

import type {
    ApprovalDecisionRecord,
    ArenaScoreboard,
    DecisionRecord,
    OrchestrationType,
    ParallelMode,
    QuorumBallot,
    SignoffPolicy,
} from "./orchestration.js"

import type { WorkflowStepBase, WorkflowGateConfig } from "./workflow.js"

/** Per-branch status within a workflow fanout. */
export type WorkflowBranchStatus = "pending" | "completed" | "skipped" | "errored"

/** Persisted snapshot of a single workflow step for run records. */
export type WorkflowRunStep = WorkflowStepBase & WorkflowGateConfig & {
    index: number                      // zero-based internal workflow step index
    step: number                       // one-based display step number
    targetStep?: number                // one-based display primary target task step for gate steps
    targetSteps?: number[]             // one-based display multi-target task steps for gate steps
    outputBytes?: number
    joinedOutputBytes?: number
    branchStatuses?: Record<string, WorkflowBranchStatus>
}

/** Run outcome: completed successfully or failed. */
export type RunStatus = "completed" | "failed"

/** Persistent per-orchestration result record stored as runs/<runId>/record.json. */
export type RunRecord = {
    version: 1
    runId: string                      // per-orchestration UUID
    teamRunId: string                  // team-constant id; correlates a team's runs
    teamName: string
    type: OrchestrationType
    mode?: ParallelMode
    reason: string                     // verbatim reason passed to deliverSummaryToLeader
    status: RunStatus                  // derived via runStatusFromReason
    startedAt: number                  // task.startedAt
    finishedAt: number                 // epoch ms at persist
    tokensUsed: number
    tokensByMember: Record<string, number>
    messagesSent: number
    currentRound?: number              // consensus / loop
    decisionHistory?: DecisionRecord[] // loop
    approvalHistory?: ApprovalDecisionRecord[] // HITL approval audit trail
    consensusReached?: boolean         // consensus
    signoffPolicy?: SignoffPolicy
    signoffApprovals?: Record<string, boolean>
    // per-member full outputs, path-referenced (NOT inlined). file is relative to
    // runs/<runId>/ (e.g. "alice.md").
    memberOutputs: Record<string, { bytes: number; file: string }>
    // delegate snapshot of the shared task list at completion
    tasks?: Array<{ id: string; subject: string; status: string; owner?: string }>
    // workflow snapshot of the step ledger at completion/failure
    workflow?: { steps: WorkflowRunStep[] }
    // arena snapshot: winner + evaluator-attested scoreboard audit trail
    arena?: {
        candidates: string[]
        survivingCandidates?: string[]
        evaluator: string
        winner?: string
        scoreDirection: "max" | "min"
        winnerMetric: string
        scoreboard?: ArenaScoreboard
    }
    // quorum snapshot: parsed ballots + tally audit trail. All tally-derived
    // fields are optional because persistRun may run on a pre-tally failure path
    // (e.g. member_error when survivors==0) where the tally never executed.
    quorum?: {
        task: string
        voteKey: string
        voteOptions?: string[]
        participants: string[]
        ballots?: Record<string, QuorumBallot>
        erroredCount?: number
        nEff?: number
        threshold?: number
        winningOption?: string
    }
}

/** Append-only run timeline event kind for events.jsonl. */
export type RunEventKind =
    | "dispatched"      // a member was prompted with a task
    | "captured"        // a member's output was captured
    | "retry"           // a sustained-retry grace window was consumed
    | "errored"         // a member was marked terminally errored
    | "stage_advanced"  // pipeline/loop moved to a new stage
    | "round"           // consensus/loop incremented the round
    | "signoff"         // a signoff review stage was triggered
    | "approval_requested" // a human approval pause was requested
    | "approval_resolved"  // a human approval request was approved/rejected
    | "terminated"      // the orchestration ended (any reason)
    | "routed"          // router selected target branch(es) (route mode)
    | "arbitrated"      // arbiter issued a binding ruling (arbitrate mode)
    | "decomposed"      // a task was split into subtasks (recurse mode)
    | "aggregated"      // the root task was finalized after all subtasks completed (recurse mode)
    | "aggregation_stalled"  // decomposer failed to claim+aggregate root after dispatch cap (recurse mode)
    | "verdict"         // a gate produced a PASS/FAIL/INVALID verdict (tollgate mode)
    | "repaired"        // team_fix_workflow performed a surgical repair op

/** A single entry in the append-only run timeline (events.jsonl). */
export type RunEvent = {
    timestamp: number                  // epoch ms (readers sort by this, not file order)
    kind: RunEventKind
    member?: string
    stage?: number                     // currentStageIndex (pipeline/loop)
    round?: number                     // currentRound (consensus/loop)
    stepIndex?: number                 // workflow step index (workflow mode)
    correlationId?: string             // links related events (e.g. a step dispatch and its capture/verdict)
    reason?: string                    // terminated / errored reason
    bytes?: number                     // captured output size
    detail?: string                    // free-form (signoff policy, "grace n/max", …)
}

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

import fs from "node:fs/promises"

import type { Team } from "../state/store.js"
import type { RunRecord, RunStatus } from "../core/types.js"
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
] as const

/** Derive run status from the verbatim termination reason (heuristic; see set above). */
export function runStatusFromReason(reason: string): RunStatus {
    return FAILED_REASON_MARKERS.some(m => reason.includes(m)) ? "failed" : "completed"
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
        // dir may not exist (e.g. delegate with no captured outputs) — that's fine
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
            const rec = JSON.parse(raw) as RunRecord
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
            records.push(JSON.parse(raw) as RunRecord)
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
        return JSON.parse(raw) as RunRecord
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
            events.push(JSON.parse(line) as RunEvent)
        } catch {
            // skip malformed line
        }
    }
    events.sort((a, b) => a.timestamp - b.timestamp)
    return events
}

/**
 * Append-only run timeline. recordEvent fires at orchestration state-
 * transition sites (dispatch / capture / retry / error / stage / round / signoff
 * / terminated) and appends one RunEvent per line to runs/<runId>/events.jsonl.
 *
 * Fire-and-forget (returns void, never awaited at call sites) so observability
 * can never add latency or backpressure to the state machine — same philosophy
 * as logEvent. A missing runId (legacy in-flight task) silently skips the event;
 * since #5 generates runId at orchestration start, that path is effectively dead
 * except for tasks persisted by an older build.
 *
 * Readers (team_progress) sort by event.timestamp rather than trusting file
 * order, because two fire-and-forget appends from different turns could in
 * principle land out of order (impossible at LLM-turn cadence, but cheap insurance).
 */

import type { Team } from "../state/store.js"
import type { RunEvent } from "../core/types.js"
import { appendJsonl } from "../state/locks.js"
import { runEventsPath } from "../state/paths.js"

/** Fire-and-forget: append one RunEvent to the run's events.jsonl timeline. */
export function recordEvent(team: Team, event: RunEvent): void {
    // Tombstone guard: skip the fire-and-forget appendJsonl when the team has
    // been deleted. appendJsonl's mkdir({recursive:true}) would otherwise
    // recreate runs/<runId>/ as an orphan directory after handleSessionDeleted
    // / team_delete's recursive fs.rm — the same directory-resurrection class, but
    // via the one write path here that is NOT awaited and does NOT re-check
    // team.deleted. The tombstone flag is set under the team mutex before
    // fs.rm runs (delete.ts:60 / handleSessionDeleted), so this read is
    // consistent with the deletion when recordEvent is called from a path
    // that holds the mutex (every call site in handlers.ts/summary.ts does).
    if (team.deleted) return
    const runId = team.activeTask?.runId
    if (!runId) return
    void appendJsonl(runEventsPath(team.directory, runId), JSON.stringify(event) + "\n").catch(() => {
        // best-effort telemetry; a write failure must never affect orchestration
    })
}

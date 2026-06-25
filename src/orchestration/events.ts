/**
 * Append-only run timeline (#5). recordEvent fires at orchestration state-
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

export function recordEvent(team: Team, event: RunEvent): void {
    const runId = team.activeTask?.runId
    if (!runId) return
    void appendJsonl(runEventsPath(team.directory, runId), JSON.stringify(event) + "\n").catch(() => {
        // best-effort telemetry; a write failure must never affect orchestration
    })
}
